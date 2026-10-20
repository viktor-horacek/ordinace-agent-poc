import Fastify from 'fastify'
import { complete, streamChat } from './model.ts';
import { z } from 'zod';
import type { PocEvent } from '@ordinace/shared';
import { chunkToEvents, toSse } from './events.ts';
import { fakeComplete, fakeModelEnabled, fakeStream } from './fakeModel.ts';
import type { ChatMessages } from '@openrouter/sdk/models';
import { todayIso } from './calendar.ts';
import { runTool, tools } from './tools.ts';

const app = Fastify({ logger: true })

app.get('/api/health', async () => ({ ok: true }))

// Krok 2: POST /api/ask, první volání modelu přes OpenRouter (klient modelu v src/model.ts).
app.post<{ Body: { prompt: string } }>('/api/ask', async (req, reply) => {
    const { prompt } = req.body;

    try {
        const { choices, usage } = await complete({
            messages: [
                {
                    role: 'system',
                    content: 'Jsi recepční Ordinace Lipová. Odpovídej česky a stručně. Ordinační hodiny jsou od 8:00 do 16:00.',
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
        });

        return { message: choices[0]?.message.content, usage };

    } catch (error) {
        console.error(error)
        reply.status(502);
        return { error: 'Nepodařilo se získat odpověď od modelu' }
    }
});

// Krok 3: POST /api/triage, structured output.
const Triage = z.object({
    typ: z.enum(['termin', 'recept', 'potvrzeni', 'dotaz', 'neznamy'])
        .describe('termin = chce objednat nebo změnit termín; recept = nový nebo obnovený recept; potvrzeni = potvrzení, zpráva, papír; dotaz = ostatní dotazy; neznamy = nejde poznat'),
    nalehave: z.boolean()
        .describe('true jen při akutních obtížích (bolest na hrudi, dušnost, vysoká horečka)'),
    shrnuti: z.string()
        .describe('Jedna věta, jen co pacient napsal. Nic nepřidávej, žádné pokyny.'),
});

app.post<{ Body: { text: string } }>('/api/triage', async (req, reply) => {
    const { text } = req.body;

    try {
        const { choices, usage } = await complete({
            messages: [
                {
                    role: 'system',
                    content: 'Roztřiď zprávu pacienta pro sestru na recepci.',
                },
                {
                    role: 'user',
                    content: text,
                },
            ],
            responseFormat: { type: 'json_schema', jsonSchema: { name: 'triage', strict: true, schema: z.toJSONSchema(Triage) } }
        });

        const content = choices[0]?.message.content;
        if (typeof content !== 'string' || !content) {
            throw new Error('No content returned from model');
        }
        const parsedContent = JSON.parse(content);
        const validatedContent = Triage.parse(parsedContent);

        return { message: validatedContent, usage };

    } catch (error) {
        console.error(error);
        reply.status(502);
        return { error: 'Nepodařilo se zpracovat triage' };
    }
});

// Krok 4: POST /api/chat, stream z modelu přeposílaný jako SSE.
// 4.3: kousky textu z modelu přeposíláme jako SSE eventy, na konci usage a done.
// 4.5: chyba uprostřed streamu jde jako event error (status 200 už odešel, jiný poslat nejde).
app.post<{ Body: { prompt?: string } | undefined }>('/api/chat', async (req, reply) => {
    // bez těla použijeme pevný dotaz, ať jde testovat curlem bez uvozovek
    const prompt = req.body?.prompt ?? 'Popiš ve třech větách, jak se objednat na odběr krve.';

    // hijack: Fastify odpověď neodešle sám, píšeme ji ručně přes reply.raw (Node http.ServerResponse)
    reply.hijack();
    reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
    });

    // jeden SSE event = řádky "pole: hodnota" a na konci prázdný řádek (\n\n);
    // JSON.stringify zajistí, že nový řádek v textu nerozbije formát (z \n se stane \\n).
    // Krok 6: posílat jde jen PocEvent, jiný tvar typecheck odmítne.
    const send = (event: PocEvent) => toSse(reply.raw, event);

    // 4.4: když klient odejde (zavře tab, Ctrl+C v curlu), zrušíme i volání modelu, ať neplatíme tokeny,
    // které nikdo nečte. Poslouchat 'close' na reply.raw, ne na req.raw: req 'close' přijde hned po přečtení
    // těla požadavku. writableEnded = už jsme odpověď sami ukončili, to není odpojení klienta.
    const abort = new AbortController();
    reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) {
            req.log.info('klient se odpojil, abort volání modelu');
            abort.abort();
        }
    });

    try {
        // FAKE_MODEL=1: pevný stream bez volání OpenRouteru (fakeModel.ts); jinak skutečný model
        const stream = fakeModelEnabled
            ? fakeStream(abort.signal)
            : await streamChat({
                messages: [
                    { role: 'system', content: 'Jsi recepční Ordinace Lipová. Odpovídej česky a stručně.' },
                    { role: 'user', content: prompt },
                ],
            }, abort.signal); // signal zruší požadavek i uprostřed streamu

        for await (const chunk of stream) {
            for (const event of chunkToEvents(chunk)) send(event);
        }
        send({ type: 'done' });
    } catch (error) {
        // zrušení po odpojení není chyba a psát už není komu
        if (abort.signal.aborted) return;
        console.error(error);
        // klientovi obecná zpráva, detail jen do logu
        send({ type: 'error', message: 'Nepodařilo se získat odpověď od modelu' });
    } finally {
        reply.raw.end();
    }
});

// Krok 8: POST /api/agent, první nástroj a jedna otočka, bez streamu (tvar zpráv je vidět celý najednou).
// volání s tools → model chce nástroj (tool_calls) → vykonáme → výsledky jako zprávy role tool → druhé volání → text.
// Žádná smyčka: když model po výsledku chce další nástroj, tady končíme (smyčka je krok 9).
app.post<{ Body: { prompt?: string } | undefined }>('/api/agent', async (req, reply) => {
    const prompt = req.body?.prompt ?? 'Máte zítra ráno volno?';
    // FAKE_MODEL=1: pravidla místo modelu (fakeModel.ts), celé kolo s nástrojem jde projet bez sítě
    const callModel = fakeModelEnabled ? fakeComplete : complete;

    // „zítra“ model sám nezná, dnešní datum mu musíme říct
    const today = `${new Date().toLocaleDateString('cs-CZ', { weekday: 'long' })} ${todayIso()}`;
    const messages: ChatMessages[] = [
        {
            role: 'system',
            content: `Jsi recepční Ordinace Lipová. Odpovídej česky a stručně. Dnes je ${today}. `
                + 'Volné termíny zjišťuj nástrojem find_free_slots, nikdy si je nevymýšlej.',
        },
        { role: 'user', content: prompt },
    ];

    try {
        const first = await callModel({ messages, tools });
        const assistant = first.choices[0]?.message;
        if (!assistant) throw new Error('Model nevrátil žádnou odpověď');
        const toolCalls = assistant.toolCalls ?? [];

        // model odpověděl rovnou textem, nástroj nepotřeboval
        if (toolCalls.length === 0) {
            return { message: assistant.content, toolCalls: [], usage: [first.usage] };
        }
        req.log.info({ toolCalls }, 'model chce nástroje');

        // do historie nejdřív zpráva asistenta s tool_calls tak, jak přišla; bez ní provider výsledek s tool_call_id odmítne
        messages.push(assistant);
        // tool_calls je pole: každé volání dostane vlastní výsledek se svým toolCallId
        const results = toolCalls.map((call) => ({ call, result: runTool(call) }));
        for (const { call, result } of results) {
            messages.push({ role: 'tool', toolCallId: call.id, content: result });
        }

        // tools posíláme i ve druhém volání: historie obsahuje tool_calls a bez definic nástrojů ji provider může odmítnout
        const second = await callModel({ messages, tools });
        return {
            message: second.choices[0]?.message.content,
            toolCalls: results.map(({ call, result }) => ({ name: call.function.name, args: call.function.arguments, result })),
            usage: [first.usage, second.usage], // dvě volání = dvakrát placené tokeny
        };
    } catch (error) {
        console.error(error);
        reply.status(502);
        return { error: 'Nepodařilo se získat odpověď od modelu' };
    }
});

await app.listen({ port: 3000 })

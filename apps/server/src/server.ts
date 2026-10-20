import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { complete, streamChat } from './model.ts';
import { z } from 'zod';
import type { PocEvent } from '@ordinace/shared';
import { chunkToEvents, toSse } from './events.ts';
import { fakeComplete, fakeModelEnabled, fakeStream } from './fakeModel.ts';
import type { ChatMessages } from '@openrouter/sdk/models';
import { todayIso } from './calendar.ts';
import { resumeAgent, runAgent, TurnLimitError, type AgentRun, type Decision } from './agent.ts';
import { claimPending, createRun, settleRun, type Run } from './runs.ts';
import { describeError } from './errors.ts';

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
        req.log.error(describeError(error), 'volání modelu selhalo');
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
        req.log.error(describeError(error), 'triage selhala');
        reply.status(502);
        return { error: 'Nepodařilo se zpracovat triage' };
    }
});

// Krok 9.5: kostra SSE odpovědi vytažená z /api/chat, ať ji sdílí i /api/agent.
// `work` jen posílá eventy přes send; hlavičky, done, chyby a odpojení klienta řeší tahle funkce.
// 4.3: na konci done. 4.5: chyba uprostřed streamu jde jako event error (status 200 už odešel, jiný poslat nejde).
async function sse(
    req: FastifyRequest,
    reply: FastifyReply,
    work: (send: (event: PocEvent) => void, signal: AbortSignal) => Promise<void>,
) {
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
        await work(send, abort.signal);
        send({ type: 'done' });
    } catch (error) {
        // zrušení po odpojení není chyba a psát už není komu
        if (abort.signal.aborted) return;
        req.log.error(describeError(error), 'stream selhal'); // ne celý error: SDK chyba nese Authorization hlavičku
        // klientovi obecná zpráva, detail jen do logu; limit tahů agenta řekneme rovnou
        send({ type: 'error', message: error instanceof TurnLimitError ? error.message : 'Nepodařilo se získat odpověď od modelu' });
    } finally {
        reply.raw.end();
    }
}

// Krok 4: POST /api/chat, stream z modelu přeposílaný jako SSE.
app.post<{ Body: { prompt?: string } | undefined }>('/api/chat', (req, reply) => {
    // bez těla použijeme pevný dotaz, ať jde testovat curlem bez uvozovek
    const prompt = req.body?.prompt ?? 'Popiš ve třech větách, jak se objednat na odběr krve.';

    return sse(req, reply, async (send, signal) => {
        // FAKE_MODEL=1: pevný stream bez volání OpenRouteru (fakeModel.ts); jinak skutečný model
        const stream = fakeModelEnabled
            ? fakeStream(signal)
            : await streamChat({
                messages: [
                    { role: 'system', content: 'Jsi recepční Ordinace Lipová. Odpovídej česky a stručně.' },
                    { role: 'user', content: prompt },
                ],
            }, signal); // signal zruší požadavek i uprostřed streamu

        for await (const chunk of stream) {
            for (const event of chunkToEvents(chunk)) send(event);
        }
    });
});

// FAKE_MODEL=1: pravidla místo modelu (fakeModel.ts), celý běh s nástroji jde projet bez sítě
const callModel = fakeModelEnabled ? fakeComplete : complete;

// Krok 8: POST /api/agent, nástroje bez streamu (tvar zpráv je vidět celý najednou).
// Krok 9: místo jedné otočky agentní smyčka (agent.ts): tahy, dokud model chce nástroje, nejvýš MAX_TAHU.
// Krok 9.5: místo JSONu SSE jako /api/chat: během běhu event tool_call za každý nástroj, na konci text a usage.
// Jednotlivé tahy se nestreamují, odpověď přijde vcelku.
// Krok 10: běh se uloží (runs.ts); když model chce zápis, místo textu přijde approval_required a běh čeká.
app.post<{ Body: { prompt?: string } | undefined }>('/api/agent', (req, reply) => {
    const prompt = req.body?.prompt ?? 'Najdi paní Dvořákovou a navrhni jí termín v úterý ráno.';
    // „zítra“ model sám nezná, dnešní datum mu musíme říct
    const today = `${new Date().toLocaleDateString('cs-CZ', { weekday: 'long' })} ${todayIso()}`;
    const messages: ChatMessages[] = [
        {
            role: 'system',
            content: `Jsi recepční Ordinace Lipová. Odpovídej česky a stručně. Dnes je ${today}. `
                + 'Volné termíny zjišťuj nástrojem find_free_slots, pacienty nástrojem get_patient, '
                + 'objednávej nástrojem book_appointment, nikdy si nic nevymýšlej.',
        },
        { role: 'user', content: prompt },
    ];
    const run = createRun(messages);

    return sse(req, reply, async (send) => {
        settle(req, run, await runAgent(callModel, messages, send), send);
    });
});

// Krok 10: rozhodnutí člověka o čekajícím zápisu. Stav se přepne hned (claimPending), až potom stream,
// takže druhé kliknutí dostane 409 ještě jako obyčejnou HTTP odpověď.
const decisions: Decision[] = ['approve', 'decline'];
for (const decision of decisions) {
    app.post<{ Params: { runId: string } }>(`/api/agent/:runId/${decision}`, (req, reply) => {
        const claim = claimPending(req.params.runId);
        if (!claim.ok) return reply.status(claim.status).send({ error: claim.error });
        const { run, pending } = claim;
        req.log.info({ runId: run.id, decision, label: pending.label }, 'rozhodnutí o zápisu');

        return sse(req, reply, async (send) => {
            settle(req, run, await resumeAgent(callModel, run.messages, pending, decision, send), send);
        });
    });
}

/** Konec jednoho kusu běhu: buď čeká zápis na schválení, nebo je hotovo a jde text. Pak usage. */
function settle(req: FastifyRequest, run: Run, result: AgentRun, send: (event: PocEvent) => void) {
    req.log.info({ runId: run.id, turns: result.turns, toolCalls: result.toolCalls.map((c) => c.name) }, 'běh agenta skončil');
    settleRun(run, result.pending);
    if (result.pending) {
        send({ type: 'approval_required', runId: run.id, callId: result.pending.call.id, label: result.pending.label });
    } else if (result.message) {
        send({ type: 'text', text: result.message });
    }
    // každý tah se platí zvlášť, klientovi pošleme součet za celý kus běhu
    send({
        type: 'usage',
        usage: {
            input: result.usage.reduce((sum, u) => sum + u.promptTokens, 0),
            output: result.usage.reduce((sum, u) => sum + u.completionTokens, 0),
        },
    });
}

await app.listen({ port: 3000 })

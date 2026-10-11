import Fastify from 'fastify'
import { client, model } from './model.ts';
import { z } from 'zod';

const app = Fastify({ logger: true })

app.get('/api/health', async () => ({ ok: true }))

// Krok 2: POST /api/ask, první volání modelu přes OpenRouter (klient modelu do src/model.ts).
app.post<{ Body: { prompt: string } }>('/api/ask', async (req, reply) => {
    const { prompt } = req.body;


    try {
        const { choices, usage } = await client.chat.completions.create({
            model: model!,
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

        return { message: choices[0].message.content, usage };

    } catch (error) {
        console.error(error)
        reply.status(502);
        return { error: 'Nepodařilo se získat odpověď od modelu', status: 502 }
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
        const { choices, usage } = await client.chat.completions.create({
            model: model!,
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
            response_format: { type: 'json_schema', json_schema: { name: 'triage', strict: true, schema: z.toJSONSchema(Triage) } }
        });


        const content = choices[0].message.content;
        if (!content) {
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
    // JSON.stringify zajistí, že nový řádek v textu nerozbije formát (z \n se stane \\n)
    const send = (event: string, data: unknown) =>
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
        const stream = await client.chat.completions.create({
            model: model!,
            stream: true,
            stream_options: { include_usage: true },
            messages: [
                { role: 'system', content: 'Jsi recepční Ordinace Lipová. Odpovídej česky a stručně.' },
                { role: 'user', content: prompt },
            ],
        });

        for await (const chunk of stream) {
            const text = chunk.choices[0]?.delta.content;
            if (text) send('text', { type: 'text', text });
            if (chunk.usage) send('usage', { type: 'usage', usage: chunk.usage });
        }
        send('done', { type: 'done' });
    } catch (error) {
        console.error(error);
        // klientovi obecná zpráva, detail jen do logu
        send('error', { type: 'error', message: 'Nepodařilo se získat odpověď od modelu' });
    } finally {
        reply.raw.end();
    }
});

await app.listen({ port: 3000 })

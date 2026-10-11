import Fastify from 'fastify'

const app = Fastify({ logger: true })

app.get('/api/health', async () => ({ ok: true }))

// Krok 2: POST /api/ask, první volání modelu přes OpenRouter (klient modelu do src/model.ts).
// Krok 3: POST /api/triage, structured output.
// Krok 4: POST /api/chat, stream z modelu přeposílaný jako SSE.

await app.listen({ port: 3000 })

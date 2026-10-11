// Jediné místo, které mluví s providerem.
// Oficiální SDK OpenRouteru: typy znají i rozšíření OpenRouteru (reasoning, reasoningDetails),
// odpovědi SDK samo validuje. Pole jsou v camelCase (responseFormat, promptTokens…).
import { OpenRouter } from '@openrouter/sdk';
import { EventStream } from '@openrouter/sdk/lib/event-streams.js';
import type { ChatRequest, ChatResult, ChatStreamChunk } from '@openrouter/sdk/models';

const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.MODEL;

if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
}
if (!model) {
    throw new Error('MODEL is not set');
}

const client = new OpenRouter({ apiKey });

// chat.send má jeden návratový typ pro obě varianty (hotová odpověď | stream), i když podle `stream`
// je jasné, která přijde. Dvě funkce níže to zúží kontrolou za běhu, takže zbytek kódu nic nepřetypovává.
type Request = Omit<ChatRequest, 'model' | 'stream'>;

/** Celá odpověď najednou (kroky 2 a 3). */
export async function complete(req: Request): Promise<ChatResult> {
    const res = await client.chat.send({ chatRequest: { ...req, model: model!, stream: false } });
    if (res instanceof EventStream) throw new Error('Čekal jsem celou odpověď, přišel stream');
    return res;
}

/** Stream chunků (krok 4); signal zruší požadavek i uprostřed streamu. */
export async function streamChat(req: Request, signal?: AbortSignal): Promise<AsyncIterable<ChatStreamChunk>> {
    const res = await client.chat.send({ chatRequest: { ...req, model: model!, stream: true } }, { signal });
    if (!(res instanceof EventStream)) throw new Error('Čekal jsem stream, přišla celá odpověď');
    return res;
}

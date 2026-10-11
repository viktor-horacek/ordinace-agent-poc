// Falešný model pro vývoj bez volání OpenRouteru (šetří denní limit free modelů).
// Zapíná se FAKE_MODEL=1 v apps/server/.env. Vrací stejné chunky jako skutečný stream
// (typ ChatStreamChunk z @openrouter/sdk), takže jimi projde i překlad v events.ts.
// Napřed přemýšlení v reasoningDetails (tak ho OpenRouter posílá ve streamu), pak text, nakonec usage.
// Je to zárodek „skriptovaného modelu“ z kroku 9: testy smyčky pak pojedou bez sítě.
import type { ChatStreamChunk, ChatStreamDelta, ChatUsage } from '@openrouter/sdk/models';

export const fakeModelEnabled = process.env.FAKE_MODEL === '1';

const reasoning = 'Pacient se ptá na ordinační hodiny. V promptu je mám, odpovím stručně a česky.';
const answer = 'Ordinace Lipová má otevřeno v pondělí až pátek od 8:00 do 16:00. O víkendu je zavřeno.';

function chunk(delta: ChatStreamDelta, usage?: ChatUsage): ChatStreamChunk {
  return {
    id: 'fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake',
    choices: usage ? [] : [{ index: 0, delta, finishReason: null }],
    ...(usage ? { usage } : {}),
  };
}

// rozseká text na kousky jako skutečný model (různá délka, klidně uprostřed slova)
function pieces(text: string): string[] {
  return text.match(/.{1,7}/gs) ?? [];
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

export async function* fakeStream(signal?: AbortSignal): AsyncGenerator<ChatStreamChunk> {
  for (const p of pieces(reasoning)) {
    await sleep(60, signal);
    yield chunk({ reasoningDetails: [{ type: 'reasoning.text', text: p }] });
  }
  for (const p of pieces(answer)) {
    await sleep(40, signal);
    yield chunk({ content: p });
  }
  yield chunk({}, {
    promptTokens: 50,
    completionTokens: 60,
    totalTokens: 110,
    completionTokensDetails: { reasoningTokens: 20 },
  });
}

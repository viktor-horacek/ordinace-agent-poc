// Falešný model pro vývoj bez volání OpenRouteru (šetří denní limit free modelů).
// Zapíná se FAKE_MODEL=1 v apps/server/.env. Vrací stejné chunky jako skutečný stream
// (tvar ChatCompletionChunk), takže jimi projde i překlad v events.ts.
// Napřed přemýšlení v delta.reasoning (tak ho posílá OpenRouter), pak text, nakonec usage.
// Je to zárodek „skriptovaného modelu“ z kroku 9: testy smyčky pak pojedou bez sítě.
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';

export const fakeModelEnabled = process.env.FAKE_MODEL === '1';

// OpenRouter přidává do delta pole reasoning, typy openai SDK o něm nevědí
type OrDelta = ChatCompletionChunk.Choice.Delta & { reasoning?: string };

const reasoning = 'Pacient se ptá na ordinační hodiny. V promptu je mám, odpovím stručně a česky.';
const answer = 'Ordinace Lipová má otevřeno v pondělí až pátek od 8:00 do 16:00. O víkendu je zavřeno.';

function chunk(delta: OrDelta, usage?: ChatCompletionChunk['usage']): ChatCompletionChunk {
  return {
    id: 'fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake',
    choices: usage ? [] : [{ index: 0, delta, finish_reason: null }],
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

export async function* fakeStream(signal?: AbortSignal): AsyncGenerator<ChatCompletionChunk> {
  for (const p of pieces(reasoning)) {
    await sleep(60, signal);
    yield chunk({ reasoning: p });
  }
  for (const p of pieces(answer)) {
    await sleep(40, signal);
    yield chunk({ content: p });
  }
  yield chunk({}, {
    prompt_tokens: 50,
    completion_tokens: 60,
    total_tokens: 110,
    completion_tokens_details: { reasoning_tokens: 20 },
  });
}

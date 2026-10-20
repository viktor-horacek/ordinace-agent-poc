// Falešný model pro vývoj bez volání OpenRouteru (šetří denní limit free modelů).
// Zapíná se FAKE_MODEL=1 v apps/server/.env. Vrací stejné chunky jako skutečný stream
// (typ ChatStreamChunk z @openrouter/sdk), takže jimi projde i překlad v events.ts.
// Napřed přemýšlení v reasoningDetails (tak ho OpenRouter posílá ve streamu), pak text, nakonec usage.
// Je to zárodek „skriptovaného modelu“ z kroku 9: testy smyčky pak pojedou bez sítě.
import type {
  ChatAssistantMessage, ChatFinishReasonEnum, ChatRequest, ChatResult, ChatStreamChunk, ChatStreamDelta, ChatUsage,
} from '@openrouter/sdk/models';
import { addDays, todayIso } from './calendar.ts';

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

// Krok 8: celá odpověď najednou (jako complete() v model.ts) pro /api/agent, i s voláním nástroje.
// Pravidla místo modelu: ptá se na termín → chci find_free_slots; přišel výsledek nástroje → odpověď z něj;
// jinak obyčejný text. Datum bere z dotazu (YYYY-MM-DD), jinak zítřek, takže jde vyzkoušet i neplatné datum
// („Máte volno 2026-13-45?“) nebo datum mimo kalendář.
export async function fakeComplete(req: Pick<ChatRequest, 'messages'>): Promise<ChatResult> {
  const last = req.messages.at(-1);
  const text = typeof last?.content === 'string' ? last.content : '';

  // druhé volání: poslední zpráva je výsledek nástroje
  if (last?.role === 'tool') {
    return result({ role: 'assistant', content: answerFromTool(text) }, 'stop');
  }

  // první volání: dotaz na termín → místo textu tool_calls, content je null
  if (/termín|volno/i.test(text)) {
    const date = text.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? addDays(todayIso(), 1);
    return result({
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'call_fake_1', type: 'function', function: { name: 'find_free_slots', arguments: JSON.stringify({ date }) } }],
    }, 'tool_calls');
  }

  return result({ role: 'assistant', content: 'Na to vám nejlépe odpoví sestra, zavolejte prosím v ordinačních hodinách.' }, 'stop');
}

// výsledek nástroje je JSON pole časů, nebo text chyby z runTool
function answerFromTool(content: string): string {
  try {
    const slots: string[] = JSON.parse(content);
    if (slots.length === 0) return 'Ten den bohužel nemáme volný termín.';
    return `Volné termíny: ${slots.slice(0, 3).join(', ')}. Který vám vyhovuje?`;
  } catch {
    return `Volné termíny teď nezjistím (${content}).`;
  }
}

function result(message: ChatAssistantMessage, finishReason: ChatFinishReasonEnum): ChatResult {
  return {
    id: 'fake',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'fake',
    systemFingerprint: null,
    choices: [{ index: 0, message, finishReason }],
    usage: { promptTokens: 120, completionTokens: 20, totalTokens: 140 },
  };
}

// Falešný model pro vývoj bez volání OpenRouteru (šetří denní limit free modelů).
// Zapíná se FAKE_MODEL=1 v apps/server/.env. Vrací stejné chunky jako skutečný stream
// (typ ChatStreamChunk z @openrouter/sdk), takže jimi projde i překlad v events.ts.
// Napřed přemýšlení v reasoningDetails (tak ho OpenRouter posílá ve streamu), pak text, nakonec usage.
// Je to zárodek „skriptovaného modelu“ z kroku 9: testy smyčky pak pojedou bez sítě.
import type {
  ChatAssistantMessage, ChatFinishReasonEnum, ChatRequest, ChatResult, ChatStreamChunk, ChatStreamDelta, ChatUsage,
} from '@openrouter/sdk/models';
import { addDays, nextWeekday, todayIso } from './calendar.ts';

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
// Krok 9: zmínka „paní/pan X“ → napřed get_patient, po jeho výsledku v dalším tahu find_free_slots (dva tahy s nástrojem).
export async function fakeComplete(req: Pick<ChatRequest, 'messages'>): Promise<ChatResult> {
  const last = req.messages.at(-1);
  const text = typeof last?.content === 'string' ? last.content : '';
  // dotaz pacienta: poslední zpráva user (ve druhém a dalším tahu je na konci výsledek nástroje)
  const user = req.messages.findLast((m) => m.role === 'user');
  const question = typeof user?.content === 'string' ? user.content : '';

  // po get_patient chceme termíny; podle id volání poznáme, na který nástroj výsledek odpovídá
  if (last?.role === 'tool' && last.toolCallId === PATIENT_CALL_ID) {
    return toolCall(SLOTS_CALL_ID, 'find_free_slots', { date: dateFrom(question) });
  }
  // výsledek find_free_slots: odpověď z něj
  if (last?.role === 'tool') {
    return result({ role: 'assistant', content: answerFromTool(text) }, 'stop');
  }

  // „paní Dvořákovou“ → { name: 'Dvořáková' }: 4. pád na 1. pád jen pro koncovku -ovou, na fake to stačí
  const name = text.match(/(?:paní|pan|pana)\s+(\p{Lu}\p{Ll}+)/u)?.[1];
  if (name) {
    return toolCall(PATIENT_CALL_ID, 'get_patient', { name: name.replace(/ovou$/, 'ová') });
  }

  // první tah: dotaz na termín → místo textu tool_calls, content je null
  if (/termín|volno/i.test(text)) {
    return toolCall(SLOTS_CALL_ID, 'find_free_slots', { date: dateFrom(text) });
  }

  return result({ role: 'assistant', content: 'Na to vám nejlépe odpoví sestra, zavolejte prosím v ordinačních hodinách.' }, 'stop');
}

const PATIENT_CALL_ID = 'call_fake_patient';
const SLOTS_CALL_ID = 'call_fake_slots';

// datum z dotazu: YYYY-MM-DD, „úterý“ = nejbližší úterý, jinak zítřek
function dateFrom(text: string): string {
  const today = todayIso();
  return text.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? (/úterý/i.test(text) ? nextWeekday(today, 2) : addDays(today, 1));
}

function toolCall(id: string, name: string, args: object): ChatResult {
  return result({
    role: 'assistant',
    content: null,
    toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  }, 'tool_calls');
}

// výsledek nástroje je JSON pole časů, nebo text chyby z tools.ts
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

// Krok 9.3 a 9.4: testy smyčky bez sítě. Spouští je `npm test` (node --test najde *.test.ts sám).
// Skriptovaný model vrací předem dané odpovědi, jednu na každý tah, a zapisuje si, co dostal.
// Nástroje jsou skutečné (tools.ts nad smyšlenými daty), podvržený je jen model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatAssistantMessage, ChatMessages, ChatResult, ChatToolCall } from '@openrouter/sdk/models';
import { MAX_TAHU, runAgent, TurnLimitError, type CallModel } from './agent.ts';
import { nextWeekday, todayIso } from './calendar.ts';
import { fakeComplete } from './fakeModel.ts';
import { prepareTool } from './tools.ts';
import type { PocEvent } from '@ordinace/shared';

const tuesday = nextWeekday(todayIso(), 2);

// tvar odpovědi, jak ji vrací complete(); z testu potřebujeme jen zprávu asistenta
function reply(message: ChatAssistantMessage): ChatResult {
  return {
    id: 'test', object: 'chat.completion', created: 0, model: 'test', systemFingerprint: null,
    choices: [{ index: 0, message, finishReason: message.toolCalls ? 'tool_calls' : 'stop' }],
  };
}
const text = (content: string) => reply({ role: 'assistant', content });
const wantsTool = (id: string, name: string, args: object) => reply({
  role: 'assistant',
  content: null,
  toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

/** Model, který odpoví script[0], script[1]… a pamatuje si poslední zprávu z každého tahu. */
function scriptedModel(script: ChatResult[]) {
  const seen: ChatMessages[] = [];
  const callModel: CallModel = async (req) => {
    const next = script[seen.length];
    if (!next) throw new Error('Skript došel: smyčka volala model víckrát, než měla');
    seen.push(req.messages.at(-1)!); // messages je jedno pole, které smyčka doplňuje; kopie jen posledního prvku
    return next;
  };
  return { callModel, seen };
}

const question = (): ChatMessages[] => [
  { role: 'user', content: 'Najdi paní Dvořákovou a navrhni jí termín v úterý ráno' },
];

test('dva nástroje za sebou, pak text', async () => {
  const { callModel, seen } = scriptedModel([
    wantsTool('1', 'get_patient', { name: 'Dvořáková' }),
    wantsTool('2', 'find_free_slots', { date: tuesday }),
    text('Paní Dvořákové navrhuji úterý 9:40.'),
  ]);

  const run = await runAgent(callModel, question());

  assert.equal(run.message, 'Paní Dvořákové navrhuji úterý 9:40.');
  assert.equal(run.turns, 3);
  assert.deepEqual(run.toolCalls.map((c) => c.name), ['get_patient', 'find_free_slots']);
  // výsledek nástroje se v dalším tahu vrátil modelu jako zpráva role tool se správným id
  assert.deepEqual(seen[1], { role: 'tool', toolCallId: '1', content: run.toolCalls[0]!.result });
  assert.match(run.toolCalls[0]!.result, /Jana Dvořáková/);
  assert.match(run.toolCalls[1]!.result, /"09:40"/); // úterý ráno je obsazené do 9:20
});

test('chyba nástroje jde modelu jako výsledek, smyčka běží dál', async () => {
  const { callModel, seen } = scriptedModel([
    wantsTool('1', 'neexistuje', {}),
    text('Termíny teď nezjistím.'),
  ]);

  const run = await runAgent(callModel, question());

  assert.equal(run.message, 'Termíny teď nezjistím.');
  assert.match(String(seen[1]?.content), /neznámý nástroj/);
});

test('neznámý nástroj nebo neplatné argumenty: obecný popisek', () => {
  const call = (name: string, args: string): ChatToolCall => ({ id: '1', type: 'function', function: { name, arguments: args } });

  assert.equal(prepareTool(call('neexistuje', '{}')).label, 'volám nástroj neexistuje…');
  assert.equal(prepareTool(call('find_free_slots', '{"date":"zítra"}')).label, 'volám nástroj find_free_slots…');
  assert.equal(prepareTool(call('get_patient', 'není JSON')).label, 'volám nástroj get_patient…');
});

test('model, který chce nástroj pořád, skončí po MAX_TAHU chybou', async () => {
  const forever = Array.from({ length: MAX_TAHU + 1 }, (_, i) => wantsTool(String(i), 'get_patient', { name: 'Nováková' }));
  const { callModel, seen } = scriptedModel(forever);
  const messages = question();

  await assert.rejects(runAgent(callModel, messages), TurnLimitError);

  assert.equal(seen.length, MAX_TAHU); // model zavolán přesně MAX_TAHU krát, ne víc
  // v posledním tahu se nástroj už nevykonal: výsledků je o jeden méně než tahů
  assert.equal(messages.filter((m) => m.role === 'tool').length, MAX_TAHU - 1);
});

test('FAKE_MODEL: scénář s pacientem projde přes fakeComplete', async () => {
  const events: PocEvent[] = [];
  const run = await runAgent(fakeComplete, question(), (event) => events.push(event));

  // Krok 9.5: každé volání nástroje se ohlásí eventem tool_call s popiskem ze serveru, v pořadí volání
  const [, month, day] = tuesday.split('-');
  assert.deepEqual(events, [
    { type: 'tool_call', name: 'get_patient', label: 'hledám pacienta Dvořáková…' },
    { type: 'tool_call', name: 'find_free_slots', label: `hledám volné termíny ${Number(day)}. ${Number(month)}.…` },
  ]);

  assert.deepEqual(run.toolCalls.map((c) => c.name), ['get_patient', 'find_free_slots']);
  assert.equal(JSON.parse(run.toolCalls[1]!.args).date, tuesday);
  assert.match(run.message ?? '', /09:40/);
});

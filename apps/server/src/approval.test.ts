// Krok 10: zápis se schválením člověkem, bez sítě. Skriptovaný model jako v agent.test.ts,
// nástroje i kalendář skutečné: že se zápis (ne)vykonal, poznáme podle volných slotů v kalendáři.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessages, ChatResult } from '@openrouter/sdk/models';
import type { PocEvent } from '@ordinace/shared';
import { DECLINED, resumeAgent, runAgent, type CallModel } from './agent.ts';
import { findFreeSlots, nextWeekday, todayIso } from './calendar.ts';
import { fakeComplete } from './fakeModel.ts';
import { claimPending, createRun, settleRun } from './runs.ts';

// středa pro skriptované testy, úterý patří scénáři s fakeComplete (ať si zápisy nepřekážejí)
const wednesday = nextWeekday(todayIso(), 3);
const tuesday = nextWeekday(todayIso(), 2);

const text = (content: string): ChatResult => ({
  id: 'test', object: 'chat.completion', created: 0, model: 'test', systemFingerprint: null,
  choices: [{ index: 0, message: { role: 'assistant', content }, finishReason: 'stop' }],
});
const book = (id: string, time: string): ChatResult => ({
  id: 'test', object: 'chat.completion', created: 0, model: 'test', systemFingerprint: null,
  choices: [{
    index: 0,
    finishReason: 'tool_calls',
    message: {
      role: 'assistant',
      content: null,
      toolCalls: [{
        id, type: 'function',
        function: { name: 'book_appointment', arguments: JSON.stringify({ patientId: 'p1', date: wednesday, time }) },
      }],
    },
  }],
});

/** Model, který odpoví script[0], script[1]… a pamatuje si poslední zprávu z každého tahu. */
function scriptedModel(script: ChatResult[]) {
  const seen: ChatMessages[] = [];
  const callModel: CallModel = async (req) => {
    const next = script[seen.length];
    if (!next) throw new Error('Skript došel');
    seen.push(req.messages.at(-1)!);
    return next;
  };
  return { callModel, seen };
}

const question = (content: string): ChatMessages[] => [{ role: 'user', content }];

test('zápis se bez schválení nespustí, běh skončí s čekajícím voláním', async () => {
  const { callModel, seen } = scriptedModel([book('1', '09:00')]);
  const messages = question('Objednej paní Dvořákovou na středu v 9:00');
  const events: PocEvent[] = [];

  const run = await runAgent(callModel, messages, (e) => events.push(e));

  assert.equal(run.message, null);
  assert.equal(run.pending?.call.id, '1');
  assert.match(run.pending?.label ?? '', /^objednat Jana Dvořáková na .* v 9:00$/);
  assert.equal(seen.length, 1); // model se po zápisu už nevolal
  assert.equal(messages.filter((m) => m.role === 'tool').length, 0); // výsledek zápisu zatím žádný
  assert.deepEqual(events, []); // žádný tool_call: nic se nespustilo
  assert.ok(findFreeSlots(wednesday).includes('09:00'));
});

test('schválení zápis vykoná a výsledek jde modelu', async () => {
  const { callModel, seen } = scriptedModel([book('1', '09:00'), text('Objednáno na 9:00.')]);
  const messages = question('Objednej paní Dvořákovou na středu v 9:00');
  const first = await runAgent(callModel, messages);

  const run = await resumeAgent(callModel, messages, first.pending!, 'approve');

  assert.equal(run.message, 'Objednáno na 9:00.');
  assert.equal(seen[1]?.role, 'tool');
  assert.match(String(seen[1]?.content), /"booked":true/);
  assert.ok(!findFreeSlots(wednesday).includes('09:00'));
});

test('zamítnutí jde modelu jako výsledek nástroje, nic se nezapíše', async () => {
  const { callModel, seen } = scriptedModel([book('7', '09:20'), text('Nabízím 9:40.')]);
  const messages = question('Objednej paní Dvořákovou na středu v 9:20');
  const first = await runAgent(callModel, messages);

  const run = await resumeAgent(callModel, messages, first.pending!, 'decline');

  assert.deepEqual(seen[1], { role: 'tool', toolCallId: '7', content: DECLINED });
  assert.equal(run.message, 'Nabízím 9:40.');
  assert.ok(findFreeSlots(wednesday).includes('09:20'));
});

test('rozhodnout jde jen jednou: druhé schválení je 409, neznámý běh 404', () => {
  const run = createRun(question('Objednej'));
  assert.deepEqual(claimPending(run.id), { ok: false, status: 409, error: 'Běh nečeká na schválení (stav running)' });

  const pending = { call: book('1', '09:00').choices[0]!.message.toolCalls![0]!, label: 'objednat' };
  settleRun(run, pending);

  const first = claimPending(run.id);
  const second = claimPending(run.id);
  assert.equal(first.ok, true);
  assert.equal(second.ok ? 0 : second.status, 409);
  assert.equal(run.status, 'running');

  const unknown = claimPending('neexistuje');
  assert.equal(unknown.ok ? 0 : unknown.status, 404);
});

test('FAKE_MODEL: objednání čeká na schválení, po zamítnutí jiné časy, po schválení potvrzení', async () => {
  const prompt = 'Objednej paní Dvořákovou na úterý ráno';

  const declined = question(prompt);
  const first = await runAgent(fakeComplete, declined);
  assert.deepEqual(first.toolCalls.map((c) => c.name), ['get_patient', 'find_free_slots']);
  assert.equal(first.pending?.call.function.name, 'book_appointment');
  assert.deepEqual(JSON.parse(first.pending!.call.function.arguments), { patientId: 'p1', date: tuesday, time: '09:40' });
  const afterDecline = await resumeAgent(fakeComplete, declined, first.pending!, 'decline');
  assert.match(afterDecline.message ?? '', /10:00, 10:20/);
  assert.ok(findFreeSlots(tuesday).includes('09:40'));

  const approved = question(prompt);
  const second = await runAgent(fakeComplete, approved);
  const afterApprove = await resumeAgent(fakeComplete, approved, second.pending!, 'approve');
  assert.match(afterApprove.message ?? '', /^Hotovo, Jana Dvořáková je objednaná .* v 09:40\.$/);
  assert.ok(!findFreeSlots(tuesday).includes('09:40'));
});

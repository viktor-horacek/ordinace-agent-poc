// Krok 10: běhy agenta v paměti procesu. Schválení přijde novým HTTP požadavkem, takže běh (historie zpráv
// a čekající zápis) musí přežít mezi požadavky. Bez persistence: restart serveru běhy smaže, hotové se nemažou.
import { randomUUID } from 'node:crypto';
import type { ChatMessages } from '@openrouter/sdk/models';
import type { PendingCall } from './agent.ts';

export type RunStatus = 'running' | 'awaiting_approval' | 'done';

export type Run = {
    id: string;
    messages: ChatMessages[];
    status: RunStatus;
    pending: PendingCall | null;
};

const runs = new Map<string, Run>();

export function createRun(messages: ChatMessages[]): Run {
    const run: Run = { id: randomUUID(), messages, status: 'running', pending: null };
    runs.set(run.id, run);
    return run;
}

/** Konec kusu běhu ve smyčce: s čekajícím zápisem stojí na schválení, bez něj je hotový. */
export function settleRun(run: Run, pending: PendingCall | null): void {
    run.status = pending ? 'awaiting_approval' : 'done';
    run.pending = pending;
}

/**
 * Přechod awaiting_approval → running pro approve i decline. Jiný stav = 409 (dvojklik, rozhodnuto už dřív).
 * Je synchronní, bez await mezi kontrolou a zápisem stavu: Node obslouží dva rychlé požadavky postupně,
 * takže projde jen první a zápis se nevykoná dvakrát.
 */
export function claimPending(id: string):
    | { ok: true; run: Run; pending: PendingCall }
    | { ok: false; status: 404 | 409; error: string } {
    const run = runs.get(id);
    if (!run) return { ok: false, status: 404, error: 'Běh neexistuje' };
    if (run.status !== 'awaiting_approval' || !run.pending) {
        return { ok: false, status: 409, error: `Běh nečeká na schválení (stav ${run.status})` };
    }
    const pending = run.pending;
    run.status = 'running';
    run.pending = null;
    return { ok: true, run, pending };
}

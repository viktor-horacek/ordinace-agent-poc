// Krok 9: agentní smyčka s limitem tahů.
// Tah = jedno volání modelu. Běh = všechny tahy pro jednu zprávu pacienta.
// Volej model; když chce nástroje, vykonej je, přidej výsledky a volej znovu; když odpoví textem, konec.
// Model přichází parametrem (callModel), ne importem z model.ts: server dá complete() nebo fakeComplete(),
// test skriptovaný model, a smyčka jde otestovat bez sítě.
// Krok 9.5: volitelný onEvent hlásí průběh (volání nástrojů) ven, server ho posílá jako SSE do UI.
// Krok 10: nástroj s effect 'write' smyčka nespustí. Běh skončí s `pending` a pokračuje až resumeAgent
// po rozhodnutí člověka. Hranici drží kód, ne věta v promptu.
import type { ChatMessages, ChatRequest, ChatResult, ChatToolCall, ChatUsage } from '@openrouter/sdk/models';
import type { PocEvent } from '@ordinace/shared';
import { prepareTool, tools } from './tools.ts';

/** Pojistka proti modelu, který se zacyklí a pálí tokeny (rozhodnutí 2: 12 tahů). */
export const MAX_TAHU = 12;

export type CallModel = (req: Pick<ChatRequest, 'messages' | 'tools'>) => Promise<ChatResult>;

/** Zápis, který čeká na člověka: volání od modelu (z něj se po schválení znovu připraví) a otázka pro UI. */
export type PendingCall = { call: ChatToolCall; label: string };

export type AgentRun = {
    message: string | null;
    pending: PendingCall | null; // běh stojí na schválení zápisu; message je pak null
    toolCalls: { name: string; args: string; result: string }[];
    usage: ChatUsage[]; // jedno usage za každý tah: každý tah se platí zvlášť
    turns: number;
};

/** Běh skončil limitem tahů, ne odpovědí. Vlastní třída, ať ho server pozná od ostatních chyb. */
export class TurnLimitError extends Error {
    constructor() {
        super(`Agent nedošel k odpovědi ani po ${MAX_TAHU} tazích`);
    }
}

/**
 * Jeden běh agenta. Historii doplňuje přímo do `messages` (zprávy asistenta a výsledky nástrojů).
 * Chyba nástroje běh neukončí: prepareTool ji vrátí jako text a model na ni v dalším tahu zareaguje.
 */
export async function runAgent(
    callModel: CallModel,
    messages: ChatMessages[],
    onEvent: (event: PocEvent) => void = () => {}, // test ho vynechá, server posílá eventy klientovi
): Promise<AgentRun> {
    const run: AgentRun = { message: null, pending: null, toolCalls: [], usage: [], turns: 0 };

    for (let turn = 1; turn <= MAX_TAHU; turn++) {
        run.turns = turn;
        // tools posíláme v každém tahu: historie obsahuje tool_calls a bez definic ji provider může odmítnout
        const res = await callModel({ messages, tools });
        if (res.usage) run.usage.push(res.usage);
        const assistant = res.choices[0]?.message;
        if (!assistant) throw new Error('Model nevrátil žádnou odpověď');
        messages.push(assistant);
        // přemýšlení přijde až s celou odpovědí tahu, ne po kouscích (smyčka nestreamuje)
        if (assistant.reasoning) onEvent({ type: 'thinking', text: assistant.reasoning });

        const calls = assistant.toolCalls ?? [];
        // model odpověděl textem: běh končí
        if (calls.length === 0) {
            run.message = typeof assistant.content === 'string' ? assistant.content : null;
            return run;
        }

        // limit kontrolujeme PŘED vykonáním: v posledním tahu by výsledky nástrojů už nikdo nepřečetl
        if (turn === MAX_TAHU) break;

        for (const call of calls) {
            // argumenty se parsují jednou: z toho popisek pro UI i vykonání (nebo chyba pro model)
            const prepared = prepareTool(call);
            let result: string;
            if (prepared.ok && prepared.effect === 'write') {
                // zápis se nespustí: počká na člověka. Výsledek pro model přidá až resumeAgent.
                if (!run.pending) {
                    run.pending = { call, label: prepared.label };
                    continue;
                }
                // druhý zápis ve stejném tahu odmítneme, schvaluje se vždy jeden
                result = 'Chyba: najednou jde schválit jen jeden zápis, tenhle pošli znovu potom';
            } else {
                onEvent({ type: 'tool_call', name: call.function.name, label: prepared.label });
                result = prepared.ok ? prepared.run() : prepared.error;
            }
            messages.push({ role: 'tool', toolCallId: call.id, content: result });
            run.toolCalls.push({ name: call.function.name, args: call.function.arguments, result });
        }
        // čtecí nástroje z tohoto tahu proběhly, zápis čeká: běh končí bez dalšího volání modelu
        if (run.pending) return run;
    }
    throw new TurnLimitError();
}

export type Decision = 'approve' | 'decline';

/** Text pro model po zamítnutí; jde mu jako výsledek nástroje, takže na něj zareaguje jako na každý jiný. */
export const DECLINED = 'Uživatel zápis odmítl. Nic se nezapsalo, nabídni jiný termín.';

/**
 * Pokračování běhu po rozhodnutí člověka: schválený zápis se teď vykoná, zamítnutý ne.
 * Výsledek jde modelu jako zpráva `tool` k čekajícímu volání a smyčka běží dál (limit tahů počítá znovu,
 * schválení je nový požadavek člověka).
 */
export async function resumeAgent(
    callModel: CallModel,
    messages: ChatMessages[],
    pending: PendingCall,
    decision: Decision,
    onEvent: (event: PocEvent) => void = () => {},
): Promise<AgentRun> {
    let result = DECLINED;
    if (decision === 'approve') {
        // argumenty se ověří znovu ze stejného volání; neplatné by se do pending vůbec nedostaly
        const prepared = prepareTool(pending.call);
        result = prepared.ok ? prepared.run() : prepared.error;
    }
    messages.push({ role: 'tool', toolCallId: pending.call.id, content: result });
    return runAgent(callModel, messages, onEvent);
}

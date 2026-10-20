// Krok 9: agentní smyčka s limitem tahů.
// Tah = jedno volání modelu. Běh = všechny tahy pro jednu zprávu pacienta.
// Volej model; když chce nástroje, vykonej je, přidej výsledky a volej znovu; když odpoví textem, konec.
// Model přichází parametrem (callModel), ne importem z model.ts: server dá complete() nebo fakeComplete(),
// test skriptovaný model, a smyčka jde otestovat bez sítě.
import type { ChatMessages, ChatRequest, ChatResult, ChatUsage } from '@openrouter/sdk/models';
import { runTool, tools } from './tools.ts';

/** Pojistka proti modelu, který se zacyklí a pálí tokeny (rozhodnutí 2: 12 tahů). */
export const MAX_TAHU = 12;

export type CallModel = (req: Pick<ChatRequest, 'messages' | 'tools'>) => Promise<ChatResult>;

export type AgentRun = {
    message: string | null;
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
 * Chyba nástroje běh neukončí: runTool ji vrátí jako text a model na ni v dalším tahu zareaguje.
 */
export async function runAgent(callModel: CallModel, messages: ChatMessages[]): Promise<AgentRun> {
    const run: AgentRun = { message: null, toolCalls: [], usage: [], turns: 0 };

    for (let turn = 1; turn <= MAX_TAHU; turn++) {
        run.turns = turn;
        // tools posíláme v každém tahu: historie obsahuje tool_calls a bez definic ji provider může odmítnout
        const res = await callModel({ messages, tools });
        if (res.usage) run.usage.push(res.usage);
        const assistant = res.choices[0]?.message;
        if (!assistant) throw new Error('Model nevrátil žádnou odpověď');
        messages.push(assistant);

        const calls = assistant.toolCalls ?? [];
        // model odpověděl textem: běh končí
        if (calls.length === 0) {
            run.message = typeof assistant.content === 'string' ? assistant.content : null;
            return run;
        }

        // limit kontrolujeme PŘED vykonáním: v posledním tahu by výsledky nástrojů už nikdo nepřečetl
        if (turn === MAX_TAHU) break;

        for (const call of calls) {
            const result = runTool(call);
            messages.push({ role: 'tool', toolCallId: call.id, content: result });
            run.toolCalls.push({ name: call.function.name, args: call.function.arguments, result });
        }
    }
    throw new TurnLimitError();
}

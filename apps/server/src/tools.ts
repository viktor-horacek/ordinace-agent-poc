// Krok 8: nástroje, které smí model použít, a jejich vykonání.
// Model nic nespouští. Vrátí jen žádost „zavolej find_free_slots s { date }“ a o tom,
// co se opravdu vykoná, rozhoduje tenhle soubor.
import type { ChatFunctionTool, ChatToolCall } from '@openrouter/sdk/models';
import { z } from 'zod';
import { findFreeSlots } from './calendar.ts';

// argumenty jako zod schéma: z něj JSON Schema pro model a stejným schématem ověříme, co model pošle
const FindFreeSlotsArgs = z.object({
    date: z.iso.date().describe('Den ve formátu YYYY-MM-DD'),
});

// z.toJSONSchema přidá klíč $schema; do definice nástroje nepatří, tak ho vynecháme
const { $schema, ...findFreeSlotsParams } = z.toJSONSchema(FindFreeSlotsArgs);

/** Definice nástrojů pro model. Popis čte model a podle něj se rozhoduje, tak je psaný pro něj. */
export const tools: ChatFunctionTool[] = [{
    type: 'function',
    function: {
        name: 'find_free_slots',
        description: 'Volné termíny ordinace pro jeden den (začátky slotů po 20 minutách, 8:00–16:00). '
            + 'Použij, když se pacient ptá na volný termín. Datum ve formátu YYYY-MM-DD, kalendář sahá 14 dní od dneška. '
            + 'Prázdné pole znamená, že ten den není volno (o víkendu je zavřeno).',
        parameters: findFreeSlotsParams,
    },
}];

/**
 * Vykoná jedno volání nástroje a vrátí výsledek jako text pro zprávu role `tool`.
 * Nikdy nevyhazuje: neznámý nástroj, špatné argumenty i výjimka z nástroje jdou modelu jako text chyby,
 * model se pak může opravit nebo pacientovi říct, že termíny teď nezjistí.
 */
export function runTool(call: ChatToolCall): string {
    try {
        switch (call.function.name) {
            case 'find_free_slots': {
                // arguments je řetězec s JSONem, ne objekt; model může poslat cokoli, proto parse + zod
                const args = FindFreeSlotsArgs.safeParse(JSON.parse(call.function.arguments));
                if (!args.success) return 'Chyba: neplatné datum, očekávám { "date": "YYYY-MM-DD" }';
                // content zprávy je řetězec, proto JSON.stringify
                return JSON.stringify(findFreeSlots(args.data.date));
            }
            default:
                return `Chyba: neznámý nástroj ${call.function.name}`;
        }
    } catch (error) {
        // nevalidní JSON v arguments nebo výjimka z findFreeSlots (např. datum mimo kalendář)
        return `Chyba: ${error instanceof Error ? error.message : String(error)}`;
    }
}

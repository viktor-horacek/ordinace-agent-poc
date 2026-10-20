// Krok 8: nástroje, které smí model použít, a jejich vykonání.
// Model nic nespouští. Vrátí jen žádost „zavolej find_free_slots s { date }“ a o tom,
// co se opravdu vykoná, rozhoduje tenhle soubor.
// Krok 9.5: nástroj je jedna položka registru (popis pro model, schéma, popisek pro člověka, vykonání).
// Nový nástroj = změna jen tady; web zobrazí hotový popisek ze serveru.
// Krok 10: nástroj nese effect. 'write' něco mění a smyčka ho bez schválení člověkem nespustí (agent.ts).
import type { ChatFunctionTool, ChatToolCall } from '@openrouter/sdk/models';
import { z } from 'zod';
import { bookAppointment, findFreeSlots } from './calendar.ts';
import { findPatients, getPatient } from './patients.ts';

/** read = jen čte, smyčka ho spustí sama; write = mění data, čeká na schválení člověkem. */
export type ToolEffect = 'read' | 'write';

type ToolDef<S extends z.ZodType> = {
    name: string;
    effect: ToolEffect;
    /** Čte model a podle něj se rozhoduje, tak je psaný pro něj. */
    description: string;
    /** Z něj JSON Schema pro model a stejným schématem ověříme, co model pošle. */
    args: S;
    /** Chyba pro model, když argumenty neprojdou schématem. */
    invalidArgs: string;
    /** Řádek do chatu, co agent dělá; dostane jen ověřené argumenty. */
    label: (args: z.infer<S>) => string;
    /** Výsledek pro model, do zprávy role `tool` jde přes JSON.stringify. */
    run: (args: z.infer<S>) => unknown;
};

/**
 * Jedno volání nástroje po ověření argumentů. `label` jde do chatu v obou případech,
 * `run()` nebo `error` je výsledek pro model (zpráva role `tool`).
 */
export type PreparedCall =
    | { ok: true; label: string; effect: ToolEffect; run: () => string }
    | { ok: false; label: string; error: string };

/** Nástroj v registru. Typ argumentů z něj nevidět: zůstal v closure uvnitř defineTool. */
type RegisteredTool = {
    name: string;
    definition: ChatFunctionTool;
    prepare: (rawArgs: string) => PreparedCall;
};

// z.toJSONSchema přidá klíč $schema; do definice nástroje nepatří, tak ho vynecháme
function toParams(schema: z.ZodType) {
    const { $schema, ...params } = z.toJSONSchema(schema);
    return params;
}

const errorText = (error: unknown) => `Chyba: ${error instanceof Error ? error.message : String(error)}`;
const fallbackLabel = (name: string) => `volám nástroj ${name}…`;

// generikum S žije jen tady: label a run dostanou typ argumentů odvozený ze schématu,
// ven jde objekt bez typového parametru, takže registr je obyčejné pole
function defineTool<S extends z.ZodType>(def: ToolDef<S>): RegisteredTool {
    return {
        name: def.name,
        definition: {
            type: 'function',
            function: { name: def.name, description: def.description, parameters: toParams(def.args) },
        },
        prepare(rawArgs) {
            // arguments je řetězec s JSONem, ne objekt; model může poslat cokoli, proto parse + zod
            let json: unknown;
            try {
                json = JSON.parse(rawArgs);
            } catch (error) {
                return { ok: false, label: fallbackLabel(def.name), error: errorText(error) };
            }
            const parsed = def.args.safeParse(json);
            if (!parsed.success) return { ok: false, label: fallbackLabel(def.name), error: `Chyba: ${def.invalidArgs}` };
            const args = parsed.data;
            return {
                ok: true,
                label: def.label(args),
                effect: def.effect,
                run: () => {
                    try {
                        // content zprávy je řetězec, proto JSON.stringify
                        return JSON.stringify(def.run(args));
                    } catch (error) {
                        // výjimka z nástroje (např. datum mimo kalendář) jde modelu jako text
                        return errorText(error);
                    }
                },
            };
        },
    };
}

// 2026-10-27 → 27. 10. (bez Date, ať nehraje roli časové pásmo)
function shortDate(iso: string): string {
    const [, month, day] = iso.split('-');
    return `${Number(day)}. ${Number(month)}.`;
}

// 09:40 → 9:40
const shortTime = (time: string) => time.replace(/^0/, '');

const registry: RegisteredTool[] = [
    defineTool({
        name: 'find_free_slots',
        effect: 'read',
        description: 'Volné termíny ordinace pro jeden den (začátky slotů po 20 minutách, 8:00–16:00). '
            + 'Použij, když se pacient ptá na volný termín. Datum ve formátu YYYY-MM-DD, kalendář sahá 14 dní od dneška. '
            + 'Prázdné pole znamená, že ten den není volno (o víkendu je zavřeno).',
        args: z.object({
            date: z.iso.date().describe('Den ve formátu YYYY-MM-DD'),
        }),
        invalidArgs: 'neplatné datum, očekávám { "date": "YYYY-MM-DD" }',
        label: ({ date }) => `hledám volné termíny ${shortDate(date)}…`,
        run: ({ date }) => findFreeSlots(date),
    }),
    // Krok 9.1: druhý nástroj
    defineTool({
        name: 'get_patient',
        effect: 'read',
        description: 'Najde pacienta ordinace podle jména nebo příjmení. Vrací pole { id, name, birthYear }. '
            + 'Prázdné pole = pacient u nás není; víc položek = zeptej se, o koho jde (třeba podle roku narození).',
        args: z.object({
            name: z.string().min(2).describe('Jméno nebo příjmení pacienta v 1. pádě, např. Dvořáková'),
        }),
        invalidArgs: 'očekávám { "name": "příjmení" } aspoň se dvěma znaky',
        label: ({ name }) => `hledám pacienta ${name}…`,
        run: ({ name }) => findPatients(name),
    }),
    // Krok 10: první zápis. Popisek je otázka pro sestru na kartě se schválením.
    defineTool({
        name: 'book_appointment',
        effect: 'write',
        description: 'Objedná pacienta na volný termín. Id pacienta ber z get_patient, čas z find_free_slots. '
            + 'Zápis před provedením schvaluje sestra; když ho odmítne, nabídni pacientovi jiný volný čas.',
        args: z.object({
            patientId: z.string().describe('Id pacienta z get_patient, např. p1'),
            date: z.iso.date().describe('Den ve formátu YYYY-MM-DD'),
            time: z.string().regex(/^\d{2}:\d{2}$/).describe('Začátek slotu HH:MM z find_free_slots, např. 09:40'),
        }),
        invalidArgs: 'očekávám { "patientId": "p1", "date": "YYYY-MM-DD", "time": "HH:MM" }',
        label: ({ patientId, date, time }) =>
            `objednat ${getPatient(patientId)?.name ?? patientId} na ${shortDate(date)} v ${shortTime(time)}`,
        run: ({ patientId, date, time }) => {
            const patient = getPatient(patientId);
            if (!patient) throw new Error(`pacient ${patientId} neexistuje`);
            bookAppointment(patientId, date, time);
            return { booked: true, patient: patient.name, date, time };
        },
    }),
];

/** Definice nástrojů pro model. */
export const tools: ChatFunctionTool[] = registry.map((tool) => tool.definition);

/**
 * Připraví jedno volání nástroje: argumenty rozparsuje a ověří jednou, popisek i vykonání pak berou z toho.
 * Nikdy nevyhazuje: neznámý nástroj, špatné argumenty i výjimka z nástroje jdou modelu jako text chyby
 * (popisek je pak obecné „volám nástroj X…“), model se může opravit nebo pacientovi říct, že termíny teď nezjistí.
 */
export function prepareTool(call: ChatToolCall): PreparedCall {
    const { name, arguments: rawArgs } = call.function;
    const tool = registry.find((t) => t.name === name);
    if (!tool) return { ok: false, label: fallbackLabel(name), error: `Chyba: neznámý nástroj ${name}` };
    return tool.prepare(rawArgs);
}

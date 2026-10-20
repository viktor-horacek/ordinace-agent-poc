// Chyby z @openrouter/sdk nesou v data$.request$ celý požadavek včetně hlavičky
// `authorization: Bearer <API klíč>` a v rawResponse i set-cookie. Celý objekt do logu nesmí,
// proto se loguje jen výtah níže. Samostatný soubor: model.ts bez klíče v env spadne už při importu.

type ProviderBody = { message?: unknown; code?: unknown; metadata?: { provider_name?: unknown; raw?: unknown } };

/** Bezpečný výtah z chyby pro log: jméno, zpráva, HTTP status a z těla jen zpráva, kód a text providera. */
export function describeError(error: unknown) {
    if (!(error instanceof Error)) return { message: String(error) };
    const e = error as Error & { statusCode?: unknown; error?: ProviderBody };
    const body = e.error;
    return {
        name: e.name,
        message: e.message,
        statusCode: typeof e.statusCode === 'number' ? e.statusCode : undefined,
        // metadata.raw = text chyby od providera (bez našich hlaviček)
        provider: body && typeof body === 'object'
            ? {
                message: body.message,
                code: body.code,
                providerName: body.metadata?.provider_name,
                raw: body.metadata?.raw,
            }
            : undefined,
    };
}

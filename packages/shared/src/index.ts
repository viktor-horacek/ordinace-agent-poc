// Kontrakt mezi serverem a webem: jeden typ eventů, který posílá server a čte web.
// Server i web ho importují stejně: import type { PocEvent } from '@ordinace/shared'
// Změna tady rozbije typecheck na obou stranách, takže se kontrakt nemůže potichu rozejít
// (stejná myšlenka jako GraphQL schéma + codegen, jen bez generování).

/** Spotřeba tokenů v našem tvaru, nezávislém na providerovi (server ji přeloží z usage providera). */
export type Usage = { input: number; output: number; reasoning?: number }

/** Discriminated union: podle pole `type` TypeScript ví, jaká další pole event má. */
export type PocEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'done' }
  | { type: 'error'; message: string }

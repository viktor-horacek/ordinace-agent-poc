# ordinace-agent-poc

Malý PoC v TypeScriptu, na kterém si zkouším stavbu AI asistenta: recepce smyšlené praktické ordinace
(„Ordinace Lipová“). Fastify server volá model přes OpenRouter, odpověď streamuje přes SSE do Reactu
a zvlášť ukazuje přemýšlení modelu. Všechna data jsou smyšlená.

## Co umí

- `POST /api/ask`: jedno volání modelu, vrací text a spotřebu tokenů.
- `POST /api/triage`: structured output. Model roztřídí zprávu pacienta podle JSON Schema ze zodu,
  server odpověď ověří (`502`, když neodpovídá).
- `POST /api/chat`: stream přes SSE. Vlastní typovaný protokol eventů (`thinking`, `text`, `usage`, `done`, `error`)
  sdílený mezi serverem a webem v `packages/shared`; formát providera zná jen `apps/server/src/events.ts`.
  Když klient odejde, server zruší i volání modelu.
- `POST /api/agent`: agentní smyčka s nástroji, bez streamu. Model má dva nástroje: `find_free_slots` nad smyšleným
  kalendářem (sloty po 20 minutách na dva týdny) a `get_patient` nad pěti smyšlenými pacienty; dnešní datum dostane
  v system promptu. Smyčka (`apps/server/src/agent.ts`) volá model; když chce nástroje, server argumenty ověří zodem,
  vykoná je, výsledky pošle zpátky jako zprávy `tool` a volá znovu. Když model odpoví textem, běh končí.
  Limit je 12 tahů (tah = jedno volání modelu) a kontroluje se před vykonáním nástrojů, takže model, který chce
  nástroj pořád, skončí chybou a nic se nespustí naprázdno. Neznámý nástroj, neplatné argumenty i výjimka jdou modelu
  jako text chyby, běh pokračuje.
- Testy smyčky (`npm test`, `node:test`, bez sítě): model je parametr smyčky, takže ho test nahradí skriptovaným
  modelem s předem danými odpověďmi. Ověřují dva nástroje za sebou, chybu nástroje jako výsledek, limit tahů
  a průchod scénáře s falešným modelem.
- Falešný model (`FAKE_MODEL=1`): pevný stream s přemýšlením a pravidla místo modelu pro `/api/agent`
  (dotaz na termín → `find_free_slots` → odpověď z výsledku; „paní Dvořákovou“ → `get_patient`, pak
  `find_free_slots`), všechno bez volání API, na vývoj a testy.

Zatím ne: nástroje ve streamu a v UI (event `tool_call`), schvalování zápisů, observabilita, RAG.

## Spuštění

Potřeba je Node 24 (ověřeno na 24.14) a npm 11.

```powershell
npm install
copy apps\server\.env.example apps\server\.env   # doplnit OPENROUTER_API_KEY, případně FAKE_MODEL=1
npm run dev                                      # = turbo dev: Vite na 5173 a Fastify na 3000 naráz
```

- `http://localhost:5173`: chat
- `curl.exe -N -X POST http://localhost:5173/api/chat`: syrový SSE stream přes Vite proxy
- `curl.exe -X POST http://localhost:5173/api/agent`: běh agenta s nástroji (bez těla: „Najdi paní Dvořákovou
  a navrhni jí termín v úterý ráno.“); odpověď obsahuje i volané nástroje a počet tahů
- `npm run typecheck`, `npm test`, `npm run build`: totéž přes turbo, výsledky se cachují

## Struktura

```
apps/web         React + Vite, proxy /api -> localhost:3000, stav chatu přes reducer nad eventy
apps/server      Fastify, Node 24 spouští .ts přímo (type stripping), node --watch
                 model.ts (klient @openrouter/sdk), events.ts (chunk providera -> eventy), fakeModel.ts
                 calendar.ts a patients.ts (smyšlená data), tools.ts (definice nástrojů a jejich vykonání),
                 agent.ts (smyčka s limitem tahů) a agent.test.ts
packages/shared  @ordinace/shared: kontrakt eventů mezi serverem a webem
turbo.json       tasky dev, typecheck, test, build
tsconfig.base.json  společné volby TypeScriptu, balíčky ho rozšiřují přes extends
```

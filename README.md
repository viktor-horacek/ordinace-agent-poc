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
- `POST /api/agent`: agentní smyčka s nástroji, odpověď přes stejné SSE jako `/api/chat`. Model má dva nástroje: `find_free_slots` nad smyšleným
  kalendářem (sloty po 20 minutách na dva týdny) a `get_patient` nad pěti smyšlenými pacienty; dnešní datum dostane
  v system promptu. Smyčka (`apps/server/src/agent.ts`) volá model; když chce nástroje, server argumenty ověří zodem,
  vykoná je, výsledky pošle zpátky jako zprávy `tool` a volá znovu. Když model odpoví textem, běh končí.
  Limit je 12 tahů (tah = jedno volání modelu) a kontroluje se před vykonáním nástrojů, takže model, který chce
  nástroj pořád, skončí chybou a nic se nespustí naprázdno. Neznámý nástroj, neplatné argumenty i výjimka jdou modelu
  jako text chyby, běh pokračuje.
  Během běhu server posílá event `tool_call` za každé volání nástroje s hotovým popiskem pro člověka (skládá ho
  z ověřených argumentů funkce u definice nástroje v `tools.ts`), na konci `text`, `usage` (součet za všechny
  tahy) a `done`. Jednotlivé tahy se nestreamují: odpověď a případné přemýšlení přijdou vcelku po každém tahu.
- Chat ve webu má přepínač „Agent s nástroji“ (zapnutý jako výchozí). S ním čte `/api/agent` a nad odpovědí
  vypisuje popisky ze serveru, třeba „hledám pacienta Dvořáková…“ a „hledám volné termíny 27. 10.…“;
  bez něj čte `/api/chat`.
- Testy smyčky (`npm test`, `node:test`, bez sítě): model je parametr smyčky, takže ho test nahradí skriptovaným
  modelem s předem danými odpověďmi. Ověřují dva nástroje za sebou, chybu nástroje jako výsledek, limit tahů
  a průchod scénáře s falešným modelem včetně eventů `tool_call`.
- Falešný model (`FAKE_MODEL=1`): pevný stream s přemýšlením a pravidla místo modelu pro `/api/agent`
  (dotaz na termín → `find_free_slots` → odpověď z výsledku; „paní Dvořákovou“ → `get_patient`, pak
  `find_free_slots`), všechno bez volání API, na vývoj a testy.

Zatím ne: průběžný text a přemýšlení uvnitř smyčky (stream tahů a skládání `tool_calls` po kouscích), zrušení běhu
agenta při odpojení klienta, schvalování zápisů, observabilita, RAG.

## Spuštění

Potřeba je Node 24 (ověřeno na 24.14) a npm 11.

```powershell
npm install
copy apps\server\.env.example apps\server\.env   # doplnit OPENROUTER_API_KEY, případně FAKE_MODEL=1
npm run dev                                      # = turbo dev: Vite na 5173 a Fastify na 3000 naráz
```

- `http://localhost:5173`: chat
- `curl.exe -N -X POST http://localhost:5173/api/chat`: syrový SSE stream přes Vite proxy
- `curl.exe -N -X POST http://localhost:5173/api/agent`: běh agenta s nástroji jako SSE (bez těla: „Najdi paní
  Dvořákovou a navrhni jí termín v úterý ráno.“); počet tahů a volané nástroje jsou i v logu serveru
- `npm run typecheck`, `npm test`, `npm run build`: totéž přes turbo, výsledky se cachují

## Struktura

```
apps/web         React + Vite, proxy /api -> localhost:3000, stav chatu přes reducer nad eventy
apps/server      Fastify, Node 24 spouští .ts přímo (type stripping), node --watch
                 model.ts (klient @openrouter/sdk), events.ts (chunk providera -> eventy), fakeModel.ts
                 calendar.ts a patients.ts (smyšlená data), tools.ts (registr nástrojů: definice pro model, jedno ověření argumentů, popisek, vykonání),
                 agent.ts (smyčka s limitem tahů) a agent.test.ts
packages/shared  @ordinace/shared: kontrakt eventů mezi serverem a webem
turbo.json       tasky dev, typecheck, test, build
tsconfig.base.json  společné volby TypeScriptu, balíčky ho rozšiřují přes extends
```

## Jak PoC vznikal

PoC jsem stavěl po malých krocích s asistencí agenta v Claude Code, jeden krok je jeden commit. Komentáře „Krok N“ v kódu odkazují na tabulku níže,
celý diff kroku je v historii (`git log --oneline`, pak `git show <commit>`).

| Krok | Co přidal | Hlavní soubory |
|---|---|---|
| 1 | Monorepo: Turborepo, prázdný web ve Vite + Reactu, server ve Fastify a balíček `shared` | `turbo.json`, `apps/*`, `packages/shared` |
| 2–3 | První volání modelu (`/api/ask`) a structured output podle zod schématu (`/api/triage`) | `model.ts`, `server.ts` |
| 4.1 | Stream z modelu vypsaný do terminálu, ještě bez serveru | `try-stream.ts` |
| 4.2 | `POST /api/chat` jako SSE s jedním pevným eventem | `server.ts` |
| 4.3, 4.5 | Stream modelu přeposílaný jako eventy `text`, `usage`, `done`, chyba uprostřed streamu jako `error` | `server.ts` |
| 4.4 | Když klient odejde, server zruší i volání modelu | `server.ts` |
| 5 | Chat v Reactu čte SSE přes `fetch`, tlačítko Zastavit přes AbortController | `App.tsx` |
| 6 | Typ `PocEvent` sdílený serverem a webem, překlad chunků providera, stav chatu v reduceru | `shared/src/index.ts`, `events.ts`, `chatReducer.ts` |
| – | Falešný model (`FAKE_MODEL=1`) pro vývoj bez volání API | `fakeModel.ts` |
| 7 | Přemýšlení modelu jako event `thinking`, v UI zvlášť od odpovědi | `events.ts`, `chatReducer.ts` |
| – | Přechod z balíčku openai na `@openrouter/sdk`, `complete()` a `streamChat()` | `model.ts`, `events.ts` |
| 8 | Nástroj `find_free_slots` nad smyšleným kalendářem, `/api/agent` s jednou otočkou | `tools.ts`, `calendar.ts`, `server.ts` |
| 9 | Agentní smyčka s limitem tahů, nástroj `get_patient`, testy se skriptovaným modelem | `agent.ts`, `patients.ts`, `agent.test.ts` |
| 9.5 | Event `tool_call` s popiskem od serveru, registr nástrojů, `/api/agent` přes SSE se společnou kostrou s `/api/chat`, řádky nástrojů v chatu | `shared/src/index.ts`, `tools.ts`, `agent.ts`, `server.ts`, `App.tsx` |

Soubory bez cesty jsou v `apps/server/src` nebo `apps/web/src`.

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
- Zápis se schválením člověkem: třetí nástroj `book_appointment` (id pacienta, datum, čas) zapíše do smyšleného
  kalendáře, slot pak není volný. Nástroj má v registru `effect: 'write'` (ostatní `'read'`) a takový smyčka sama
  nespustí: běh skončí s čekajícím voláním, server ho uloží se stavem `awaiting_approval` a pošle event
  `approval_required` (`runId`, popisek „objednat Jana Dvořáková na 27. 10. v 9:40“, id volání). Hranici drží
  server, ne věta v promptu. Rozhodnutí je nový požadavek: `POST /api/agent/:runId/approve` zápis vykoná,
  `/decline` ho nevykoná a modelu pošle jako výsledek nástroje „Uživatel zápis odmítl…“, takže model nabídne jiný
  čas; obojí pak pokračuje smyčkou a odpovídá stejným SSE jako `/api/agent`. Přechod jde jen ze stavu
  `awaiting_approval` a je synchronní (bez `await` mezi kontrolou a změnou stavu), takže druhé kliknutí dostane
  `409` a nezapíše podruhé; neznámý běh `404`. Běhy i objednávky jsou jen v paměti procesu (`Map`), bez persistence:
  restart serveru je smaže a hotové běhy se nemažou. Ve webu se u `approval_required` ukáže karta Schválit /
  Zamítnout a odpověď z approve/decline se dočte do stejného chatu.
- Chat ve webu má přepínač „Agent s nástroji“ (zapnutý jako výchozí). S ním čte `/api/agent` a nad odpovědí
  vypisuje popisky ze serveru, třeba „hledám pacienta Dvořáková…“ a „hledám volné termíny 27. 10.…“;
  bez něj čte `/api/chat`.
- Testy smyčky (`npm test`, `node:test`, bez sítě): model je parametr smyčky, takže ho test nahradí skriptovaným
  modelem s předem danými odpověďmi. Ověřují dva nástroje za sebou, chybu nástroje jako výsledek, limit tahů
  a průchod scénáře s falešným modelem včetně eventů `tool_call`. Testy schvalování (`approval.test.ts`): zápis se
  bez schválení nevykoná (slot v kalendáři zůstane volný), schválení zapíše, zamítnutí dostane model jako výsledek
  nástroje, druhé rozhodnutí o stejném běhu je `409`.
- Chyby od providera jdou do logu jen jako výtah (`describeError` v `apps/server/src/errors.ts`: jméno, zpráva,
  status, text chyby od providera), bez hlaviček, cookies a API klíče, které chyby z SDK nesou s sebou.
- Falešný model (`FAKE_MODEL=1`): pevný stream s přemýšlením a pravidla místo modelu pro `/api/agent`
  (dotaz na termín → `find_free_slots` → odpověď z výsledku; „paní Dvořákovou“ → `get_patient`, pak
  `find_free_slots`; „Objednej paní Dvořákovou na úterý ráno“ → `get_patient`, `find_free_slots`, `book_appointment`
  na první volný čas, po zamítnutí nabídne jiné časy, po schválení potvrdí), všechno bez volání API, na vývoj a testy.

Zatím ne: průběžný text a přemýšlení uvnitř smyčky (stream tahů a skládání `tool_calls` po kouscích), zrušení běhu
agenta při odpojení klienta, persistence běhů (teď jen paměť procesu) a jejich úklid, zrušení čekajícího běhu
(kromě Zamítnout), observabilita, RAG.

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
- schvalování curlem: `curl.exe -N -X POST http://localhost:5173/api/agent -H "content-type: application/json"
  --data-binary "@body.json"` s `{"prompt":"Objednej paní Dvořákovou na úterý ráno"}` v `body.json` (diakritika
  v souboru projde bez potíží s kódováním konzole), pak s `runId` z eventu `approval_required`
  `curl.exe -N -X POST http://localhost:5173/api/agent/<runId>/approve` (nebo `/decline`); druhé volání vrátí `409`
- `npm run typecheck`, `npm test`, `npm run build`: totéž přes turbo, výsledky se cachují

## Struktura

```
apps/web         React + Vite, proxy /api -> localhost:3000, stav chatu přes reducer nad eventy
apps/server      Fastify, Node 24 spouští .ts přímo (type stripping), node --watch
                 model.ts (klient @openrouter/sdk), events.ts (chunk providera -> eventy), fakeModel.ts
                 calendar.ts a patients.ts (smyšlená data), tools.ts (registr nástrojů: definice pro model, jedno ověření argumentů, popisek, vykonání),
                 agent.ts (smyčka s limitem tahů, pauza na zápis), runs.ts (běhy v paměti, přechod stavu),
                 agent.test.ts a approval.test.ts
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
| 10 | Zápis se schválením člověkem: `effect` v registru, nástroj `book_appointment`, běhy v paměti, `approval_required`, routy approve/decline s `409` při druhém rozhodnutí, karta Schválit / Zamítnout | `tools.ts`, `agent.ts`, `runs.ts`, `server.ts`, `approval.test.ts`, `App.tsx` |

Soubory bez cesty jsou v `apps/server/src` nebo `apps/web/src`.

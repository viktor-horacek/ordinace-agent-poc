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
- Falešný model (`FAKE_MODEL=1`): pevný stream s přemýšlením bez volání API, na vývoj a testy.

Zatím ne: nástroje, agentní smyčka, schvalování zápisů, observabilita, RAG.

## Spuštění

Potřeba je Node 24 (ověřeno na 24.14) a npm 11.

```powershell
npm install
copy apps\server\.env.example apps\server\.env   # doplnit OPENROUTER_API_KEY, případně FAKE_MODEL=1
npm run dev                                      # = turbo dev: Vite na 5173 a Fastify na 3000 naráz
```

- `http://localhost:5173`: chat
- `curl.exe -N -X POST http://localhost:5173/api/chat`: syrový SSE stream přes Vite proxy
- `npm run typecheck`, `npm test`, `npm run build`: totéž přes turbo, výsledky se cachují

## Struktura

```
apps/web         React + Vite, proxy /api -> localhost:3000, stav chatu přes reducer nad eventy
apps/server      Fastify, Node 24 spouští .ts přímo (type stripping), node --watch
                 model.ts (klient @openrouter/sdk), events.ts (chunk providera -> eventy), fakeModel.ts
packages/shared  @ordinace/shared: kontrakt eventů mezi serverem a webem
turbo.json       tasky dev, typecheck, test, build
tsconfig.base.json  společné volby TypeScriptu, balíčky ho rozšiřují přes extends
```

# SessionWoy

Per-tab named cookie sessions for Chrome (Manifest V3): several independent logins to the same
site side by side in one window. Sessions are **simulated** by cookie swapping, not real profile isolation.

Status: **Phase 0–2 (proof of concept) complete, verdict GO**; **Phase 3 (session manager UI) implemented**.
See `docs/adr/0002-poc-result.md` (results, limitations) and `docs/adr/0003-session-manager-ui.md` (UI decisions).
Abbreviations and terms (ADR, POC, SPA, DNR, …) are explained in `docs/GLOSARIUM.md`.

```text
extension/     MV3 extension (TypeScript strict, Svelte 5 UI, esbuild)
test-server/   Phase 1 deterministic test server (Fastify, Docker, 127.0.0.1:3003)
e2e/           Playwright scenarios for the go/no-go gate
backend/       Phase 4 placeholder (not built until the gate is final)
docs/adr/      PRD and architecture decision records
docs/GLOSARIUM.md  glossary of abbreviations and terms
```

## Prerequisites

Node.js ≥ 22 (`.nvmrc`), Docker Desktop (arm64), Google Chrome.

```bash
npm install
cp .env.example .env   # then set API_SECRET=$(openssl rand -hex 32)
npx playwright install chromium
```

## Run

```bash
docker compose up -d --build app           # test server, 127.0.0.1:3003 only
bash scripts/verify-test-server.sh         # expects customer / provider

npm test                                   # unit tests (test server + cookie jar + DNR rule builder)
npm run typecheck && npm run lint
npm run build                              # release build -> extension/dist (load this in Chrome)
npm run test:e2e                           # builds extension/dist-e2e (with test hooks), runs Playwright (HEADED=1 to watch)
STRESS_N=10000 npm run test:e2e -- -g S2   # full 10k-per-tab stress run
```

## Manual check in Chrome

1. `npm run build -w extension`, then `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist`.
2. Open `http://localhost:3003` in two tabs. In tab 1, toolbar popup → **+ New session** → "Customer" →
   **Create and use here**; in tab 2 create "Provider" the same way.
3. Click *Login as customer* in tab 1 and *Login as provider* in tab 2. Each tab keeps its own identity
   through reloads, `/redirect?hops=3` and *Open /whoami in a new tab*. The toolbar badge shows the tab's session;
   switch "Show sessions" to **Per group** (popup or side panel) to also put each session's tabs in a colored tab group.
4. Popup → **Manage sessions** opens the side panel: rename, recolor, reset, archive, delete, cookie names, settings.
5. A third, unassigned tab behaves like normal Chrome.
6. For a real site: popup → **Grant access to this site** (the tab reloads), choose a session, log in.

Session names and settings survive a browser restart; logins (cookies) do not yet. They stay in memory
until encrypted persistence arrives in Phase 4.

## How it works (short)

- DNR session rules scoped by `tabIds` strip the shared `Cookie` / `Set-Cookie` and set the session's cookies.
- `webRequest.onHeadersReceived` captures `Set-Cookie` into the session jar (it still sees headers that DNR removes).
- Requests sent before a rule update caught up are detected (`onSendHeaders` vs jar) and top-level GETs are re-issued.
- A MAIN-world script virtualizes `document.cookie`.

Ports 3000–3002 are reserved for other projects. This project uses 3003 (test server, container `app`) and 3004 (Phase 4 backend, container `backend`).

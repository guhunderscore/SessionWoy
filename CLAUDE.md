# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SessionWoy is a Chrome MV3 extension that gives tabs their own named cookie sessions, so you can be logged in to the same site several times in one window. It does this by **swapping cookies** (simulation), not by isolating real profiles. Phase 0–2 (proof of concept) is complete with a **GO** verdict (2026-11-10); Phase 3 (session manager UI) is next. The requirements live in `docs/adr/SessionWoy — PRD.md`. The design and its go/no-go criteria (G1–G10) are in `docs/adr/0001-cookie-swapping.md`. Results, findings F1–F5 and known limitations are in `docs/adr/0002-poc-result.md`. Read the ADRs before you change the isolation logic. Most of the non-obvious code exists because of a finding recorded there. Abbreviations and project terms are defined in `docs/GLOSARIUM.md` (in English); add new terms there when you introduce them.

npm workspaces: `extension/` (TS, esbuild), `test-server/` (Fastify, Docker), `e2e/` (Playwright). `backend/` is a Phase 4 placeholder and is deliberately left unbuilt until the gate is final. Node ≥ 22.

Docker naming in `docker-compose.yml` (compose commands use the service name, `docker` commands use the container name):

| Service | Container | Port | Notes |
| --- | --- | --- | --- |
| `app` | `app` | `127.0.0.1:3003` | Builds `./test-server` |
| `backend` | `backend` | `127.0.0.1:3004` | Phase 4. Only starts with `--profile backend`. Uses the `session_data` volume and `API_SECRET` from `.env` |

## Installation

You need Node.js ≥ 22 (see `.nvmrc`), Docker Desktop (arm64) and Google Chrome.

```bash
npm install
cp .env.example .env                        # then set API_SECRET=$(openssl rand -hex 32)
npx playwright install chromium             # only needed for e2e
npm run build -w extension                  # output: extension/dist
```

Load the extension: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick `extension/dist`. After every rebuild, click reload on the extension card.

## Usage

1. Start the test server with `docker compose up -d --build app`, then open `http://localhost:3003` in two tabs.
2. Use the toolbar popup to assign a session to each tab: **Customer** in tab 1 and **Provider** in tab 2. Sessions are fixed in the POC: Customer, Provider, Admin.
3. Click *Login as customer* in tab 1 and *Login as provider* in tab 2. Each tab keeps its own identity through reloads, through `/redirect?hops=3`, and through *Open /whoami in a new tab* (new tabs opened from a link inherit the session).
4. A tab with no session assigned behaves like normal Chrome.
5. For a real site, use popup → **Grant access to this site**, then reload, assign a session and log in. If the origin has no host permission, a managed tab silently falls back to the shared cookie jar.

Session cookies live only in `chrome.storage.session`, so they are lost when the browser restarts. The other storage types (localStorage, IndexedDB and so on) stay shared per origin. Requests made by a site's Service Worker are not isolated. The full list of limitations is in ADR 0002.

## Commands

```bash
docker compose up -d --build app            # service and container "app", 127.0.0.1:3003 (required for e2e)
docker logs -f app                          # test server logs
bash scripts/verify-test-server.sh          # sanity: customer / provider identities
docker compose --profile backend up -d --build backend   # Phase 4 only; backend/ has no Dockerfile yet

npm test                                    # vitest unit tests: test-server + extension
npm run typecheck && npm run lint
npm run build                               # extension -> extension/dist, test-server -> dist
npm run watch -w extension                  # rebuild on change

npm run test:e2e                            # builds extension, then Playwright (HEADED=1 to watch)
npm run test:e2e -- -g S5                   # single e2e scenario by its S-number
STRESS_N=10000 npm run test:e2e -- -g S2    # full stress run
npx vitest run test/rules.test.ts           # single unit test file (run inside extension/ or test-server/)
```

The e2e global setup fails fast if `extension/dist/manifest.json` is missing or if the test server's `/health` is unreachable. Playwright runs with `workers: 1` on purpose, because latency is measured (S14). Ports 3000–3002 belong to other projects. This project uses 3003 (test server, container `app`) and 3004 (Phase 4 backend, container `backend`).

To check by hand, load `extension/dist` unpacked in Chrome. The README has the step-by-step checklist.

## Extension architecture

Isolation is spread across several cooperating mechanisms. Keep them consistent with each other:

1. **DNR session rules** (`shared/rules.ts` is a pure builder, `background/dnr.ts` installs the rules). For each session, every rule is scoped by `tabIds`:
   - A priority-1 catch-all removes `Cookie` and `Set-Cookie`, so the shared Chrome jar is never touched.
   - Higher-priority `regexFilter` rules, one per (host, cookie path, scheme), *set* `Cookie` to the session's cookies.
   - Rules **must list every resource type** explicitly (`ALL_RESOURCE_TYPES`). DNR's default leaves out `main_frame` (F2). A unit test emulates this.
   - Each update replaces one session's rules in a single atomic `updateSessionRules` call.
2. **Cookie jar** (`shared/cookieJar.ts`): an RFC 6265 jar per session. It has no PSL and no CHIPS.
3. **Capture**: `webRequest.onHeadersReceived` (with `extraHeaders`) still sees the original `Set-Cookie` that DNR strips (F1). It updates the in-memory jar **synchronously**, then queues the rule rebuild.
4. **Stale-request healing** (F3): `onSendHeaders` shows the post-DNR `Cookie` header. If that header differs from the jar, the request went out before the rule update landed. A stale top-level GET is re-issued with `tabs.update` and its `Set-Cookie` is discarded. The loop guard allows 2 re-issues per URL per 5 s.
5. **`document.cookie`**: `content/main.ts` runs in the MAIN world and virtualizes the getter and setter. `content/relay.ts` runs in the ISOLATED world and bridges to the worker through `CustomEvent`s carrying JSON strings (`shared/messages.ts`). The worker derives the origin from `sender.url` and never from the payload. A `sessionStorage` snapshot cache gives reloads a synchronous answer. Content scripts are registered dynamically (`syncContentScripts`) for the origins that currently have host permission, not from the manifest.
6. **Session inheritance** (F4, F6): `webNavigation.onCreatedNavigationTarget` (links, `window.open`) is authoritative and always wins. Duplicate detection (the new tab's URL equals its opener's URL) is only a fallback: it waits 300 ms, skips link-created tabs, never overrides an existing assignment, and reloads the tab after assigning. Don't use `openerTabId` alone; it is set on unrelated tabs. Every decision is logged in `diag.inheritLog`.

Service worker rules (`background/index.ts`):
- Register every listener synchronously at top level. That is an MV3 requirement.
- Every state mutation goes through `run()`/`serial()`. It is a single FIFO promise chain, and its first task is `init()`. `init()` rehydrates `Store` from `chrome.storage.session`, drops dead tabs, and replaces **all** rules in one atomic call (F5).
- Listeners must not judge staleness until `loaded` is true.

`globalThis.sessionwoy` is the debug API used by Playwright through `serviceWorker.evaluate` (typed in `e2e/fixtures.ts`). When you change it, update both files. It must be removed or gated before any release. Sessions A/B/C are hard-coded `PRESETS` (Customer, Provider, Admin) in `background/state.ts`. Phase 3 replaces them with user-created sessions.

## Test server and e2e

`test-server/src/app.ts` is deterministic and has these endpoints: `/login?user=&next=`, `/logout`, `/whoami` (returns identity, cookies and trail), `/redirect?hops=`, `/parallel?delay=&id=`, `/health`, and a cookie-setting route used by expiry tests. The e2e scenarios S1–S15 in `e2e/tests/poc.spec.ts` map one-to-one to the results table in ADR 0002. If you add or change a scenario, update that ADR as well.

## Conventions

- TypeScript is strict, with `noUncheckedIndexedAccess`. ESM everywhere. Imports use `.js` suffixes.
- Prettier settings: single quotes, trailing commas, width 100.
- ESLint: prefix unused args with `_`. `console.log` gives a warning. Use `console.error`, `console.warn` or `console.info` with a `[sessionwoy]` prefix.
- Never log cookie values. Diagnostics record cookie names only.
- Icons: `extension/public/icons/icon-{16,32,48,128}.png` (transparent PNG, referenced by `icons` and `action.default_icon` in `public/manifest.json`). The full-size source is `extension/assets/jarsession.png`. Keep it out of `public/`, because everything in `public/` is copied into `dist/`.

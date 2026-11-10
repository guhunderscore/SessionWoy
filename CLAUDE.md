# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SessionWoy is a Chrome MV3 extension that gives tabs their own named cookie sessions, so you can be logged in to the same site several times in one window. It does this by **swapping cookies** (simulation), not by isolating real profiles. Phase 0–2 (proof of concept) is complete with a **GO** verdict (2026-11-10); Phase 3 (session manager UI: popup + side panel in Svelte, tab groups) is implemented. Phase 4 (encrypted persistence with a passphrase, encrypted backup files, tab restore after a browser restart, optional local backend) is implemented and passed its manual Chrome check; decisions in `docs/adr/0004-persistence-and-backend.md`. Phase 5 (web storage compatibility and reliability) is next. The requirements live in `docs/adr/SessionWoy — PRD.md`. The design and its go/no-go criteria (G1–G10) are in `docs/adr/0001-cookie-swapping.md`. Results, findings F1–F6 and known limitations are in `docs/adr/0002-poc-result.md`. The Phase 3 UI decisions (Svelte instead of React, tab-group palette, persistence split, debug-API gating) are in `docs/adr/0003-session-manager-ui.md`. Read the ADRs before you change the isolation logic. Most of the non-obvious code exists because of a finding recorded there. Abbreviations and project terms are defined in `docs/GLOSARIUM.md` (in English); add new terms there when you introduce them.

npm workspaces: `extension/` (TS + Svelte 5 UI, esbuild + esbuild-svelte), `test-server/` (Fastify, Docker), `backend/` (Fastify + Zod + better-sqlite3, Docker; ciphertext only), `e2e/` (Playwright). Node ≥ 22.

Docker naming in `docker-compose.yml` (compose commands use the service name, `docker` commands use the container name):

| Service | Container | Port | Notes |
| --- | --- | --- | --- |
| `app` | `app` | `127.0.0.1:3003` | Builds `./test-server` |
| `backend` | `backend` | `127.0.0.1:3004` | Optional (Phase 4). Only starts with `--profile backend`. Uses the `session_data` volume and `API_SECRET` from `.env`; stores ciphertext only |

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
2. In tab 1, open the toolbar popup → **+ New session** (e.g. "Customer") → **Create and use here**. In tab 2, create "Provider" the same way. Sessions are user-created; there are no presets.
3. Click *Login as customer* in tab 1 and *Login as provider* in tab 2. Each tab keeps its own identity through reloads, through `/redirect?hops=3`, and through *Open /whoami in a new tab* (new tabs opened from a link inherit the session). The toolbar badge shows the active tab's session. With "Show sessions: Per group" (popup or side panel; default is "Per tab"), each session's tabs also share a Chrome tab group.
4. Popup → **Manage sessions** opens the side panel: rename, recolor, reset, archive/restore, delete, see cookie names per session, settings (marker mode per tab / per group, inheritance).
5. A tab with no session assigned behaves like normal Chrome.
6. For a real site, choosing a session in the popup first asks for access to that site (F8). Without host access a session cannot apply there: the worker refuses to assign, and a session tab that navigates to such a site shows a red "!" badge (it uses the shared cookie jar there). Runtime-granted access is lost when the unpacked extension is removed and loaded again.

7. Side panel → **Security**: set a passphrase to keep logins after Chrome restarts (encrypted). After a restart the popup asks to unlock; until then session tabs are logged out. Tabs that Chrome restores rejoin their sessions automatically (FR-17). **Backup** exports/imports an encrypted file. **Backend** (optional) connects the `backend` container with `API_SECRET`.

Session names, colors and settings are stored in `chrome.storage.local`. Without a passphrase, session cookies live only in `chrome.storage.session` (lost on restart); with one, they are also saved encrypted (AES-256-GCM) in `chrome.storage.local`. The other storage types (localStorage, IndexedDB and so on) stay shared per origin. Requests made by a site's Service Worker are not isolated. The full list of limitations is in ADR 0002.

## Commands

```bash
docker compose up -d --build app            # service and container "app", 127.0.0.1:3003 (required for e2e)
docker logs -f app                          # test server logs
bash scripts/verify-test-server.sh          # sanity: customer / provider identities
docker compose --profile backend up -d --build backend   # optional backend, 127.0.0.1:3004 (needs API_SECRET)

npm test                                    # vitest unit tests: test-server + extension + backend
npm run typecheck && npm run lint           # typecheck = svelte-check (TS + Svelte) in extension/
npm run build                               # release: extension -> extension/dist (no debug API), test-server -> dist
npm run build:e2e -w extension              # test build: extension -> extension/dist-e2e (with debug API)
npm run watch -w extension                  # rebuild on change

npm run test:e2e                            # builds dist-e2e + backend, then Playwright (HEADED=1 to watch)
npm run test:e2e -- -g S5                   # single e2e scenario by its S-number
STRESS_N=10000 npm run test:e2e -- -g S2    # full stress run
npx vitest run test/rules.test.ts           # single unit test file (run inside extension/ or test-server/)
```

The e2e global setup fails fast if `extension/dist-e2e/manifest.json` is missing or if the test server's `/health` is unreachable. Persistence tests relaunch Chromium with the same profile dir (`launchBrowser(dir)` in `e2e/fixtures.ts`) to simulate a browser restart, and start a private backend process on port 3014 (never the `backend` container). Playwright runs with `workers: 1` on purpose, because latency is measured (S14). Ports 3000–3002 belong to other projects. This project uses 3003 (test server, container `app`) and 3004 (Phase 4 backend, container `backend`).

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
5. **`document.cookie`**: `content/main.ts` runs in the MAIN world and virtualizes the getter and setter. `content/relay.ts` runs in the ISOLATED world and bridges to the worker through `CustomEvent`s carrying JSON strings (`shared/messages.ts`). The relay also drives the favicon dot (`content/favicon.ts`: site favicon + session-color dot, fallback circle, restored on leave), using the `color` field of the snapshot. After an extension reload the old relay is orphaned and `chrome.runtime.sendMessage` throws synchronously (F7): every send must stay inside `try/await`, and on a dead context the relay detaches and tells MAIN `{ managed: false }` (tested in `test/relay.test.ts`; Playwright cannot reload an unpacked extension). The worker derives the origin from `sender.url` and never from the payload. A `sessionStorage` snapshot cache gives reloads a synchronous answer. Content scripts are registered dynamically (`syncContentScripts`) for the origins that currently have host permission, not from the manifest.
6. **Session inheritance** (F4, F6): `webNavigation.onCreatedNavigationTarget` (links, `window.open`) is authoritative and always wins. Duplicate detection (the new tab's URL equals its opener's URL) is only a fallback: it waits 300 ms, skips link-created tabs, never overrides an existing assignment, and reloads the tab after assigning. Don't use `openerTabId` alone; it is set on unrelated tabs. Every decision is logged in `diag.inheritLog`.

Service worker rules (`background/index.ts`):
- Register every listener synchronously at top level. That is an MV3 requirement.
- Every state mutation goes through `run()`/`serial()`. It is a single FIFO promise chain, and its first task is `init()`. `init()` rehydrates `Store` (session metadata + settings from `chrome.storage.local`, tabs/jars/groups from `chrome.storage.session`), drops dead tabs, and replaces **all** rules in one atomic call (F5).
- Listeners must not judge staleness until `loaded` is true.
- Cookies reach `chrome.storage.local` **only** as AES-256-GCM ciphertext through the vault (`background/vault.ts`, `shared/crypto.ts`). `Store.save()` = runtime/memory, `saveMeta()` (wraps `Store.saveDurable()`) = metadata + settings, also mirrored to the backend. Never log or send to the UI a passphrase, key, cookie value or the backend secret.
- Any code path that changes a session's cookies must call `persistLater(sessionId)` (debounced encrypted save); deleting a session calls `vault.remove`. While locked nothing is written and session tabs run logged out (never with shared cookies).
- FR-17 restore window opens in `init()` when session memory was empty (browser start / extension reload), never from `runtime.onStartup` (a restored tab can report its marker first). Markers: `background/restore.ts`, relay keeps `__sessionwoy_tab` in sessionStorage.
- Backend sync (`background/backend.ts`): queue + debounced push; never block on the backend (reduced mode, FR-20); never push before `verifyBackend()` has checked that the backend's vault is ours (`remoteDiffers`), so a new device can't overwrite another device's data.
- Every UI-visible mutation calls `broadcastUi()` so an open side panel refreshes.

UI (ADR 0003): `src/ui/` is Svelte 5 (`<script lang="ts">`, runes). Popup = quick actions for the active tab; side panel = management. They talk to the worker only through `ui:*` messages (`shared/messages.ts`, client in `ui/api.ts`), accepted only from extension pages; replies are `{ ok, data | error }`. Session colors must be one of the 9 Chrome tab-group colors (`shared/sessions.ts`). The session is always chosen per tab; the `grouping` setting (`'tab'` default, or `'group'`) only controls the marker. Tab groups live in `background/groups.ts`, are only a marker (dragging a tab between groups never changes its session), and must never break isolation (best-effort, errors logged). Any `ui:*` path that puts a tab (or a URL) into a session must call `requireHostAccess` first (F8); the popup's `ensureAccess()` must be the first `await` in its click handler because `chrome.permissions.request` needs the user gesture. Use inline confirmation (`ConfirmInline.svelte`), never `window.confirm`. The cookie list never receives cookie values (`summarizeCookies`).

`globalThis.sessionwoy` is the debug API used by Playwright through `serviceWorker.evaluate` (typed in `e2e/fixtures.ts`). It exists only when `__E2E__` is true (`npm run build:e2e`); the release build strips it. When you change it, update both files. In the e2e build, unknown session ids passed to its `assign*`/`openTabInSession` helpers are created on the fly (id = name).

## Test server and e2e

`test-server/src/app.ts` is deterministic and has these endpoints: `/login?user=&next=`, `/logout`, `/whoami` (returns identity, cookies and trail), `/redirect?hops=`, `/parallel?delay=&id=`, `/health`, and a cookie-setting route used by expiry tests. The e2e scenarios S1–S15 in `e2e/tests/poc.spec.ts` map one-to-one to the results table in ADR 0002; S16–S21 in `e2e/tests/ui.spec.ts` map to ADR 0003; S22–S27 in `e2e/tests/persistence.spec.ts` map to ADR 0004. The test server serves `/favicon.svg` (linked from `/`) for the favicon-dot scenario. If you add or change a scenario, update the matching ADR as well. UI actions that assign, archive or reset reload the tab by design, so tests should navigate fresh (`gotoJson`) afterwards instead of `fetch()` inside the reloading page.

## Conventions

- TypeScript is strict, with `noUncheckedIndexedAccess`. ESM everywhere. Imports use `.js` suffixes.
- Prettier settings: single quotes, trailing commas, width 100.
- ESLint: prefix unused args with `_`. `console.log` gives a warning. Use `console.error`, `console.warn` or `console.info` with a `[sessionwoy]` prefix.
- Never log cookie values. Diagnostics record cookie names only.
- Icons: `extension/public/icons/icon-{16,32,48,128}.png` (transparent PNG, jar filling the full height with no padding, a user choice in ADR 0003; referenced by `icons` and `action.default_icon` in `public/manifest.json`). The full-size source is `extension/assets/jarsession.png`. Keep it out of `public/`, because everything in `public/` is copied into `dist/`.

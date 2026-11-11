# SessionWoy

Per-tab named cookie sessions for Chrome (Manifest V3). Stay logged in to the same site with several
accounts side by side in one window, for example a _Customer_ tab next to a _Provider_ tab.

Sessions are **simulated** by swapping cookies per tab. They are not separate Chrome profiles: only
cookies are isolated (see [Limitations](#limitations)).

## Status

| Phase | Scope                                                        | State                                                                                      |
| ----- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 0–2   | Research, test server, proof of concept                      | ✅ Done, verdict **GO** ([ADR 0002](docs/adr/0002-poc-result.md))                          |
| 3     | Session manager UI: popup, side panel, tab groups            | ✅ Implemented ([ADR 0003](docs/adr/0003-session-manager-ui.md))                           |
| 4     | Encrypted persistence, backup, tab restore, optional backend | ✅ Implemented, manual check passed ([ADR 0004](docs/adr/0004-persistence-and-backend.md)) |
| 5     | Web compatibility and reliability                            | 🚧 Part 1 implemented ([ADR 0005](docs/adr/0005-web-compatibility.md)), manual check open  |

The extension is not published on the Chrome Web Store. Load it unpacked (see below).

## Features

- **Named sessions per tab**: create, rename, recolor, reset, archive and delete sessions. A tab without
  a session behaves like normal Chrome.
- **Session follows navigation**: reloads, redirects, and links or `window.open` from a session tab stay
  in that session (configurable).
- **Visible markers**: toolbar badge, a colored dot on the tab's favicon, and optionally one Chrome tab
  group per session.
- **Cookie overview**: the side panel lists cookie names per session (never values).
- **Keep logins across restarts** (opt-in): cookies are saved encrypted with a passphrase
  (AES-256-GCM, PBKDF2 600k). After a Chrome restart, unlock once and restored tabs rejoin their sessions.
- **Encrypted backup**: export and import all sessions as an encrypted file.
- **Optional local backend**: a small Docker service that stores ciphertext only. The extension keeps
  working when the backend is offline.

## Quick start

Requirements: Node.js ≥ 22 (`.nvmrc`), Docker Desktop, Google Chrome ≥ 120.

```bash
npm install
cp .env.example .env              # then set API_SECRET=$(openssl rand -hex 32)
npm run build                     # extension -> extension/dist
docker compose up -d --build app  # test server on http://127.0.0.1:3003
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose
   `extension/dist`. After every rebuild, click reload on the extension card.
2. Open `http://localhost:3003` in two tabs.
3. Tab 1: toolbar popup → **+ New session** → "Customer" → **Create and use here**.
   Tab 2: create "Provider" the same way.
4. Click _Login as customer_ in tab 1 and _Login as provider_ in tab 2. Each tab keeps its own identity
   through reloads, `/redirect?hops=3` and _Open /whoami in a new tab_.

### Using it on a real site

Choose a session in the popup while on the site. Chrome first asks for access to that site; the session
only applies after access is granted. If a session tab navigates to a site without access, its badge
shows a red **"!"** and it uses Chrome's shared cookies there. Log in again after granting access.

Disable other multi-session extensions while using SessionWoy; two cookie-swapping extensions interfere
with each other.

## Manual checklist

Builds on the quick start above.

1. A third tab with no session behaves like normal Chrome and is unaffected by tabs 1 and 2.
2. Switch "Show sessions" to **Per group** (popup or side panel) to put each session's tabs in a colored tab group.
3. Popup → **Manage sessions** opens the side panel: rename, recolor, reset, archive, delete, cookie names, settings.
4. Side panel → **Security** → set a passphrase. Restart Chrome: the popup asks to unlock, restored tabs
   rejoin their sessions, and after unlocking they are logged in again.
5. Side panel → **Backup**: export an encrypted file and import it again.
6. Side panel → **Backend**: start it with `docker compose --profile backend up -d --build backend`, connect
   `http://127.0.0.1:3004` with `API_SECRET`, then stop the container to see the offline status.

## How it works

- **declarativeNetRequest session rules**, scoped by tab id, remove `Cookie` / `Set-Cookie` so Chrome's
  shared cookie jar is never touched, and set the session's own `Cookie` header instead.
- **`webRequest.onHeadersReceived`** still sees the original `Set-Cookie` headers and stores them in the
  session's RFC 6265 cookie jar.
- **Stale-request healing**: a request that left before a rule update landed is detected, and a stale
  top-level GET is re-issued (this fixes the login-redirect race).
- **`document.cookie`** is virtualized by a content script, so JavaScript sees the session's cookies.
- **Encrypted vault**: with a passphrase, cookies reach `chrome.storage.local` only as ciphertext. A tab
  marker in `sessionStorage` lets tabs that Chrome restores rejoin their session.

- **Service Worker guard**: session tabs may not register a site Service Worker, and one that is
  already installed is removed, because its requests carry no tab and would use Chrome's shared cookies.

The reasoning behind each mechanism, and the findings (F1–F10) that shaped it, are in the ADRs.

### Permissions

| Permission                                                     | Why                                                                               |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `declarativeNetRequest`, `declarativeNetRequestWithHostAccess` | Swap `Cookie` / `Set-Cookie` headers per tab                                      |
| `webRequest`                                                   | Capture `Set-Cookie` and detect stale requests                                    |
| `cookies`, `scripting`                                         | Import JS-written cookies; register the `document.cookie` script per granted site |
| `tabs`, `tabGroups`, `webNavigation`                           | Track tabs, session inheritance, tab-group markers                                |
| `storage`, `alarms`, `sidePanel`                               | Session state, debounced saves, the management UI                                 |
| Host access to `localhost:3003`, `127.0.0.1:3003`              | The bundled test server works without asking                                      |
| Optional host access (`http://*/*`, `https://*/*`)             | Requested per site, only when you use a session there                             |

## Limitations

Only cookies are isolated. Known gaps (details in [ADR 0002](docs/adr/0002-poc-result.md#known-limitations-to-carry-into-the-compatibility-matrix) and [ADR 0005](docs/adr/0005-web-compatibility.md)):

- `localStorage`, IndexedDB and CacheStorage stay **shared per site**. For example, a shopping cart
  stored in `localStorage` is visible to every session. (`sessionStorage` is per tab anyway.)
- A site's **Service Worker** cannot be isolated, so it is **switched off in session tabs**: offline mode,
  push notifications and background sync of that site don't work there, and normal tabs of that site
  lose the worker until the site installs it again. See [ADR 0005](docs/adr/0005-web-compatibility.md).
- Healing re-issues stale GET navigations (tabs and iframes) only; a stale GET hop runs twice on the server.
- No Public Suffix List and no CHIPS partitioning; `SameSite` handling is simplified.
- Chrome's limit on regex rules (~1000) caps the number of (host × cookie path) combinations.
- Without a passphrase, logins are kept in memory only and are lost when Chrome restarts.
  A forgotten passphrase cannot be recovered.

## Development

```bash
docker compose up -d --build app           # test server, 127.0.0.1:3003 (required for e2e)
bash scripts/verify-test-server.sh         # sanity check: customer / provider identities

npm test                                   # unit tests (test server, extension, backend)
npm run typecheck && npm run lint
npm run build                              # release build -> extension/dist (no debug API)
npm run watch -w extension                 # rebuild on change

npx playwright install chromium            # once, for e2e
npm run test:e2e                           # builds extension/dist-e2e, runs Playwright (HEADED=1 to watch)
npm run test:e2e -- -g S5                  # one scenario
STRESS_N=10000 npm run test:e2e -- -g S2   # full stress run (10k requests per tab)
```

The e2e scenarios map one-to-one to the result tables in the ADRs: S1–S15 → ADR 0002, S16–S21 → ADR 0003,
S22–S27 → ADR 0004, S28–S33 → ADR 0005. Playwright runs with one worker on purpose because S14 measures latency.

Ports: 3003 is the test server (container `app`), 3004 is the optional backend (container `backend`).
Ports 3000–3002 are left for other projects.

### Repository layout

```text
extension/          MV3 extension (TypeScript strict, Svelte 5 UI, esbuild)
  src/background/   service worker: DNR rules, state, vault, restore, backend sync, tab groups
  src/content/      document.cookie virtualization, relay, favicon dot
  src/shared/       cookie jar, rule builder, crypto, messages
  src/ui/           popup and side panel (Svelte)
test-server/        deterministic test server (Fastify, Docker, 127.0.0.1:3003)
backend/            optional local API (Fastify + SQLite, Docker, 127.0.0.1:3004, ciphertext only)
e2e/                Playwright scenarios S1–S33
docs/adr/           PRD and architecture decision records
docs/GLOSARIUM.md   glossary of abbreviations and project terms
```

## Documentation

| Document                                             | Contents                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| [PRD](docs/adr/SessionWoy%20—%20PRD.md)              | Requirements, architecture, phase plan                               |
| [ADR 0001](docs/adr/0001-cookie-swapping.md)         | Why cookie swapping; go/no-go criteria G1–G10                        |
| [ADR 0002](docs/adr/0002-poc-result.md)              | POC results, findings F1–F6, limitations, real-site compatibility    |
| [ADR 0003](docs/adr/0003-session-manager-ui.md)      | Session manager UI decisions, findings F7–F8                         |
| [ADR 0004](docs/adr/0004-persistence-and-backend.md) | Encrypted persistence, backup, tab restore, backend                  |
| [ADR 0005](docs/adr/0005-web-compatibility.md)       | Service Workers, iframes, OAuth popups, web storage; findings F9–F10 |
| [Glossary](docs/GLOSARIUM.md)                        | Abbreviations and project terms                                      |

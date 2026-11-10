# SessionWoy — Product Requirements Document

Version 0.1 (Draft) · November 9, 2026 · Project name: SessionWoy

## 1. Overview

### 1.1 Problem statement

Chrome tabs in the same profile share one cookie jar per website. A developer or QA engineer who needs to be logged in to the same website as several different accounts at the same time (for example Customer, Service Provider, and Admin) must either open separate Chrome profiles, use incognito windows (only one extra session), or log in and out repeatedly.

### 1.2 Product vision

SessionWoy is a local-first Chrome extension (Manifest V3) that assigns a named session to each browser tab, so that several independent logins to the same website can live side by side in one Chrome window. An optional local server running in Docker provides encrypted persistence, backup/restore, and diagnostics.

### 1.3 Key technical qualification

Chrome does not expose a native per-tab cookie store to extensions. SessionWoy therefore **simulates** session separation by swapping cookies on requests and capturing cookies from responses. This is not equivalent to Chrome profile isolation. Because the target is "any website", the project is gated by a go/no-go proof of concept (Phase 2) before any UI or backend is built.

### 1.4 Important clarification on Docker

Docker and the database do not create session isolation. They only store state that the browser-side mechanism manages. The Docker server is therefore optional supporting infrastructure, and its first job is to host a deterministic test server used to prove that isolation works.

## 2. Goals and Non-Goals

### 2.1 Goals

- G1. Let a user create, rename, color-code, and delete named sessions.
- G2. Assign a session to a tab, and open a new tab directly in a chosen session.
- G3. Support several sessions on the same origin at the same time, without cookie cross-contamination.
- G4. Support multiple tabs sharing one session.
- G5. Persist session data across browser restarts (encrypted at rest).
- G6. Keep ordinary (unmanaged) Chrome tabs completely unaffected.
- G7. Work on arbitrary websites to the extent technically possible, and document exactly which behaviors are unsupported.

### 2.2 Non-Goals (first release)

- Cloud sync, accounts, or team sharing.
- Proxy rotation, fingerprint spoofing, or any anti-detection feature.
- Mobile browsers and non-Chrome browsers.
- Guaranteed compatibility with every website.
- Replacing Chrome or building a browser engine.
- Production use with banking, payment, or other high-risk accounts.
- Bypassing website access controls, rate limits, or account restrictions.

## 3. Users and Use Cases

| User | Use case |
| --- | --- |
| Web developer | Test one app as Customer, Provider, and Admin simultaneously in one window |
| QA engineer | Reproduce role-based bugs without switching accounts |
| Support engineer | View a product as different test users side by side |

Primary scenario: the user opens a site, creates the session "Customer" for the tab, logs in, opens a second tab, creates the session "Provider", logs in with another account, and both tabs keep their own identity through reloads, redirects, and browser restarts.

## 4. Product Scope Decisions

| Decision | Choice | Reasoning |
| --- | --- | --- |
| Target sites | Any website | Hostname-alias approaches only work for sites the team controls, so the extension must work on third-party sites |
| Isolation mechanism | Cookie swapping in the extension | The only extension-level mechanism available under Manifest V3 for arbitrary origins |
| Storage isolation | Best effort, documented | localStorage, IndexedDB, and Service Worker state are shared per origin and cannot be fully virtualized by an extension |
| Backend | Optional, Docker, loopback only | Needed for backup and diagnostics, not for isolation |
| Database | SQLite | Single-user local tool; MySQL or PostgreSQL add operational cost without benefit |
| Fallback | Containerized Chrome profiles or separate `--user-data-dir` profiles | Real isolation if the cookie-swapping POC fails |

## 5. Functional Requirements

### 5.1 Session management

- FR-1. The user can create a session with a name and color.
- FR-2. The user can rename, recolor, archive, and delete a session. Deleting a session deletes all of its stored data.
- FR-3. The user can reset a session (clear its stored cookies) without deleting it.

### 5.2 Tab assignment

- FR-4. The user can assign the active tab to an existing session, or create a session for it.
- FR-5. The user can open a new tab in a chosen session.
- FR-6. Every managed tab shows its session name and color (badge, title prefix, or tab group).
- FR-7. Links opened from a managed tab inherit that tab's session by default (configurable).
- FR-8. Duplicated tabs follow an explicit, documented rule (inherit the session).
- FR-9. Closing a tab removes its runtime mapping but never deletes session data.

### 5.3 Cookie virtualization

- FR-10. For requests from a managed tab, the extension replaces the `Cookie` request header with the cookies stored for that session and request URL.
- FR-11. Cookies set by responses (`Set-Cookie`) to a managed tab are stored in that session and must not leak into the shared Chrome cookie jar or into other sessions.
- FR-12. Cookies set by page JavaScript (`document.cookie`) in a managed tab are captured into the session through a page-world hook.
- FR-13. Cookie attributes (Domain, Path, Secure, HttpOnly, SameSite, Expires, Max-Age) are honored when selecting cookies for a request and when expiring them.
- FR-14. Requests from unmanaged tabs are never modified.

### 5.4 Persistence

- FR-15. Session metadata and cookie data survive browser restarts.
- FR-16. After the extension service worker is suspended and restarted, tab-to-session mappings are recovered without user action.
- FR-17. After a browser restart, tab mappings are restored by a documented strategy (session-restored tabs are matched using URL and a tab marker); unmatched tabs are treated as unmanaged and the user is informed.

### 5.5 Local backend (optional, Phase 4)

- FR-18. The extension can sync encrypted session payloads to the local backend.
- FR-19. The user can export and import an encrypted backup.
- FR-20. The extension works in a clearly defined reduced mode when the backend is unavailable.
- FR-21. The backend exposes a health endpoint and a connection status indicator is shown in the UI.

## 6. Non-Functional Requirements

| Area | Requirement |
| --- | --- |
| Correctness | Zero cross-session cookie leakage in all automated stress tests (target: 10,000 parallel requests across two sessions) |
| Performance | Added latency per request under 5 ms at the 95th percentile; rule updates complete before the first request of a navigation |
| Reliability | Survives service worker suspension and Chrome restart without losing session mapping |
| Privacy | All data stays on the local machine by default; no telemetry |
| Security | Cookies and tokens are encrypted at rest; secrets are never logged |
| Compatibility | Latest Chrome stable on macOS (Apple Silicon); exact target version fixed in Phase 0 |
| Maintainability | TypeScript strict mode, automated tests, documented ADRs |

## 7. Technology Stack

### 7.1 Chrome extension

| Area | Technology | Purpose |
| --- | --- | --- |
| Platform | Chrome Manifest V3 | Required extension platform |
| Language | TypeScript (strict) | Type safety and maintainability |
| Build | Vite (multi-entry, with `@crxjs/vite-plugin` or equivalent) | Bundle service worker, content scripts, and UI |
| UI (Phase 3) | React + Vite, `chrome.sidePanel` and popup | Session manager interface |
| Request rewriting | `chrome.declarativeNetRequest` session rules with `tabIds` conditions and `modifyHeaders` | Replace the `Cookie` header and remove `Set-Cookie` from responses per tab |
| Response observation | `chrome.webRequest.onHeadersReceived` (non-blocking, `extraHeaders`) | Read `Set-Cookie` values for storage in the session |
| Cookie inspection and cleanup | `chrome.cookies` | Verify and clean the shared jar |
| Tab lifecycle | `chrome.tabs`, `chrome.webNavigation`, `chrome.tabGroups` | Mapping, inheritance, visual grouping |
| Page-world hook | Content script with `world: "MAIN"` | Capture `document.cookie` writes |
| Runtime state | `chrome.storage.session` | Tab-to-session mapping that survives service worker restarts |
| Persistent settings | `chrome.storage.local` | Non-secret settings and session metadata |
| Cryptography | Web Crypto API (AES-256-GCM, PBKDF2 key derivation from a user passphrase) | Encrypt cookies and tokens at rest, in the extension |
| Service worker lifetime | `chrome.alarms` and event-driven design | Avoid reliance on a long-lived background page |

### 7.2 Local test server (Phase 1)

| Area | Technology |
| --- | --- |
| Runtime | Node.js 22 LTS, TypeScript |
| Framework | Fastify |
| Purpose | Deterministic endpoints that report which identity a request carries |
| Container | Docker, Docker Compose |

### 7.3 Local backend (Phase 4, optional)

| Area | Technology | Purpose |
| --- | --- | --- |
| Runtime | Node.js 22 LTS, TypeScript | Same toolchain as the test server |
| Framework | Fastify | Lightweight local API |
| Validation | Zod | Validate every extension-to-backend message |
| Database | SQLite via `better-sqlite3` | Local-first storage |
| Migrations | Plain SQL migration files | Simple, reviewable schema changes |
| Auth | Per-installation bearer secret, `Origin` check for the extension origin | Protect the API from arbitrary websites |
| Container | Docker with a named volume | Persistent encrypted payloads |

The backend stores ciphertext only. Encryption and decryption happen in the extension, so the backend never sees plaintext cookies.

### 7.4 Testing and tooling

| Area | Technology |
| --- | --- |
| Unit tests | Vitest |
| End-to-end multi-tab tests | Playwright with a persistent context loading the unpacked extension |
| Linting and formatting | ESLint, Prettier |
| CI (optional) | GitHub Actions |
| Platform note | Docker images must support arm64 (Apple Silicon) |

## 8. Architecture

```text
+--------------------------- Google Chrome ---------------------------+
|                                                                     |
|  Managed tab A (Session: Customer)   Managed tab B (Session: SP)    |
|          |                                   |                      |
|  +-------v-----------------------------------v------------------+   |
|  |                    SessionWoy Extension                      |   |
|  |                                                              |   |
|  |  UI (popup / side panel)                                     |   |
|  |  Session Manager  <->  Tab Manager (tab -> session map)      |   |
|  |  Cookie Engine: DNR session rules + webRequest observer      |   |
|  |  Page-world hook (document.cookie capture)                   |   |
|  |  Crypto (AES-256-GCM) + chrome.storage                       |   |
|  +----------------------------+---------------------------------+   |
|                               | http://127.0.0.1:3004 (optional)    |
+-------------------------------|-------------------------------------+
                                |
                   +------------v-------------+
                   | Local backend (Docker)   |
                   | Fastify + SQLite volume  |
                   | Ciphertext only          |
                   +--------------------------+

   Test server (Docker): http://localhost:3003  -> used only for POC and CI
```

### 8.1 Request flow (target design, to be validated by the POC)

1. The service worker keeps a map of `tabId -> sessionId`.
2. For each managed tab, the extension installs a DNR session rule scoped by `tabIds` that sets the `Cookie` request header to the session's cookies for that URL.
3. When a response arrives, a non-blocking `webRequest.onHeadersReceived` listener reads `Set-Cookie`, updates the session's cookie store, and updates the DNR rule for later requests.
4. A DNR rule removes `Set-Cookie` from responses for managed tabs so the shared jar is not polluted.
5. A MAIN-world content script intercepts `document.cookie` writes and forwards them to the service worker.

The ordering in steps 3 and 4 (whether the observer sees `Set-Cookie` before DNR removes it) and the timing of rule updates relative to the first request of a navigation are the central unknowns that Phase 2 must answer experimentally.

## 9. Environment and Port Configuration

| Service | Host binding | Container port | Phase |
| --- | --- | --- | --- |
| Test server (container `app`) | `127.0.0.1:3003` | 3003 | 1 |
| Local backend API (container `backend`) | `127.0.0.1:3004` | 3004 | 4 |

- Ports 3000, 3001, and 3002 are reserved for other local development servers and are never used by this project.
- Both ports are configurable through environment variables (`TEST_SERVER_PORT`, `API_PORT`) in `.env` and `docker-compose.yml`.
- Docker publishes ports to host loopback only. Inside the container the server binds to `0.0.0.0`.
- The extension requests host access to `http://localhost:3003/*` for the POC and requests other origins at runtime through `chrome.permissions.request` instead of declaring `<all_urls>` up front.

### 9.1 Suggested Docker Compose (starting point)

```yaml
services:
  app:
    build: ./test-server
    container_name: app
    ports:
      - "127.0.0.1:3003:3003"
    environment:
      PORT: 3003
    restart: unless-stopped

  backend:
    build: ./backend
    container_name: backend
    profiles: ["backend"]
    ports:
      - "127.0.0.1:3004:3004"
    volumes:
      - session_data:/app/data
    environment:
      PORT: 3004
      DATABASE_PATH: /app/data/sessions.sqlite
      API_SECRET: ${API_SECRET}
    restart: unless-stopped

volumes:
  session_data:
```

The `backend` service (container name `backend`) sits behind a Compose profile so it is not started until Phase 4 (`docker compose --profile backend up -d backend`). The test server runs as service and container `app` (source in `test-server/`).

### 9.2 Proposed repository layout

```text
session-woy/
├── extension/          # MV3 extension (TypeScript, Vite)
├── test-server/        # Phase 1 test server (Fastify)
├── backend/            # Phase 4 optional API (Fastify, SQLite)
├── e2e/                # Playwright multi-tab tests
├── docs/adr/           # Architecture decision records
├── docker-compose.yml
└── README.md
```

## 10. Data Model

Session metadata is stored in `chrome.storage.local`. If the backend is enabled, the same schema is mirrored in SQLite.

### 10.1 `sessions`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT (UUID) | Primary key |
| `name` | TEXT | User-visible name |
| `color` | TEXT | UI color |
| `status` | TEXT | `active` or `archived` |
| `created_at`, `updated_at` | DATETIME | Timestamps |

### 10.2 `tab_assignments` (runtime, `chrome.storage.session`)

| Field | Type | Notes |
| --- | --- | --- |
| `tab_id` | INTEGER | Runtime identifier, not durable across restarts |
| `session_id` | TEXT | Reference to `sessions.id` |
| `marker` | TEXT | Tab marker used to restore mappings after restart |

Chrome tab IDs are not stable across browser restarts, so restoration uses the marker and URL rather than the ID.

### 10.3 `session_vault`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER | Primary key |
| `session_id` | TEXT | Foreign key |
| `origin` | TEXT | Website origin |
| `payload_ciphertext` | BLOB | Encrypted cookie payload |
| `nonce` | BLOB | AES-GCM nonce |
| `key_version` | INTEGER | Supports key rotation |
| `updated_at` | DATETIME | Last update |

Raw cookies and tokens are never written unencrypted to SQLite, `chrome.storage.local`, logs, or export files.

## 11. Delivery Plan

### Phase 0 — Research and acceptance criteria (about 0.5 day)

- Fix the target Chrome version.
- Select two or three real test websites (one simple login site, one SPA).
- Define "session" as one cookie set per tab-session; other storage is documented as a limitation.
- Write the first ADR and the POC test matrix.

Exit criteria: written acceptance criteria and a list of supported and unsupported behaviors.

### Phase 1 — Test server in Docker (about 0.5 day)

- Build the Fastify test server on port 3003 with `/login?user=`, `/whoami`, `/set-cookie`, `/redirect`, and `/parallel`.
- `/whoami` reports the identity carried by the received cookie, so any leak is visible.

Exit criteria: `docker compose up` serves reproducible endpoints on `127.0.0.1:3003`.

### Phase 2 — Cookie virtualization POC, go/no-go gate (1 to 2 weeks)

- Build a minimal extension with a hard-coded two-tab mapping.
- Validate the open questions: DNR rule timing, observation of `Set-Cookie` before removal, Service Worker requests (which carry no tab ID), `document.cookie` capture, redirects, and subresources.
- Run automated Playwright tests on the test server and manual tests on the selected real sites.

Exit criteria (go): all scenarios in Section 12 pass; session A and session B stay distinct under concurrent requests and reloads; no unexplained leakage. Exit criteria (no-go): stop, record the findings in an ADR, and move to the fallback in Section 14.

### Phase 3 — Session manager UI (3 to 5 days, only after a go)

- Popup and side panel: create, rename, recolor, delete, reset sessions.
- Assign the active tab, open a tab in a session, show a session badge, handle tab close and navigation events.

### Phase 4 — Persistence and local backend (optional)

- Encrypted storage in the extension first.
- Fastify and SQLite backend on port 3004 with a Docker volume, encrypted vault storage, health check, and connection status.
- Encrypted export and import.
- Defined reduced mode when the backend is offline.

### Phase 5 — Web storage compatibility and reliability

- Compatibility matrix for localStorage, sessionStorage, IndexedDB, CacheStorage, Service Workers, iframes, and OAuth popups.
- Service worker suspension, restart, tab duplication, downloads, and memory/performance testing.
- Known limitations document and manual regression checklist.

### Phase 6 — Optional enhancements

Session templates (Customer, SP, Admin, QA), per-origin session assignment, keyboard shortcuts, tab grouping by session, and an optional native companion if extension APIs prove insufficient.

## 12. Test Plan

| Scenario | Expected result |
| --- | --- |
| Two tabs, same origin, different sessions | Each tab receives its own identity from `/whoami` |
| Parallel requests from both tabs | No cross-contamination (stress test of thousands of requests) |
| Response sets a new cookie | Stored in the correct session only; shared jar unchanged |
| Cookie set through `document.cookie` | Captured into the correct session |
| Page reload | Same identity |
| Redirect chain | Same identity at every hop |
| Link opened in a new tab | Follows the documented inheritance rule |
| Tab duplication | Explicit, predictable behavior |
| Chrome restart | Session data restored; mappings restored or reported as unmatched |
| Extension service worker restart | Mapping recovered automatically |
| Unmanaged tab | Behavior identical to normal Chrome |
| Cookie expiry and deletion | Honored per session |
| Real third-party sites | Login persists per tab; failures recorded in the compatibility matrix |

## 13. Security and Privacy

- All data stays on the local machine by default; no telemetry.
- Request the minimum permissions; request host access per origin at runtime.
- Encrypt cookies and tokens at rest with AES-256-GCM; the key derives from a user passphrase.
- Never log secrets or include them in diagnostics.
- Bind the backend to loopback only, validate `Origin` and `Host`, require a per-installation secret, and never expose the port to the LAN.
- Validate every message between the extension and backend with a schema.
- Provide a clear "delete session and all data" action.
- Treat exported backups as highly sensitive.
- The tool must not be used to bypass access controls, account restrictions, or terms of service.
- Because the extension handles live session cookies, a compromised extension is equivalent to account compromise; dependencies are kept minimal and pinned.

## 14. Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| MV3 cannot reliably virtualize response cookies | Critical | Phase 2 go/no-go gate before building features |
| DNR rule update arrives after the first request of a navigation | High | Timing tests; update rules ahead of navigation; evaluate pre-navigation hooks |
| `Set-Cookie` removed before it can be observed | High | Verify ordering in the POC; alternatives are tested before the gate decision |
| Shared localStorage, IndexedDB, Service Worker state | High | Document as a limitation; evaluate the page-world bridge for limited cases |
| Concurrent request race conditions | High | Dedicated stress tests |
| OAuth and popup flows | Medium/High | Explicit flow tests; documented inheritance rules |
| Broad host permissions | Medium | Runtime per-origin permission requests |
| Backend unavailable | Medium | Reduced mode with clear status |
| Sensitive data exposure | Critical | Encryption, least privilege, no secret logging |

### 14.1 Fallback if the POC fails

1. **Containerized Chrome:** run Chrome in Docker with one profile per session and access it through noVNC or KasmVNC. Isolation is real because profiles are separate; the cost is performance and a less native experience.
2. **Separate local profiles:** a small launcher that opens Chrome with distinct `--user-data-dir` profiles per session.

## 15. Success Metrics and Definition of Done

The MVP is complete only when all of the following are true:

- At least two named sessions can be created.
- Two tabs access the same test origin concurrently, and each consistently receives its intended identity.
- A response cookie update in one session never overwrites the other session.
- Reload, redirects, and supported navigation preserve identity.
- Session data persists across browser restarts.
- An ordinary Chrome tab is unaffected.
- At least two real third-party sites pass the login-persistence test, with failures recorded.
- Known limitations are documented, and no claim of full browser-profile isolation is made unless tests prove it.

## 16. Open Questions

- Which exact Chrome version is the baseline?
- Which real websites will be used as the standard compatibility set?
- Is a passphrase prompt acceptable at browser start, or should the key be stored in the OS keychain through a native companion?
- Should new tabs opened from a managed tab inherit the session by default?
- Is the optional backend needed at all if encrypted extension storage proves sufficient?

## 17. Official References

- Chrome `declarativeNetRequest`: https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest
- Chrome `webRequest`: https://developer.chrome.com/docs/extensions/reference/api/webRequest
- Chrome Cookies API: https://developer.chrome.com/docs/extensions/reference/api/cookies
- Chrome Tabs API: https://developer.chrome.com/docs/extensions/reference/api/tabs
- Chrome Storage API: https://developer.chrome.com/docs/extensions/reference/api/storage
- Chrome content scripts: https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts
- Chrome extension permissions: https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions

## Appendix A. Getting Started

This appendix covers Phase 0 and Phase 1 and prepares the ground for the Phase 2 proof of concept. The order is deliberate: the test server comes before the extension, because the extension's behavior can only be judged against an endpoint that reports exactly which identity each request carried.

### A.1 Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| macOS on Apple Silicon | Current | Primary target platform |
| Google Chrome | Latest stable (record the exact version from `chrome://version`) | The extension targets one fixed Chrome version |
| Node.js | 22 LTS (install through `nvm` or `fnm`) | Extension build, test server, backend |
| Docker Desktop | Current, arm64 | Runs the test server and the optional backend |
| Git | Current | Version control |

### A.2 Step-by-step

1. **Create the repository and folders.** A fixed layout up front keeps the extension, test server, and tests from drifting apart.

   ```bash
   mkdir session-woy && cd session-woy
   git init
   mkdir -p extension test-server backend e2e docs/adr
   ```
2. **Create the environment file.** Ports and the API secret live in `.env`, never in source code. Add `.env` to `.gitignore` before the first commit so the secret cannot leak.

   ```bash
   cat > .env <<EOF
   TEST_SERVER_PORT=3003
   API_PORT=3004
   API_SECRET=$(openssl rand -hex 32)
   EOF
   echo ".env" >> .gitignore
   ```
3. **Finish Phase 0 on paper.** Write `docs/adr/0001-cookie-swapping.md` with the decision to use cookie swapping, the exact Chrome version, the two or three real test websites, the definition of a session (one cookie set per tab-session), and the go/no-go criteria from Section 11. Writing the criteria before any code exists prevents moving the goalposts after a disappointing result.
4. **Build the test server (Phase 1).** Scaffold a small Fastify project in `test-server/` with these endpoints:

   | Endpoint | Behavior |
   | --- | --- |
   | `/login?user=customer` | Sets a session cookie identifying the user, then redirects to `/whoami` |
   | `/whoami` | Returns JSON with the identity found in the received cookie, or `anonymous` |
   | `/set-cookie` | Sets a new cookie so response-cookie capture can be tested |
   | `/redirect` | Redirects through several hops while keeping the cookie |
   | `/parallel` | Returns the identity with a delay, so concurrent requests can be compared |
5. **Add the Dockerfile and Compose file.** Use the Compose service from Section 9.1, publishing `127.0.0.1:3003:3003` only, so the server is never reachable from the LAN. Then start it:

   ```bash
   docker compose up --build app
   ```
6. **Verify the test server with curl.** Two different logins must produce two different identities:

   ```bash
   curl -s -c customer.jar -L "http://127.0.0.1:3003/login?user=customer"
   curl -s -c provider.jar -L "http://127.0.0.1:3003/login?user=provider"
   curl -s -b customer.jar http://127.0.0.1:3003/whoami
   curl -s -b provider.jar http://127.0.0.1:3003/whoami
   ```

   The last two commands must report `customer` and `provider` respectively. Delete the `.jar` files afterwards, since they contain session cookies.
7. **Create the extension skeleton.** Scaffold a TypeScript project in `extension/` with Vite and add a Manifest V3 file declaring the permissions from Section 7.1 (`declarativeNetRequest`, `declarativeNetRequestWithHostAccess`, `webRequest`, `cookies`, `tabs`, `webNavigation`, `storage`, `alarms`) and the host permission `http://localhost:3003/*`. Keep host access narrow at this stage; broader origins are requested at runtime later.
8. **Load the extension in Chrome.** Open `chrome://extensions`, enable Developer mode, choose Load unpacked, and select the extension's build output folder (for example `extension/dist`). Reload the extension after each build.
9. **Run the first POC experiment.** Hard-code two tab-to-session mappings, open `http://localhost:3003` in two tabs, log in as `customer` in one and `provider` in the other, and call `/whoami` from both. Distinct identities in both tabs is the first signal that the approach can work; a leak or a shared identity is an early no-go signal worth recording immediately.
10. **Automate the checks.** Add Playwright to `e2e/` (using a persistent context that loads the unpacked extension) and turn the scenarios from Section 12 into repeatable tests, starting with the parallel-request stress test.
11. **Record the decision.** Write `docs/adr/0002-poc-result.md` with the test results and the go/no-go verdict. Only a go opens Phase 3 (UI) and Phase 4 (backend); a no-go moves the project to the fallback in Section 14.1.

### A.3 Readiness checklist for Phase 2

- [ ] Node.js 22, Docker Desktop, and Chrome are installed and the Chrome version is recorded
- [ ] Repository and folder layout are created, and `.env` is ignored by Git
- [ ] ADR 0001 is written with the go/no-go criteria
- [ ] Test server runs on `127.0.0.1:3003` and passes the curl verification
- [ ] Extension skeleton loads in Chrome without errors
- [ ] Two real test websites are chosen for the compatibility check

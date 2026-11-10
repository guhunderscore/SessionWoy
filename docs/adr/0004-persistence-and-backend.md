# ADR 0004 — Encrypted persistence, backup, tab restore and local backend (Phase 4)

- Status: Accepted (automated suite and manual check in Chrome 157 passed, 2026-11-10)
- Date: 2026-11-10
- Depends on: ADR 0002 (limitation 8: logins lost on restart), ADR 0003 (UI)
- Requirements: PRD FR-15 … FR-21, §7.3, §10.3, §13

## Context

Until Phase 3, session cookies lived only in `chrome.storage.session`, so every browser restart or
extension reload logged every session out, and restored tabs lost their session. The PRD asks for
encrypted persistence (FR-15), tab restore after a browser restart (FR-17), encrypted backup files
(FR-19) and an optional local backend with status and a reduced mode (FR-18, FR-20, FR-21).

User decisions (2026-11-10): build the extension part **and** the backend; the key comes from a
**passphrase entered once per Chrome start**; **restore tab sessions** after a restart.

Delivered as four slices: 4a vault, 4b backup, 4c tab restore, 4d backend.

## D1 — Crypto (`extension/src/shared/crypto.ts`)
- PBKDF2-SHA-256, **600,000 iterations**, random 16-byte salt → 256-bit key (Web Crypto).
- AES-256-GCM, random 12-byte IV per encryption; the GCM tag rejects wrong keys and tampering.
- A sealed constant ("check") tells a wrong passphrase apart without touching data.
- Minimum passphrase length 8. Passphrases, keys and plaintext cookies are never written to disk,
  logs, diagnostics or the UI.

## D2 — Vault in the extension (FR-15, `background/vault.ts`)
- Durable record `sessionwoy:vault:v1` in `chrome.storage.local`:
  `{ v, kdf, keyVersion, check, sessions: { [sessionId]: { iv, ct, updatedAt } } }`.
- **One ciphertext per session** (its whole cookie jar), not per origin as PRD §10.3 sketched: fewer
  records, and it does not reveal which sites a session uses.
- States: `none` (no passphrase; Phase 3 behavior, memory only) → `locked` → `unlocked`.
- **Key lifetime:** after unlock the raw key bytes are kept in `chrome.storage.session` (memory only,
  cleared at browser restart and extension reload, unreadable by content scripts), so a suspended
  service worker resumes unlocked (FR-16). Trade-off: while Chrome runs unlocked, the key is in that
  process's memory (as are the cookies themselves).
- **While locked**, session tabs run logged out: never with Chrome's shared cookies. Cookies captured
  while locked are kept in memory and merged on unlock (`mergeCookies`, memory wins).
- **Saving:** every jar change marks its session dirty; a 500 ms debounced task encrypts and writes
  (plus a per-minute backstop). Delete removes the ciphertext even while locked.
- **Lock now** saves, drops the key and logs every session tab out. **Change passphrase** re-encrypts
  everything with a new salt and bumps `keyVersion`. **Forget saved logins** wipes the vault (for a
  lost passphrase); in-memory logins keep working until Chrome closes.
- UI: popup "Saved logins are locked" banner with unlock; side panel **Security** section.

## D3 — Backup file (FR-19, `shared/backup.ts`)
- `{ format: 'sessionwoy-backup', v: 1, exportedAt, kdf, iv, ct }`. The ciphertext holds session
  metadata **and** cookies (even names are encrypted), under a passphrase chosen at export time with
  its own salt. Settings are not included.
- Export needs the vault unlocked (or no passphrase); download via a Blob link (no `downloads`
  permission). Import first **previews** (sessions, cookie counts, new/replaces), then applies; the same
  session id is replaced. Invalid sessions or cookies in a file are dropped.

## D4 — Tab restore after a browser restart (FR-17, `background/restore.ts`)
- Each session tab gets a random **marker**, kept by the content script in the page's
  `sessionStorage` (`__sessionwoy_tab`, top frame), which Chrome restores with restored tabs. The worker
  keeps a durable list `marker → { sessionId, origin }` in `chrome.storage.local` (no secrets).
- A **restore window (90 s)** opens when the worker starts with empty session memory (browser start
  or extension reload), as the **first queued task**. An earlier design used `runtime.onStartup`, but a
  restored tab could report its marker before that event was handled and lose it.
- A restored tab reports its marker once; it rejoins its session only if the window is open, the
  marker is listed and unclaimed, the request comes from the top frame, and the origin matches. Then
  the tab is reloaded with the session's cookies (locked vault: logged out until unlock).
- Closing a tab or removing it from its session forgets its marker; closing the window (quitting
  Chrome) keeps it. When the window ends, unclaimed entries are dropped and counted; the popup and side
  panel say how many tabs could not be restored (dismissable).
- Limits: a tab can only report from a site SessionWoy has access to (a tab left on another site is
  "not restored"); the marker is readable by the page itself, which could replay it only inside the
  next restore window, only from the same origin, and only once.

## D5 — Local backend (FR-18, FR-21; `backend/`, Docker service and container `backend`)
- Node 22, Fastify, Zod, better-sqlite3; plain SQL migrations (`migrations/001_init.sql`); Docker
  image on `node:22-bookworm-slim` (native module on arm64), non-root, healthcheck, volume
  `session_data`, published on `127.0.0.1:${API_PORT:-3004}` only.
- **Ciphertext only:** `vault_header` (KDF params + check), `session_vault` (one payload per session,
  `origin = '*'`), `sessions` (name/color/status mirror, PRD §10.1).
- API: `GET /health` (no secret), `GET /v1/vault`, `PUT /v1/vault/header` (a new key version drops
  payloads under the old key), `PUT|DELETE /v1/vault/sessions/:id`, `DELETE /v1/vault`, `PUT /v1/sessions`.
- Security (PRD §13): bearer `API_SECRET` (≥ 32 chars, constant-time compare); `Host` must be an
  allowed loopback host (421 otherwise); any `Origin` that is not `chrome-extension://…` is refused (403;
  `BACKEND_ALLOWED_ORIGINS` can pin the extension id); every body validated by Zod with size limits;
  no request bodies or secrets logged; errors ≥ 500 never echo details.
- Extension side (`background/backend.ts`): URL limited to `http://127.0.0.1|localhost:<port>`;
  connecting asks for host access to that URL in the same click; the secret is stored in
  `chrome.storage.local` and never sent to the UI. Changes (new ciphertexts, deletes, header, session
  list) are queued and pushed debounced.
- **Never overwrite another device's vault:** before its first push in a worker lifetime, the
  extension reads the backend; if the backend's KDF salt matches neither the local vault nor the header
  this device last pushed, nothing is sent (`remoteDiffers`) until the user chooses **Restore from
  backend** (adopts that vault with its passphrase) or **Replace backend with this device** (wipe, then
  push). Found by S26: the first version let a fresh device overwrite the backend's session list.
- **Status (FR-21):** connected / offline (with reason) / checking, shown in the side panel header and
  section and in the popup; health is checked every minute.

## D6 — Reduced mode (FR-20)
If the backend is unreachable nothing is blocked: the local encrypted vault keeps working, pending
changes are stored durably (survive worker restarts) and retried every minute, and the UI shows
"offline · N changes waiting". The backend is never contacted from `init()`, so a dead backend cannot
delay startup.

## D7 — Test setup
- e2e relaunches Chromium with the **same profile directory** to simulate a real browser restart
  (`launchBrowser(dir)`), and uses `--restore-last-session` for FR-17.
- Backend tests run a **private backend process** (port 3014, temp SQLite, random secret) so they never
  touch the user's `backend` container. The e2e build pre-grants `http://127.0.0.1/*` because Playwright
  cannot click Chrome's permission prompt; the release build does not (verified).

## Results (2026-11-10)

| Check | Result |
| --- | --- |
| Unit tests | ✅ extension 57 (crypto 7, vault 7, backup 4, restore 3, backend sync 6, …), test server 9, backend 8 |
| Typecheck (151 files), ESLint | ✅ 0 errors |
| S22 restart: locked until unlock, ciphertext only on disk, wrong passphrase rejected, login back after unlock | ✅ |
| S23 lock now, change passphrase, forget saved logins | ✅ |
| S24 export, replace-import, delete + import, wrong passphrase / foreign file rejected, real download from the side panel | ✅ |
| S25 restart with `--restore-last-session`: restored tab rejoins its session, unlock logs it in, unreachable tab reported then dismissed | ✅ |
| S26 backend holds ciphertext only; secret never in UI state; fresh profile does not overwrite and restores with the passphrase | ✅ |
| S27 backend down: offline status, local saving continues, queue flushes when it is back | ✅ |
| Persistence scenarios repeated (5× and 3×) | ✅ stable |
| Full suite S1–S27, twice | ✅ 27/27 twice |
| Backend container: health 200; no secret 401; website Origin 403; foreign Host 421 | ✅ |
| Release build: no debug API, no loopback pre-grant | ✅ |
| Manual check in Chrome 157 (user): restart + unlock, tab restore, backup export/import, backend connected → offline → back | ✅ all passed |

Also fixed on the way: S7 called `fetch()` inside a duplicated tab that the extension reloads by design
(F6); the test now navigates fresh.

## Consequences / still open
- Logins now survive restarts behind a passphrase; without one, Phase 3 behavior remains (memory only).
- Losing the passphrase loses saved logins (by design); sessions themselves remain.
- Multi-device use of one backend works as "one owner + explicit restore/replace", not live sync
  (PRD §2.2 non-goal).
- Still open from ADR 0002: site Service Workers (limitation 1) and shared web storage (limitation 4),
  for Phase 5.

# ADR 0001 — Per-tab sessions by cookie swapping (Phase 0)

- Status: Accepted (for the Phase 2 proof of concept)
- Date: 2026-11-09
- Context document: `SessionWoy — PRD.md`

## Context

Chrome has one cookie jar per profile. Extensions get no per-tab cookie store. To run several
logins to the same site side by side in one window, SessionWoy has to *simulate* separation.
Because the target is "any website", the approach is gated by a go/no-go POC (PRD §11, Phase 2).

## Decision

Isolate sessions in the extension by swapping cookies:

1. The service worker keeps `tabId → sessionId` and one RFC 6265 cookie jar per session.
2. For each session, `declarativeNetRequest` **session rules** scoped by `tabIds`:
   - a catch-all rule that removes `Cookie` from requests and `Set-Cookie` from responses
     (the shared jar is never read or written by managed tabs);
   - higher-priority rules (`regexFilter` per host / cookie path / scheme) that **set** the
     `Cookie` header to the session's cookies.
3. `webRequest.onHeadersReceived` (non-blocking, `extraHeaders`) reads `Set-Cookie` into the session jar.
4. A MAIN-world content script virtualizes `document.cookie`.

Docker and the database play no part in isolation. Docker only hosts the deterministic test
server (Phase 1, `127.0.0.1:3003`).

## Baseline and scope

| Item | Value |
| --- | --- |
| Chrome baseline | Google Chrome stable **157.0.8103.39** (macOS, Apple Silicon) |
| Automated test browser | Playwright's bundled Chromium (branded Chrome does not accept `--load-extension`); exact version recorded in ADR 0002 |
| Definition of "session" | One cookie set per tab-session. localStorage, sessionStorage, IndexedDB, CacheStorage and site Service Workers stay **shared per origin** (documented limitation) |
| Real test websites | **Open:** to be chosen by the team (one simple login site + one SPA). See ADR 0002 |

## Go/no-go criteria (fixed before writing code)

**GO** requires all of the following on the test server, automated:

| # | Criterion | PRD §12 scenario |
| --- | --- | --- |
| G1 | Two tabs, same origin, different sessions → each `/whoami` returns its own identity | Two tabs |
| G2 | ≥ 10,000 concurrent requests across two sessions with zero cross-session identities | Parallel requests |
| G3 | Response `Set-Cookie` lands only in the right session; shared jar unchanged | Response sets cookie |
| G4 | `document.cookie` writes captured into the right session | document.cookie |
| G5 | Reload and every redirect hop keep the identity | Reload / redirect |
| G6 | New tab from a link, and duplicated tab, follow the documented inheritance rule | Link / duplication |
| G7 | Extension service worker restart → mappings recovered without user action | SW restart |
| G8 | Unmanaged tab behaves exactly like normal Chrome | Unmanaged tab |
| G9 | Max-Age=0 deletion and expiry honored per session | Expiry |
| G10 | Added latency < 5 ms at p95 | NFR performance |

**NO-GO** if any of G1–G3 or G5 cannot be met without unexplained leakage. In that case, stop and
move to the fallback in PRD §14.1 (containerized Chrome or separate `--user-data-dir` profiles).

Real-site checks (PRD §12, last row) are required before Phase 3 starts, but they are recorded
as a compatibility matrix rather than a hard gate, because some sites will legitimately fail.

## Consequences

- Site Service Worker requests (`tabId = -1`) cannot be attributed to a tab. Expected limitation.
- Host access is needed per origin. The POC declares only `localhost:3003`; other origins are
  requested at runtime (`optional_host_permissions`).
- Results and the verdict go in ADR 0002.

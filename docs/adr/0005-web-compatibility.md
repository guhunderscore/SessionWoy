# ADR 0005 — Web compatibility: Service Workers, iframes, OAuth popups, downloads, web storage (Phase 5)

- Status: In progress (Phase 5 part 1 implemented and tested automatically; manual check and the reliability part still open)
- Date: 2026-11-11
- Depends on: ADR 0002 (limitations 1, 2 and 4), ADR 0003, ADR 0004
- Requirements: PRD §11 Phase 5, FR-11, FR-14

## Context

ADR 0002 left the riskiest real-site patterns untested: site Service Workers (limitation 1),
iframe navigations (limitation 2: healing was top-level only) and web storage (limitation 4). Phase 5
asks for a compatibility matrix covering localStorage, sessionStorage, IndexedDB, CacheStorage,
Service Workers, iframes and OAuth popups.

The test server gained deterministic stand-ins for these patterns (`test-server/src/compat.ts`).
`localhost:3003` and `127.0.0.1:3003` are two different _sites_, so one plays the app and the other
the third party:

| Route                                                 | Stands in for                                                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/sw/`, `/sw/sw.js`, `/sw/whoami`                     | A site whose Service Worker proxies every fetch (pass-through)                                           |
| `/frame`, `/frame/inner`, `/frame/login`              | An app page framing a third-party site that logs in with a `SameSite=None; Secure` cookie behind a `302` |
| `/oauth/start`, `/oauth/authorize`, `/oauth/callback` | "Sign in with …" popup: provider cookie on its site, code back to the app, `postMessage` to the opener   |
| `/download`                                           | An attachment whose body is the identity the request carried                                             |

## Findings

**F9 — A site Service Worker breaks isolation in both directions (2026-11-11).** Requests a page's
Service Worker makes have no tab id (`tabId = -1`), so the tab-scoped DNR rules never apply and
`webRequest` capture ignores them. Once a page is controlled, **every** fetch from it goes through the
worker, not only those inside the worker's scope, and so do navigations inside the scope. Measured:

- In a session tab controlled by the worker, `/whoami` (inside and outside the scope) answered
  `anonymous` instead of the session's `customer`: the session's cookies were not sent.
- A login (`fetch('/login?user=swuser')`) in that session tab put `sid` into **Chrome's shared jar**,
  and a normal tab was then logged in as `swuser`. This is a leak from a session into normal Chrome,
  not only "not isolated".

**F10 — The redirect race (F3) also hits iframes.** A third-party login inside an iframe (`302` +
`Set-Cookie`, then `GET /frame/inner`) stored the cookie in the right session, but the redirect hop
left with the old cookies, so the frame showed `anonymous` until it was reloaded. A first fix
navigated the frame as soon as the stale hop was detected; it failed 1 run in 5 because the
`location.replace` sometimes ran in the outgoing document and was lost when the stale document committed.

## Decisions

### D1 — No site Service Workers in session frames (fixes F9; user decision 2026-11-11)

Options offered: disable Service Workers in session tabs, only warn (red badge, leak stays), or a
setting. The user chose **disable**. In `content/main.ts` (MAIN world, every frame with host access):

- `ServiceWorkerContainer.prototype.register` is wrapped. In a session frame it rejects with a
  `SecurityError` ("Service Workers are disabled in SessionWoy session tabs"). While the frame's state is
  still unknown (first document of an origin), the call waits for the answer, at most 3 s; after that,
  unmanaged frames get the native behavior, so normal tabs never break.
- When a frame turns out to be in a session, every registration of its origin is **unregistered**. If the
  document itself was loaded through the worker (`navigator.serviceWorker.controller`), it is reloaded
  once, now directly. Loop guard: one reload per 10 s per frame (`__sessionwoy_sw_reload` in
  `sessionStorage`); with storage disabled there is no reload.
- Counted in diagnostics as `swBlocked` and `swUnregistered` (no URLs, no cookie data).

Consequences:

- Offline mode, push notifications and background sync of that site do not work in session tabs.
- Unregistering is per origin, so **normal tabs of that site lose its worker too** until the site
  registers it again (usually on the next visit). Caches the worker filled (CacheStorage) stay, unused.
- Residual leak window: the **first** load of a session tab on an origin whose worker is already
  installed still goes through the worker (shared jar) until the reload. A `Set-Cookie` on exactly that
  response lands in Chrome's shared jar. Same class as the `document.cookie` first-document window
  (ADR 0002 limitation 3).
- Other tab-less requests (SharedWorker, `navigator.sendBeacon` after unload, extensions) are still
  not isolated.

### D2 — Heal stale iframe navigations after they commit (fixes F10)

- `onSendHeaders`: a stale `sub_frame` GET marks its frame (`"<tabId>:<frameId>"`); a later hop of the
  same navigation that is fresh clears the mark.
- `webNavigation.onCommitted` for a marked frame queues `heal()` behind the rule update. The heal runs
  `location.replace(url)` inside that frame (`chrome.scripting.executeScript` with its `frameId`), i.e.
  in the stale document that just committed, so nothing can race it.
- As for tabs (F3): the stale response's `Set-Cookie` is discarded, the loop guard allows 2 re-issues per
  frame and URL per 5 s, and successes count in `healed` and `healedFrames`.
- Needs host access to the frame's document; without it the heal is skipped (`healSkipped`) and the frame
  keeps the stale load, which is limitation 7 anyway.

## Compatibility matrix (test server, Chromium 158, automated)

| Pattern                                                                  | Before Phase 5                                                                                     | Now                                           | Scenario |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------- |
| Cross-site iframe login (`SameSite=None`, `302`)                         | ⚠️ cookie stored correctly, frame stale until reload                                               | ✅ healed in the frame                        | S28      |
| OAuth popup between two sites                                            | ✅ popup inherits the opener's session (F4/F6 rule), provider and app cookies in that session only | ✅ unchanged                                  | S29      |
| Site Service Worker registered in a session tab                          | ❌ all fetches used the shared jar                                                                 | ✅ registration refused, session cookies sent | S30      |
| Site Service Worker installed by a normal tab, then a session tab visits | ❌ session login leaked into normal tabs                                                           | ✅ worker removed, page reloaded, no leak     | S31      |
| Download (`Content-Disposition: attachment`)                             | ✅ carries the session identity                                                                    | ✅ unchanged                                  | S32      |
| `sessionStorage`                                                         | per tab (browser behavior); a duplicated tab gets a copy                                           | unchanged                                     | S33      |
| `localStorage`                                                           | ⚠️ shared per origin across sessions                                                               | unchanged (limitation 4)                      | S33      |
| IndexedDB                                                                | ⚠️ shared per origin across sessions                                                               | unchanged (limitation 4)                      | S33      |
| CacheStorage                                                             | ⚠️ shared per origin; filled mainly by Service Workers, which D1 keeps out of session tabs         | unchanged                                     | —        |

S33 pins the current web storage behavior on purpose, so a future change (e.g. storage isolation) shows
up as a deliberate test update.

## Results (2026-11-11)

| Check                                | Result                                                    |
| ------------------------------------ | --------------------------------------------------------- |
| Unit tests                           | ✅ test server 13 (4 new compat), extension 57, backend 8 |
| Typecheck, ESLint                    | ✅ 0 errors                                               |
| S28 repeated 10× after the D2 change | ✅ 10/10                                                  |
| Full suite S1–S33, twice             | ✅ 33/33 twice                                            |

## Still open in Phase 5

- Manual check in branded Chrome: a real site with a Service Worker (PWA), a real "Sign in with …"
  popup, and a real embedded third-party login.
- Reliability part of PRD §11 Phase 5: memory and performance with many tabs and sessions over time.
- Final known-limitations document and a manual regression checklist.
- Decide whether `localStorage` / IndexedDB isolation is in scope (it would need per-session key
  prefixing or origin rewriting; not attempted).

# ADR 0002 — Phase 2 POC result: cookie virtualization

- Status: **GO** (2026-11-10: automated gate met; branded Chrome 157 check passed; real sites `localhost:3000` and `saucedemo.com` passed)
- Date: 2026-11-09
- Depends on: ADR 0001

## Test setup

| Item | Value |
| --- | --- |
| Test server | `test-server/` (Fastify) in Docker, `127.0.0.1:3003`, verified with `scripts/verify-test-server.sh` |
| Extension | `extension/dist` (MV3, esbuild), hard-coded sessions A/B/C |
| Automation | Playwright 1.65, persistent context, bundled **Chromium 158.0.8127.18** (macOS arm64), headless |
| Suite | `e2e/tests/poc.spec.ts`, 15 scenarios (S15 added 2026-11-10); 3 consecutive full runs green; S2 also run with `STRESS_N=10000` |

## Results

| # | Scenario | Result |
| --- | --- | --- |
| S1 | Two tabs, same origin, different sessions | ✅ distinct identities, shared jar empty |
| S2 | Parallel stress, 10,000 requests/tab × 2 tabs + 400 interleaved `Set-Cookie` churns | ✅ 0 leaks (≈11 s) |
| S3 | Response cookie → correct session only, shared jar unchanged | ✅ |
| S4 | `document.cookie` write captured; HttpOnly hidden; other session unaffected | ✅ |
| S5 | Reload + 4-hop redirect chain, identity at every hop | ✅ |
| S6 | Link with `target=_blank` inherits session | ✅ |
| S7 | `chrome.tabs.duplicate` inherits session | ✅ |
| S8 | Unmanaged tab = normal Chrome; does not affect managed tabs | ✅ |
| S9 | Max-Age=0 deletion and 2 s expiry, per session | ✅ |
| S10 | Extension SW stopped (CDP `ServiceWorker.stopAllWorkers`) → mappings restored, capture continues | ✅ |
| S11 | First navigation right after assignment / "open tab in session" | ✅ |
| S12 | Login `302` with `Set-Cookie` → immediate follow-up hop (20 iterations) | ✅ after healing (see finding F3) |
| S13 | `webRequest` sees `Set-Cookie` that DNR removes | ✅ 21/21 observed |
| S14 | Latency, managed vs unmanaged, 400 sequential requests, ~30 cookies | ✅ p95 1.0 ms vs 1.1 ms (no measurable overhead) |
| S15 | Link-opened tab from session A while a session-B tab (the active tab) shows the same URL | ✅ inherits A via the link signal; no B decision applied (F6 regression) |

DNR rule update (`updateSessionRules`): average ≈ 0.3–5 ms, max ≈ 19 ms (cold start).

## Findings (answers to the PRD §8.1 open questions)

**F1 — Ordering of `Set-Cookie` observation vs DNR removal.** `webRequest.onHeadersReceived`
with `extraHeaders` receives the **original** `Set-Cookie` even though a DNR rule removes it from
the response. Capture and stripping work together.

**F2 — DNR rules must list `resourceTypes` explicitly.** A rule without `resourceTypes` /
`excludedResourceTypes` matches everything **except `main_frame`**. In the first run, navigation
requests therefore used the shared jar and navigation `Set-Cookie` leaked into it. All rules now
list every resource type. Covered by a unit test that emulates the DNR default.

**F3 — The redirect race is real and happens every time.** After a `302 + Set-Cookie`, Chrome
follows the redirect *before* `updateSessionRules()` resolves. In 20/20 cases the next hop carried
the old cookies. Mitigation, now implemented:
- `webRequest.onSendHeaders` reports the Cookie header **after** DNR modification (verified).
- The in-memory jar is updated **synchronously** in `onHeadersReceived`, so between that moment
  and the rule update, "sent header ≠ jar header" identifies exactly the stale requests.
- A stale `main_frame` GET is **re-issued** (`tabs.update`) after the rule update (FIFO queue),
  and its `Set-Cookie` is discarded so it cannot overwrite the fresh login. Loop guard: 2 per URL / 5 s.
- Result: 20/20 stale hops detected and healed. The user may see a fast double load.

**F4 — `openerTabId` is not a usable inheritance signal.** Chrome sets it on unrelated new tabs
(Playwright `newPage()` here, and Ctrl+T next to an active tab), which made an unmanaged tab join
a session. Inheritance now uses `webNavigation.onCreatedNavigationTarget` (links, `window.open`)
plus duplicates (new tab whose initial URL equals its opener's URL).

**F5 — DNR session rules survive the extension service worker.** Isolation keeps working while the
worker is stopped. On wake-up, state is rehydrated from `chrome.storage.session` and all rules are
replaced in **one atomic** `updateSessionRules` call (no unprotected window). The staleness check
is deferred until rehydration on cold starts.

**F6 — The duplicate heuristic could override the link signal (found on a real site, 2026-11-10).**
On `localhost:3000`, a Cmd+click in a session-A tab opened a tab that joined **session B**. A session-B
tab was open at exactly the link's target URL. Three controlled repeats (unique URL, same URL, session-B
tab active) all inherited A correctly, so the trigger could not be reproduced, and the event had not
been logged. The only code path able to produce it was the duplicate heuristic (`tabs.onCreated` +
"URL equals opener's URL"): it ran independently of `onCreatedNavigationTarget`, finished later, and
**overrode** it whenever Chrome reported a different opener. Fix:
- `onCreatedNavigationTarget` (links, `window.open`) is authoritative and marks the tab.
- The duplicate heuristic is a fallback only: it waits 300 ms, skips link-created tabs, never overrides
  an existing assignment, and reloads the tab after assigning it (it may have loaded with the shared jar).
- Every decision goes to `diag.inheritLog` (last 20; via, source tab, new tab, session, applied/reason),
  visible in the popup's Diagnostics, so a future case can be explained.
- Regression scenario **S15**.

## Known limitations (to carry into the compatibility matrix)

1. **Site Service Worker / tab-less requests** (`tabId = -1`) use the shared jar. PWAs and SPAs that
   fetch through a Service Worker will not be isolated. Likely the biggest real-site risk.
   *Update 2026-11-11 (ADR 0005, F9):* confirmed, and worse (a session login leaked into normal tabs).
   Site Service Workers are now switched off in session tabs; a first-load window remains.
2. **Healing is GET-only for top-level navigations.** A stale POST/307/308 hop, stale `sub_frame`
   navigations and stale subresource requests (≈ 1 ms window right after a cookie change) are
   detected but not re-issued. A stale GET hop is executed twice on the server.
   *Update 2026-11-11 (ADR 0005, F10):* stale `sub_frame` GETs are now healed too.
3. **`document.cookie` on the first document of an origin in a tab**: until the async snapshot
   arrives, reads are native and writes reach the shared jar (they are then imported into the
   session). Later loads use a synchronous `sessionStorage` cache. `cookieStore` API not virtualized.
4. localStorage / sessionStorage / IndexedDB / CacheStorage stay shared per origin.
5. Cookie model gaps: no Public Suffix List (single-label heuristic only), no CHIPS partitioning,
   `SameSite=Strict` is still sent on cross-site top-level navigations, cross-site `Lax` cookies are stored.
6. Rules use `regexFilter`, and Chrome caps regex rules (~1000). That limits the number of
   (host × cookie-path) combinations across all sessions.
7. Without host permission for an origin, managed tabs silently use the shared jar there. The popup
   warns and offers "Grant access".
8. Session cookies live in `chrome.storage.session` only (lost on browser restart). Encrypted persistence
   (FR-15) and browser-restart remapping (FR-17) are Phase 4 / Phase 5 work.
9. The worker exposes a `globalThis.sessionwoy` debug API for tests. Remove or gate it before any release.

## Manual check on branded Chrome 157 (2026-11-10)

Extension loaded unpacked in the user's Google Chrome **157** (macOS). Sessions were assigned by the
user through the popup (Tab 1 → Customer/A, Tab 2 → Provider/B). The remaining steps were driven
with browser automation against `localhost:3003`.

| Check | Result |
| --- | --- |
| Extension active (MAIN-world `document.cookie` hook installed, snapshot cache present in managed tabs only) | ✅ |
| Login via `302` + `Set-Cookie` in both tabs (redirect race healed) | ✅ `customer` / `provider` on the final page and via `fetch` |
| 4-hop redirect chain, then reload | ✅ every hop + reload kept its own identity |
| `document.cookie` write in Tab 1 | ✅ readable at once in Tab 1, sent to the server in session A; HttpOnly `sid` hidden from JS; absent in Tab 2 |
| Fresh probe cookies (one via JS, one via server `Set-Cookie`) in Tab 1 | ✅ present in session A only; **not** in the shared jar, not in Tab 2 |
| Unmanaged tab logs in as `admin` | ✅ unmanaged tab = `admin`; Tabs 1/2 stay `customer` / `provider` |
| Link with `target=_blank` from Tab 1 | ✅ new tab inherited session A (`customer`) |

Observations (not SessionWoy defects):

- Session A already held cookies such as `_ga`, `_gid`, `_vwo_uuid_v2`, `platform_requested` and
  `_recommend_session_development`. Cookies ignore ports, so cookies stored for `localhost` while the
  session was used on another local app (e.g. port 3000) are correctly sent to `localhost:3003` too.
  Session B did not receive them. Phase 3 UI should make per-session cookie contents visible.
- The shared jar held a leftover `jsval` from an earlier manual try, and many cookies named
  `__ml_<number>__…` plus `__ml_active__`. SessionWoy never creates these. They match the naming of
  another multi-login extension that prefixes cookie names with a tab id. Running two cookie-swapping
  extensions at once can interfere; **disable other multi-session extensions while testing SessionWoy.**

## Real-site compatibility matrix

Driven in the user's Chrome 157 with browser automation; the user granted host access, assigned
sessions and logged in. Account identity was read from the page header only (no cookie values read).

| Site | Type | Check | Result |
| --- | --- | --- | --- |
| `localhost:3000` (Recommend.my, Rails + Devise) | Server-rendered login site, HTTP | Two accounts at once (Customer `Usermy1` in A, Provider `Usersp1` in B) | ✅ |
| | | Reload, navigation, redirect (`/albums/listing` → `/interior-design`) | ✅ each tab kept its account |
| | | Unmanaged tab | ✅ independent; logging it out did not affect A/B, and A/B activity did not log it back in (no leak) |
| | | Logout (`DELETE /users/sign_out`, CSRF) in B | ✅ B logged out; A stayed logged in |
| | | Cmd+click link from A | ⚠️ 1 of 4 attempts joined B → **F6**, fixed, S15 added |
| | | Re-check after the F6 fix: 3× Cmd+click from A, two of them to `/` while the B tab was also at `/` | ✅ 3/3 inherited A (`Usermy1`) |
| `saucedemo.com` (Swag Labs) | SPA (React), HTTPS, login cookie set by **JavaScript** (`document.cookie`), no Service Worker | Two users at once (`standard_user` in A, `problem_user` in B) | ✅ |
| | | Reload, then SPA navigation to a product page | ✅ each tab kept its user |
| | | Unmanaged tab | ✅ not logged in ("You can only access '/inventory.html' when you are logged in"); the JS-written login cookie never reached the shared jar |
| | | Logout in B (SPA menu) | ✅ B logged out; A stayed logged in |
| | | Cart (stored in `localStorage`) | ⚠️ item added by A appeared in B's cart: limitation 4 confirmed on a real site (cookies isolated, web storage shared) |

Note: reloading the extension cleared all assignments and session cookies (limitation 8), so sessions
had to be assigned and logged in again before the re-check.

Coverage gap of `localhost:3000`: plain HTTP on localhost, so HTTPS, `Secure` cookies, cross-site
`SameSite` and subdomains are not exercised there. `saucedemo.com` covers HTTPS + SPA + JS-written
cookies, but has no Service Worker, so limitation 1 is still untested on a real site; Phase 5's
compatibility matrix must include a Service-Worker site (PWA).

## Verdict

All automated criteria G1–G10 of ADR 0001 are met on the test server, with no unexplained leakage,
the manual checklist passes on branded Chrome 157, and both real sites keep two accounts apart
(cookies) through login, reload, navigation, redirects, new tabs and logout. The one defect found on a
real site (F6) is fixed and covered by S15. The real-site failure seen (shared `localStorage` cart) is
limitation 4, not limitations 1–3, so the revisit condition below is not triggered.

**GO** (2026-11-10; previously Provisional GO). Phase 3 may start. Conditions that were required:

- [x] Manual check on branded **Chrome 157.0.8103.39** (2026-11-10, see section above). The automated
      suite ran on Chromium 158.
- [x] Real sites (one simple login site, one SPA), recorded in the compatibility matrix above.
  - [x] `localhost:3000` (simple login site): passed; F6 found, fixed and re-checked
  - [x] `saucedemo.com` (SPA, HTTPS): passed; shared cart = limitation 4

Carried into Phase 3–5: show per-session cookie contents in the UI; make clear in the UI that only
cookies are isolated; test a Service-Worker site (limitation 1); persist sessions across extension
reloads/browser restarts (limitation 8).

If either real site fails in a way caused by limitations 1–3 and that matters for the target users, revisit
this verdict. The fallback is PRD §14.1.

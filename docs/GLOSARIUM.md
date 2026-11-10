# SessionWoy Glossary

Abbreviations and terms used in the PRD, ADRs, code, and project discussions.
Entries are grouped by topic, not sorted alphabetically.

## 1. Documents and process

| Term | Stands for | Meaning in this project |
| --- | --- | --- |
| **PRD** | Product Requirements Document | The full product specification: goals, requirements, architecture, phase plan. File: `docs/adr/SessionWoy — PRD.md` |
| **ADR** | Architecture Decision Record | A short document recording one technical decision, why it was made, and its consequences. Stored in `docs/adr/` |
| **ADR 0001** | — | `docs/adr/0001-cookie-swapping.md`. The decision to use *cookie swapping* and the pass/fail criteria (G1–G10), fixed **before** any code was written |
| **ADR 0002** | — | `docs/adr/0002-poc-result.md`. POC results: test table, findings F1–F6, known limitations, compatibility matrix, and verdict |
| **ADR 0003** | — | `docs/adr/0003-session-manager-ui.md`. Phase 3 UI decisions: popup + side panel, Svelte instead of React, tab-group colors, persistence split, debug-API gating |
| **POC** | Proof of Concept | A minimal build to prove that a risky idea actually works before building the full product. Here: can cookies be separated per tab? |
| **MVP** | Minimum Viable Product | The smallest version of the product that is actually usable (defined in PRD §15) |
| **Phase 0–6** | — | Delivery stages in PRD §11: 0 research, 1 test server, 2 POC, 3 UI, 4 persistence & backend, 5 compatibility, 6 optional enhancements |
| **Go / No-go gate** | — | Decision point after the POC: continue (GO) or switch to the fallback (NO-GO, PRD §14.1) |
| **Provisional GO** | — | "Continue with conditions": automated tests passed, but manual checks were not finished yet. Phase 2 status before 2026-11-10 |
| **GO** | — | All conditions met. Phase 2 status since 2026-11-10 |
| **Fallback** | — | Backup plan if the POC fails: Chrome in Docker, or separate Chrome profiles (PRD §14.1) |
| **Compatibility matrix** | — | Table of SessionWoy test results on real websites (in ADR 0002) |

## 2. Numbering codes

| Code | Meaning | Location |
| --- | --- | --- |
| **G-n** (G1–G10) | Go/no-go criteria | ADR 0001 |
| **S-n** (S1–S21) | End-to-end test scenarios; one-to-one with the results tables | S1–S15: `e2e/tests/poc.spec.ts`, ADR 0002; S16–S21: `e2e/tests/ui.spec.ts`, ADR 0003 |
| **D-n** (D1–D8) | Decisions in an ADR | ADR 0003 |
| **F-n** (F1–F8) | Technical findings (e.g. F3 = redirect race, F6 = session inheritance bug, F7 = orphaned content scripts after an extension reload, F8 = session applied on a site without host access) | F1–F6: ADR 0002; F7–F8: ADR 0003 |
| **FR-n** | Functional Requirement | PRD §5 |
| **NFR** | Non-Functional Requirement: quality targets (speed, security, reliability) | PRD §6 |
| **G1, G2, …** in the PRD | Product goals | PRD §2.1 (not the same as G-n in ADR 0001) |

## 3. SessionWoy-specific terms

| Term | Meaning |
| --- | --- |
| **Session** | A named set of cookies (e.g. *Customer*) used by one or more tabs |
| **Managed tab** | A tab that has been assigned to a session. SessionWoy controls its cookies |
| **Unmanaged tab** | A normal tab with no session. Behaves exactly like normal Chrome |
| **Shared jar** | Chrome's built-in cookie jar, shared by all normal tabs. Managed tabs never read from or write to it |
| **Session jar** | The cookie jar belonging to one session, stored by the extension |
| **Cookie swapping** | SessionWoy's core technique: replacing the `Cookie` header of every request with the cookies of that tab's session |
| **Presets (A/B/C)** | Fixed sessions in the POC: A = Customer, B = Provider, C = Admin. Removed in Phase 3; sessions are now user-created |
| **Archive / Restore** | Archiving hides a session and turns its tabs into normal tabs, but keeps its cookies (in memory). Restoring makes it usable again |
| **Reset** | Clears a session's cookies (logs it out) while its tabs stay in the session |
| **Favicon dot** | A dot in the session color drawn on the bottom-right of a session tab's favicon (or a plain colored circle if the site's favicon cannot be read). Always on; removed when the tab leaves its session |
| **Per tab / Per group** | The session marker mode ("Show sessions"). The session is always chosen per tab. *Per tab* (default): only the toolbar badge shows it. *Per group*: each session's tabs are also collected in a colored Chrome tab group. Groups are only a marker; dragging a tab to another group does not change its session |
| **Session color** | One of the 9 Chrome tab-group colors (grey, blue, red, yellow, green, pink, purple, cyan, orange), used for the badge, the UI and the tab group |
| **Release build / e2e build** | `extension/dist` (what users load; no debug API) vs `extension/dist-e2e` (used by Playwright; includes the debug API) |
| **Inheritance** | A new tab opened from a link in a managed tab automatically joins the source tab's session (on by default) |
| **Stale request** | A request sent with old cookies because the cookie rules had not been updated yet (finding F3) |
| **Heal** | The mechanism that re-issues a GET navigation sent with old cookies, so the page loads with the current cookies |
| **Redirect race** | When a server sends `Set-Cookie` on a `302` redirect and Chrome follows the redirect before the cookie rules are updated |
| **Snapshot cache** | A copy of the session's script-visible cookies in `sessionStorage`, so `document.cookie` has an immediate answer when a page reloads |
| **Debug API** | Test-only functions in the service worker (`globalThis.sessionwoy`). Present only in the e2e build (`__E2E__`), stripped from the release build |

## 4. Web and browser

| Term | Stands for | Meaning |
| --- | --- | --- |
| **SPA** | Single-Page Application | A website that loads once and then switches "pages" with JavaScript, without full reloads. Examples: Gmail, saucedemo.com |
| **PWA** | Progressive Web App | A website that can be "installed" like an app; almost always uses a Service Worker |
| **Cookie** | — | A small piece of data from a website that the browser stores and sends back with each request (e.g. login state) |
| **Cookie jar** | — | Where the browser stores cookies. Chrome normally has one per profile |
| **Set-Cookie** | — | Response header in which the server tells the browser to store a cookie, e.g. after login |
| **`document.cookie`** | — | How JavaScript on a page reads and writes cookies |
| **HttpOnly** | — | A cookie that JavaScript cannot read; it is only sent to the server. Usually the login cookie |
| **Secure** | — | A cookie that is only sent over HTTPS |
| **SameSite** | — | Rule for when a cookie may be sent from another site: `Strict`, `Lax`, or `None` |
| **Max-Age / Expires** | — | A cookie's lifetime. `Max-Age=0` deletes the cookie |
| **localStorage / sessionStorage** | — | Browser storage other than cookies. **Not** separated per session by SessionWoy (limitation 4) |
| **IndexedDB / CacheStorage** | — | Larger browser storage. Also not separated per session |
| **Origin** | — | Scheme + host + port, e.g. `http://localhost:3000` |
| **Redirect / 302** | — | A server response that tells the browser to go to another URL |
| **CSRF** | Cross-Site Request Forgery | An attack that forges requests from another site. Rails apps protect against it with CSRF tokens |
| **OAuth** | — | Login through a third party ("Sign in with Google"), usually via a popup or redirect |
| **CHIPS** | Cookies Having Independent Partitioned State | Cookies partitioned per top-level site. Not supported in the POC |
| **PSL** | Public Suffix List | List of public domains (such as `.co.id`) so cookies cannot be set for a whole public domain. Not used in the POC |
| **Loopback (127.0.0.1)** | — | An address reachable only from your own computer, not from the network |

## 5. Chrome extensions

| Term | Stands for | Meaning |
| --- | --- | --- |
| **MV3** | Manifest Version 3 | The current Chrome extension format. Stricter rules; extensions can no longer block requests directly |
| **Manifest** | — | The `manifest.json` file that describes the extension: name, permissions, icons, scripts |
| **DNR** | declarativeNetRequest | Chrome API that changes requests through rules registered with the browser. Used to replace the `Cookie` header per tab |
| **Session rules** | — | DNR rules that live while the browser runs (gone after a browser restart) |
| **webRequest** | — | Chrome API to *observe* requests and responses. Used to read `Set-Cookie` |
| **Service Worker (SW)** | — | A background script. Two kinds: (1) the **extension's**, which is SessionWoy's brain; (2) a **website's**, whose requests are not tied to a tab and so are not yet separated per session (limitation 1) |
| **Content script** | — | An extension script injected into a web page |
| **MAIN world / ISOLATED world** | — | MAIN = the page's own JavaScript context; ISOLATED = a separate context owned by the extension. SessionWoy uses both for `document.cookie` |
| **Popup** | — | The small window that opens when you click the extension icon. In SessionWoy: quick actions for the current tab |
| **Side panel** | — | A panel docked at the side of the Chrome window that stays open while you switch tabs (`chrome.sidePanel`). In SessionWoy: session management |
| **Tab group** | — | Chrome's named, colored grouping of tabs in the tab strip (`chrome.tabGroups`). SessionWoy puts each session's tabs in one group |
| **Badge** | — | Small colored text on the extension icon (e.g. the session name) |
| **Host permission** | — | The extension's permission to access a specific site. Granted per site with *Grant access to this site* |
| **`chrome.storage.session`** | — | In-memory extension storage; cleared when the extension reloads or the browser restarts (limitation 8). Holds tab mapping and cookies |
| **`chrome.storage.local`** | — | Durable extension storage on disk. Holds session names, colors and settings only, never cookies (until Phase 4 encryption) |
| **Unpacked extension** | — | An extension loaded directly from a folder (`extension/dist`) in *Developer mode*, not from the Chrome Web Store |

## 6. Tooling and infrastructure

| Term | Stands for | Meaning |
| --- | --- | --- |
| **E2E** | End-to-End test | A test that runs a real browser with the extension, from start to finish (folder `e2e/`) |
| **Unit test** | — | A small test for one function or module, without a browser (Vitest) |
| **Playwright** | — | Browser automation tool used for the E2E tests |
| **Vitest** | — | Unit test framework for TypeScript |
| **esbuild** | — | Build tool that bundles the extension's TypeScript into `dist/` |
| **Svelte 5** | — | UI framework used for the popup and side panel. Components (`.svelte`) are compiled at build time by `esbuild-svelte`; only a small runtime ships. Uses *runes* (`$state`, `$derived`, `$props`, `$effect`) |
| **svelte-check** | — | Type checker for `.svelte` and `.ts` files (`npm run typecheck`) |
| **`__E2E__`** | — | Build-time flag: `true` only in the e2e build, where it enables the debug API |
| **Fastify** | — | Node.js web framework for the test server and the backend |
| **Docker / Docker Compose** | — | Runs services in containers. Service `app` = test server (port 3003), `backend` = Phase 4 API (port 3004) |
| **CDP** | Chrome DevTools Protocol | Chrome's control channel used by automated tests, e.g. to stop the service worker (S10) |
| **npm workspaces** | — | One repo containing several packages: `extension`, `test-server`, `e2e` |
| **SQLite** | — | File-based database, planned for the Phase 4 backend |

## 7. Security and measurement

| Term | Stands for | Meaning |
| --- | --- | --- |
| **AES-256-GCM** | Advanced Encryption Standard, 256-bit, Galois/Counter Mode | Encryption algorithm planned for storing cookies securely (Phase 4) |
| **PBKDF2** | Password-Based Key Derivation Function 2 | Derives an encryption key from the user's passphrase |
| **Ciphertext** | — | Encrypted data. The Phase 4 backend stores ciphertext only |
| **p50 / p95** | 50th / 95th percentile | p95 = 95% of requests are faster than this value. Used to measure added latency (S14) |
| **Latency** | — | The delay of a request |
| **Stress test** | — | A load test with a very large number of requests at once (S2: 10,000 requests per tab) |

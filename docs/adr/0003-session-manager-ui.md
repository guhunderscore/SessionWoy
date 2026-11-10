# ADR 0003 — Session manager UI (Phase 3)

- Status: Accepted (manual check in Chrome pending)
- Date: 2026-11-10
- Depends on: ADR 0001, ADR 0002 (verdict GO)

## Context

The Phase 2 POC had three hard-coded sessions (Customer/Provider/Admin) and a minimal popup.
Phase 3 (PRD §11, FR-1 … FR-9) needs user-managed sessions and visible session markers. ADR 0002 also
carried over: show per-session cookie contents, make clear that only cookies are isolated, and remove
the debug API from release builds.

## Decisions

### D1 — Popup for quick actions, side panel for management
- **Popup** (`src/ui/popup/`): the active tab's session, assign / switch / remove, create a session and
  use it in this tab, open a new tab in a session, grant host access, open the side panel.
- **Side panel** (`src/ui/sidepanel/`): create, rename, recolor, reset, archive / restore, delete;
  per-session cookie list; settings; diagnostics. It stays open while the user switches tabs and
  refreshes live (the worker broadcasts `ui:changed` after every mutation).

### D2 — Svelte 5 instead of React (deviation from PRD §7.1)
The PRD named "React + Vite". The user chose **Svelte 5**, compiled by `esbuild-svelte` inside the
existing esbuild build (no Vite). Reasons: small compiled output, no virtual-DOM runtime, and the
compiler and its dependencies are **build-time only**: only Svelte's small runtime ships in the
extension, which keeps the PRD §13 "minimal dependencies" rule for shipped code. Constraints:
`.svelte` files use `<script lang="ts">`; type checking uses `svelte-check` (covers `.ts` and
`.svelte`); ESLint lints `.ts` only. The UI bundle uses Svelte's `production` export condition and is
minified (~75 KB per page).

Only the popup and side panel use Svelte. The service worker, content scripts and shared helpers stay
plain TypeScript.

### D3 — Session colors are the Chrome tab-group colors
Tab groups accept only 9 named colors (`grey, blue, red, yellow, green, pink, purple, cyan, orange`).
Sessions use exactly this palette (`shared/sessions.ts`, with a hex map for the badge and UI), so the
badge, the UI and the tab group always match.

### D4 — Markers: badge always, tab groups optional (FR-6)
**Favicon dot (always on, user feedback 2026-11-10):** every session tab's favicon gets a dot in the
session color in its bottom-right corner (`content/favicon.ts`, ISOLATED world, top frame only). It
is composed on the site's own favicon; if that cannot be read (missing, or cross-origin without CORS,
which taints the canvas) a plain circle in the session color is used. The page's icon links are
disabled while the tab is in a session (`rel` saved in `data-sessionwoy-rel`) and restored when it
leaves; a `MutationObserver` re-applies the dot when the page changes its own favicon. Recolor updates
it live. Works only on sites with host access (like the session itself). Test: **S21**.

The session is **always chosen per tab** (popup). Beyond the badge and the favicon dot, the marker is configurable, with the setting
`grouping` (`shared/sessions.ts`), switchable in the side panel's Settings and in the popup
("Show sessions: Per tab | Per group"):
- **Per tab** (`'tab'`, **default**, user decision 2026-11-10): the toolbar badge shows the first 4
  characters of the session name in the session color; tabs stay ungrouped.
- **Per group** (`'group'`): additionally, each session's tabs go into one tab group per window, titled
  with the session name and colored with the session color (`background/groups.ts`). Rename / recolor
  updates the groups; unassign, archive and delete ungroup; a tab moved to another window joins the
  session's group there.

Rules for both modes:
- Groups are **only a marker**: dragging a tab into another session's group does **not** change its
  session (user decision: "groups are only a marker"); use the popup to switch.
- Switching mode never changes any tab's session or logs anyone out: `tab` ungroups all session tabs,
  `group` groups them immediately. On startup in `tab` mode, leftover groups are removed.
- We never fight the user: a managed tab dragged out of its group stays out. Group failures are logged
  and never affect cookie isolation.
- The setting replaced the earlier boolean `useTabGroups` (default true). The old stored value is
  ignored on purpose, so existing installs also move to the new per-tab default.

### D5 — Persistence split
- **Durable** (`chrome.storage.local`): session metadata (PRD §10.1: id, name, color, status,
  timestamps) and settings. Survives extension reloads and browser restarts.
- **Memory only** (`chrome.storage.session`): tab → session mapping, cookie jars, group ids. Cookies
  stay off disk until Phase 4 adds encryption (PRD §13). Consequence, shown in the side panel: after a
  browser restart or extension reload the sessions are still listed, but they are logged out.

### D6 — Session semantics
- **Delete** (FR-2): its tabs become normal tabs and reload; its cookies, DNR rules, tab groups and
  metadata are removed. Inline confirmation states that this cannot be undone.
- **Archive**: its tabs become normal tabs and reload; cookies are kept (in memory); the session is
  hidden from the popup and cannot be assigned. **Restore** makes it active again.
- **Reset** (FR-3): clears its cookies; its tabs stay in the session and reload (logged out).
- **Assign** from the UI reloads the tab, so the page is served with the session's cookies.
- No `window.confirm` / `alert`: confirmations are inline (`ConfirmInline.svelte`).
- Cookie list shows domain, name, path, HttpOnly / Secure and expiry. **Values are never sent to the
  UI** (`summarizeCookies`).

### D7 — Debug API only in the e2e build (closes ADR 0002 limitation 9)
`build.mjs` defines `__E2E__`. `npm run build` → `extension/dist` with `__E2E__ = false`; `minifySyntax`
removes the whole `globalThis.sessionwoy` block (verified: no debug symbols in `dist/background.js`).
`npm run build:e2e` → `extension/dist-e2e` with the debug API; Playwright loads that folder. In the e2e
build, unknown session ids passed to the debug `assign*` helpers are created on the fly (id = name), so
S1–S15 run unchanged.

### D8 — Inheritance setting
"Links opened from a session tab stay in that session" (FR-7) is a setting, **on by default** (user
decision). The duplicate-tab rule (FR-8, F6) follows the same setting.

## Findings

**F7 — Orphaned content scripts after an extension reload (found in Chrome 157, 2026-11-10).**
After reloading the extension, the user saw `Uncaught Error: Extension context invalidated.` from
`content-relay.js`. Chrome keeps the old content scripts running in already-open pages; their
`chrome.runtime.sendMessage` then **throws synchronously** instead of returning a rejected promise,
so the relay's `.catch()` did not catch it. It fired whenever such a page wrote `document.cookie`
(e.g. analytics on `localhost:3000`). Besides the error, the orphaned MAIN-world hook kept serving the
stale session snapshot although the new extension instance had no session for that tab.
Fix (`content/relay.ts`): every send runs inside `try/await`; when the context is gone the relay
detaches its listener and tells the MAIN-world hook `{ managed: false }`, so the page falls back to
native `document.cookie` (and the snapshot cache is cleared) until it is reloaded. The first write
after the reload is lost (it went to the stale snapshot); later writes reach Chrome's jar normally.
Test: `extension/test/relay.test.ts` drives the real relay with a fake `chrome`/`document`. It fails
with exactly this error without the fix and passes with it. An e2e test is not possible: Playwright
cannot reload an extension loaded with `--load-extension` (`chrome.runtime.reload()` disables it and
its pages return `ERR_BLOCKED_BY_CLIENT`).

**F8 — A session could be applied on a site without host access, silently sharing logins (found in
Chrome 157, 2026-11-10).** The user put Tab A and Tab B on `localhost:3000` into different sessions;
after logging in on A, B was logged in too. Diagnosis: SessionWoy had no host access to
`localhost:3000` any more (the MAIN-world hook was missing there while present on `localhost:3003`),
most likely because the unpacked extension was removed and loaded again, which drops runtime-granted
permissions. Without host access, DNR rules and `Set-Cookie` capture do not apply to that origin, so
both tabs used Chrome's shared jar (ADR 0002 limitation 7). The popup allowed assigning anyway and
its only hint was easy to miss. Fix, in three layers:
- **Popup**: choosing a session, "Create and use here" and "Open tab" on a site without access ask
  for access in the same click (`chrome.permissions.request`); if refused, nothing is applied.
- **Worker** (`requireHostAccess`): `ui:assign` (to a session), `ui:create` with a tab and
  `ui:openTab` are refused for origins without access. `ui:create` checks before creating, so no
  orphan session is left. Removing a tab from a session is always allowed.
- **Warning**: a session tab that navigates to a site without access shows a red **"!"** badge and a
  tooltip; its popup says in red that logins on this site are NOT separated, with "Grant access and
  reload". Badges repaint on navigation and on permission changes.
Test: **S20**. Limitation 7 stays true for origins without access, but it is no longer silent.
After granting access, logins made while access was missing live in Chrome's shared jar, so the
session tabs must log in again.

## Extension icon size (user feedback 2026-11-10)
The icons looked too small in the toolbar and on `chrome://extensions`. The 128 px icon followed
Google's guideline (≈96 px artwork + 16 px padding), and the portrait jar only fills ~75% of the box
width at any size. Four options were rendered at real size (current, full size, white tile, enlarged
and cropped); the user chose **full size for all sizes**: the jar now fills the full height of
16/32/48/128 px, with no extra padding. The source stays `extension/assets/jarsession.png`.

## Message API (`shared/messages.ts`)
Extension pages only (`isExtensionPage`: sender URL is this extension's origin, which also covers the
side panel opened as a tab): `ui:state`, `ui:create`, `ui:update`, `ui:archive`, `ui:restore`,
`ui:delete`, `ui:reset`, `ui:assign`, `ui:openTab`, `ui:cookies`, `ui:settings`,
`ui:permissionsChanged`. Every reply is `{ ok: true, data } | { ok: false, error }`; input is validated
in the worker (`validateName`, `isSessionColor`, http(s)-only URLs for `ui:openTab`).

## Results (2026-11-10)

| Check | Result |
| --- | --- |
| Unit tests | ✅ 29 extension (7 in `sessions.test.ts`, 3 in `relay.test.ts` for F7) + 8 test server |
| `svelte-check` (TS + Svelte), ESLint | ✅ 0 errors, 0 warnings |
| e2e S1–S15 on the new code (regression) | ✅ |
| S16 create / rename / recolor / archive / restore / reset / delete via `ui:*`; cookie list has no values; delete removes rules | ✅ |
| S17 per-tab mode by default (no groups); per-group mode groups tabs, title/color follow the session; unassign and switching back ungroup; sessions unchanged | ✅ |
| S18 session list + settings in `storage.local`, no cookie values on disk, survive a worker restart | ✅ |
| S20 no host access: assign / create-and-use / open-tab refused (no orphan session); session tab on such a site shows "!" and recovers its badge when back (F8) | ✅ |
| S21 favicon dot: composed on the site's favicon, recolors live, re-applied when the page swaps its icon, removed and original restored on leave, fallback circle without a favicon | ✅ (10× repeated) |
| S19 side panel with real clicks (create, rename, delete with inline confirm, mode toggle); popup renders and its mode toggle updates the side panel live; no page errors | ✅ |
| Full suite (19 scenarios) twice; UI scenarios 10× repeated | ✅ 19/19 twice, 40/40 |
| Release build contains no debug API | ✅ |
| Full suite (20 scenarios) after F8, twice | ✅ 20/20 twice; S20 10× repeated |
| Full suite (21 scenarios) after the favicon dot and the larger icons (v0.2.3), twice | ✅ 21/21 twice |
| Manual check in Chrome 157 | ⏳ in progress: F7 and F8 found and fixed; rest of the checklist pending |

One flaky test was found and fixed during this work: S16 called `fetch()` inside a tab that the
extension was reloading (by design, after archive). The test now navigates fresh instead.

## Consequences
- The PRD's "React + Vite" is superseded for the UI by this ADR.
- Phase 4 (encrypted cookie persistence) will make sessions stay logged in across restarts; the
  side-panel notice must be updated then.
- Still open from ADR 0002: site Service Workers (limitation 1), shared web storage (limitation 4),
  tab-mapping restore after a browser restart (FR-17, Phase 5).

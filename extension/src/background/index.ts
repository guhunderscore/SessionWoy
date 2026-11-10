/**
 * SessionWoy POC service worker.
 *
 * All listeners are registered synchronously at top level (MV3 requirement so
 * that events wake the worker). Work is pushed through `run()`, a FIFO queue
 * whose first task is `init()` (state rehydration + full rule rebuild).
 */
import { buildSessionRules, type RuleSpec } from '../shared/rules.js';
import type { ContentMessage, PopupMessage, Snapshot } from '../shared/messages.js';
import { applySessionRules, replaceAllRules, ruleStats } from './dnr.js';
import { serial } from './serial.js';
import { PRESETS, Store } from './state.js';

const store = new Store();
const settings = { inheritOnOpen: true };

const diag = {
  workerStartedAt: Date.now(),
  restoredTabs: 0,
  droppedTabs: 0,
  setCookieHeadersSeen: 0,
  setCookieStored: 0,
  setCookieRejected: 0,
  scriptCookiesStored: 0,
  mainFrameChecks: 0,
  /** Main-frame requests whose sent Cookie header (as seen by webRequest) differed from the jar. Names only, never values. */
  mainFrameMismatches: [] as { url: string; sentNames: string[]; expectedNames: string[]; at: number }[],
  inherited: 0,
  /** Last 20 inheritance decisions (tab ids and session ids only). */
  inheritLog: [] as { via: 'link' | 'duplicate'; source: number; tab: number; sessionId: string | null; applied: boolean; reason?: string; at: number }[],
  /** Requests whose sent Cookie header differed from the session jar (rule update not yet applied). */
  staleRequests: 0,
  setCookieDiscardedStale: 0,
  healed: 0,
  healSkipped: 0,
};

/** True once init() has rehydrated state; before that, synchronous listeners must not judge staleness. */
let loaded = false;

const run = <T>(fn: () => Promise<T> | T): Promise<T> => serial(fn);

// ---------------------------------------------------------------- core ops

async function rebuild(sessionId: string): Promise<void> {
  const jar = store.jar(sessionId);
  const now = Date.now();
  jar.purgeExpired(now);
  await applySessionRules(sessionId, buildSessionRules(jar.all(), store.tabsOf(sessionId), now));
  scheduleExpiry();
}

function notifySession(sessionId: string, exceptTab?: number): void {
  for (const tabId of store.tabsOf(sessionId)) {
    if (tabId === exceptTab) continue;
    chrome.tabs.sendMessage(tabId, { type: 'session:changed' }).catch(() => undefined);
  }
}

async function paintBadge(tabId: number): Promise<void> {
  const sid = store.tabs.get(tabId);
  const meta = sid ? store.sessions.get(sid) : undefined;
  try {
    await chrome.action.setBadgeText({ tabId, text: meta ? meta.name.slice(0, 4) : '' });
    if (meta) await chrome.action.setBadgeBackgroundColor({ tabId, color: meta.color });
    await chrome.action.setTitle({ tabId, title: meta ? `SessionWoy: ${meta.name}` : 'SessionWoy: unmanaged' });
  } catch {
    /* tab may be gone */
  }
}

async function assign(tabId: number, sessionId: string | null): Promise<void> {
  const prev = store.tabs.get(tabId) ?? null;
  if (prev === sessionId) return;
  if (sessionId) {
    store.ensureSession(sessionId);
    store.tabs.set(tabId, sessionId);
  } else {
    store.tabs.delete(tabId);
  }
  // New session's rules first, so the tab is never without a cookie-stripping rule.
  if (sessionId) await rebuild(sessionId);
  if (prev) await rebuild(prev);
  await store.save();
  await paintBadge(tabId);
  chrome.tabs.sendMessage(tabId, { type: 'session:changed' }).catch(() => undefined);
}

async function forgetTab(tabId: number): Promise<void> {
  const sid = store.tabs.get(tabId);
  if (!sid) return;
  store.tabs.delete(tabId); // FR-9: mapping only; session data is kept
  await rebuild(sid);
  await store.save();
}

async function resetSession(sessionId: string): Promise<void> {
  store.jar(sessionId).clear();
  await rebuild(sessionId);
  await store.save();
  notifySession(sessionId);
}

// ---------------------------------------------------------------- expiry

let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleExpiry(): void {
  const now = Date.now();
  let next: number | null = null;
  for (const jar of store.jars.values()) {
    const n = jar.nextExpiry(now);
    if (n !== null && (next === null || n < next)) next = n;
  }
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  if (next === null) return;
  const delay = Math.min(Math.max(next - now + 50, 50), 2 ** 31 - 1);
  expiryTimer = setTimeout(() => void run(purgeAll), delay);
}

async function purgeAll(): Promise<void> {
  const now = Date.now();
  let changed = false;
  for (const [sid, jar] of store.jars) {
    if (jar.purgeExpired(now)) {
      changed = true;
      await rebuild(sid);
      notifySession(sid);
    }
  }
  if (changed) await store.save();
  scheduleExpiry();
}

// ---------------------------------------------------------------- content scripts

const CS_IDS = ['sessionwoy-main', 'sessionwoy-relay'];

/** Registers the cookie hook for every granted http(s) origin (static + runtime-granted). */
async function syncContentScripts(): Promise<void> {
  const perms = await chrome.permissions.getAll();
  const matches = (perms.origins ?? []).filter((o) => /^(https?|\*):\/\//.test(o)).sort();
  const current = await chrome.scripting.getRegisteredContentScripts({ ids: CS_IDS });
  const same =
    current.length === 2 && current.every((s) => JSON.stringify([...(s.matches ?? [])].sort()) === JSON.stringify(matches));
  if (same) return;
  if (current.length) await chrome.scripting.unregisterContentScripts({ ids: current.map((s) => s.id) });
  if (!matches.length) return;
  const common = { matches, runAt: 'document_start' as const, allFrames: true, persistAcrossSessions: true };
  await chrome.scripting.registerContentScripts([
    { id: 'sessionwoy-main', js: ['content-main.js'], world: 'MAIN' as chrome.scripting.ExecutionWorld, ...common },
    { id: 'sessionwoy-relay', js: ['content-relay.js'], ...common },
  ]);
}

// ---------------------------------------------------------------- init

async function init(): Promise<void> {
  await store.load();
  for (const [tabId] of [...store.tabs]) {
    try {
      await chrome.tabs.get(tabId);
      diag.restoredTabs++;
    } catch {
      store.tabs.delete(tabId);
      diag.droppedTabs++;
    }
  }
  const now = Date.now();
  const specs = new Map<string, RuleSpec[]>();
  for (const sid of new Set([...store.tabs.values(), ...store.jars.keys()])) {
    const jar = store.jar(sid);
    jar.purgeExpired(now);
    specs.set(sid, buildSessionRules(jar.all(), store.tabsOf(sid), now));
  }
  await replaceAllRules(specs);
  loaded = true;
  scheduleExpiry();
  await store.save();
  for (const tabId of store.tabs.keys()) await paintBadge(tabId);
  await syncContentScripts().catch((e: unknown) => console.error('[sessionwoy] content script sync failed', e));
  await chrome.alarms.create('sessionwoy-purge', { periodInMinutes: 1 });
}

void run(init);

// ---------------------------------------------------------------- network observation

/** Stores response cookies into the tab's session jar. Returns the session id if the jar changed. */
function captureSetCookies(
  d: { tabId: number; url: string; requestId: string; type: string; method: string },
  values: string[],
  staleNow: boolean,
): string | null {
  diag.setCookieHeadersSeen += values.length;
  // A stale top-level GET is being re-issued by heal(); its cookies (e.g. a fresh
  // "anonymous" session) must not overwrite what the previous hop just set.
  if ((staleNow || staleRequests.has(d.requestId)) && d.type === 'main_frame' && d.method === 'GET') {
    diag.setCookieDiscardedStale += values.length;
    return null;
  }
  const sid = store.tabs.get(d.tabId);
  if (!sid) return null;
  const jar = store.jar(sid);
  const url = new URL(d.url);
  const now = Date.now();
  let changed = false;
  for (const v of values) {
    const r = jar.setFromHeader(v, url, now);
    if (r.ok) {
      diag.setCookieStored++;
      changed ||= r.changed === true;
    } else {
      diag.setCookieRejected++;
    }
  }
  return changed ? sid : null;
}

async function afterJarChange(sid: string): Promise<void> {
  await rebuild(sid);
  await store.save();
  notifySession(sid);
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0) return undefined;
    const values: string[] = [];
    for (const h of d.responseHeaders ?? []) {
      if (h.name.toLowerCase() === 'set-cookie' && h.value) values.push(...h.value.split('\n'));
    }
    if (!values.length) return undefined;
    // Sampled now (onCompleted may forget the id before a queued task runs).
    const staleNow = staleRequests.has(d.requestId);
    if (loaded) {
      // Warm worker: mutate the in-memory jar synchronously so that it is ahead of
      // the DNR rules from this instant; checkStale() relies on that ordering.
      const sid = captureSetCookies(d, values, staleNow);
      if (sid) void run(() => afterJarChange(sid));
    } else {
      void run(async () => {
        const sid = captureSetCookies(d, values, staleNow);
        if (sid) await afterJarChange(sid);
      });
    }
    return undefined;
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders'],
);

// ---------------------------------------------------------------- stale-request detection & healing
//
// Finding (ADR 0002): a Set-Cookie on a 302 is observed, but Chrome follows the
// redirect before updateSessionRules() resolves, so the next hop carries the old
// cookies. webRequest.onSendHeaders reports the Cookie header AFTER DNR
// modification, so comparing it (synchronously) with the in-memory jar — which
// is updated before the rules — identifies exactly the requests that went out
// with stale cookies.

/** requestId -> current hop was sent with stale cookies (requestId is shared across redirect hops). */
const staleRequests = new Set<string>();
const heals = new Map<number, { url: string; n: number; at: number }>();

function isFresh(sent: string, jarHeaderSame: string, jarHeaderCross: string): boolean {
  return sent === jarHeaderSame || sent === jarHeaderCross;
}

function heal(tabId: number, url: string): void {
  // Queued behind the rule update that made this request stale.
  void run(async () => {
    if (!store.tabs.has(tabId)) return;
    const now = Date.now();
    const h = heals.get(tabId);
    const repeat = h && h.url === url && now - h.at < 5_000;
    if (repeat && h.n >= 2) {
      diag.healSkipped++;
      return;
    }
    heals.set(tabId, { url, n: repeat ? h.n + 1 : 1, at: now });
    diag.healed++;
    await chrome.tabs.update(tabId, { url }).catch(() => undefined);
  });
}

type SendDetails = chrome.webRequest.OnSendHeadersDetails;

function checkStale(d: SendDetails, sent: string): void {
  const sid = store.tabs.get(d.tabId);
  if (!sid) return;
  const jar = store.jar(sid);
  const url = new URL(d.url);
  const now = Date.now();
  const same = jar.cookieHeaderFor(url, now);
  if (d.type === 'main_frame') diag.mainFrameChecks++;
  // The third-party (SameSite=None only) rule variant never applies to main_frame.
  const cross = d.type === 'main_frame' ? same : jar.cookieHeaderFor(url, now, 'cross-site');
  if (isFresh(sent, same, cross)) {
    staleRequests.delete(d.requestId);
    return;
  }
  staleRequests.add(d.requestId);
  if (staleRequests.size > 5_000) staleRequests.clear();
  diag.staleRequests++;
  if (d.type !== 'main_frame') return; // subresources cannot be re-issued (documented limitation)
  const names = (s: string) => (s ? s.split('; ').map((p) => p.split('=')[0] ?? '') : []);
  diag.mainFrameMismatches.push({ url: d.url.split('?')[0] ?? '', sentNames: names(sent), expectedNames: names(same), at: now });
  if (diag.mainFrameMismatches.length > 50) diag.mainFrameMismatches.shift();
  if (d.method === 'GET') heal(d.tabId, d.url);
}

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const sent = d.requestHeaders?.find((h) => h.name.toLowerCase() === 'cookie')?.value ?? '';
    // Warm worker: judge synchronously (jar is ahead of the rules exactly during the race).
    // Cold worker: state is not loaded yet, so judge right after init() in queue order.
    if (loaded) checkStale(d, sent);
    else void run(() => checkStale(d, sent));
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders'],
);

const forgetRequest = (d: { requestId: string }) => void staleRequests.delete(d.requestId);
chrome.webRequest.onCompleted.addListener(forgetRequest, { urls: ['<all_urls>'] });
chrome.webRequest.onErrorOccurred.addListener(forgetRequest, { urls: ['<all_urls>'] });

// ---------------------------------------------------------------- tab lifecycle

/**
 * Tabs created by a link / window.open (webNavigation.onCreatedNavigationTarget).
 * That event names the real source tab, so it is authoritative and always wins
 * over the duplicate heuristic below.
 */
const navTargetTabs = new Set<number>();
/** How long the duplicate heuristic waits for a possible onCreatedNavigationTarget. */
const DUPLICATE_SETTLE_MS = 300;

type InheritVia = 'link' | 'duplicate';

function logInherit(entry: { via: InheritVia; source: number; tab: number; sessionId: string | null; applied: boolean; reason?: string }): void {
  diag.inheritLog.push({ ...entry, at: Date.now() });
  if (diag.inheritLog.length > 20) diag.inheritLog.shift();
}

function inheritFrom(sourceTabId: number | undefined, newTabId: number | undefined, via: InheritVia): void {
  if (sourceTabId === undefined || newTabId === undefined || !settings.inheritOnOpen) return;
  void run(async () => {
    const sid = store.tabs.get(sourceTabId) ?? null;
    const current = store.tabs.get(newTabId) ?? null;
    const log = (applied: boolean, reason?: string) =>
      logInherit({ via, source: sourceTabId, tab: newTabId, sessionId: sid, applied, ...(reason ? { reason } : {}) });
    if (!sid) return log(false, 'source unmanaged');
    if (current === sid) return log(false, 'already in session');
    // The heuristic never overrides: not a link-created tab, and not yet assigned.
    if (via === 'duplicate' && (navTargetTabs.has(newTabId) || current !== null)) {
      return log(false, navTargetTabs.has(newTabId) ? 'link signal wins' : 'already assigned');
    }
    diag.inherited++;
    log(true);
    await assign(newTabId, sid);
    // The duplicate decision is deferred, so the tab may already have loaded with the
    // shared jar; reload it so the page is fetched with the session's cookies.
    if (via === 'duplicate') await chrome.tabs.reload(newTabId).catch(() => undefined);
  });
}

// FR-7: links / window.open from a managed tab inherit its session (authoritative).
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  navTargetTabs.add(d.tabId);
  if (navTargetTabs.size > 500) navTargetTabs.clear();
  inheritFrom(d.sourceTabId, d.tabId, 'link');
});

// FR-8: a duplicated tab inherits its session. Chrome sets openerTabId on many
// unrelated new tabs (e.g. Ctrl+T next to the active tab), so openerTabId alone
// is NOT a signal; a duplicate is recognised by starting at the opener's URL.
// It is only a fallback: it waits briefly so a link signal for the same tab can
// arrive first, and inheritFrom() refuses to override (see ADR 0002, F4/F6).
chrome.tabs.onCreated.addListener((tab) => {
  const opener = tab.openerTabId;
  const newTab = tab.id;
  const url = tab.pendingUrl ?? tab.url ?? '';
  if (opener === undefined || newTab === undefined || !/^https?:/.test(url)) return;
  setTimeout(() => {
    if (navTargetTabs.has(newTab)) return;
    chrome.tabs.get(opener).then(
      (src) => {
        if ((src.url ?? '') === url) inheritFrom(opener, newTab, 'duplicate');
      },
      () => undefined,
    );
  }, DUPLICATE_SETTLE_MS);
});

chrome.tabs.onRemoved.addListener((tabId) => void run(() => forgetTab(tabId)));

chrome.tabs.onReplaced.addListener((added, removed) =>
  void run(async () => {
    const sid = store.tabs.get(removed);
    if (!sid) return;
    store.tabs.delete(removed);
    store.tabs.set(added, sid);
    await rebuild(sid);
    await store.save();
    await paintBadge(added);
  }),
);

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') void run(() => (store.tabs.has(tabId) ? paintBadge(tabId) : undefined));
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'sessionwoy-purge') void run(purgeAll);
});

chrome.permissions.onAdded.addListener(() => void run(syncContentScripts));
chrome.permissions.onRemoved.addListener(() => void run(syncContentScripts));

// ---------------------------------------------------------------- messages

function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !sender.tab && (sender.url ?? '').startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

async function handleContent(msg: ContentMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || !sender.url || !/^https?:/.test(sender.url)) return { managed: false } satisfies Snapshot;
  const sid = store.tabs.get(tabId);
  if (!sid) return { managed: false } satisfies Snapshot;
  // The frame URL comes from Chrome (sender.url), never from page-supplied data.
  const url = new URL(sender.url);
  const jar = store.jar(sid);
  const now = Date.now();
  switch (msg.type) {
    case 'snapshot:get':
      return { managed: true, sessionId: sid, cookies: jar.scriptVisibleForHost(url, now) } satisfies Snapshot;
    case 'cookie:set':
    case 'cookie:import': {
      const values = msg.type === 'cookie:set' ? [msg.value] : msg.values;
      let changed = false;
      for (const v of values.slice(0, 50)) {
        if (typeof v !== 'string') continue;
        const r = jar.setFromHeader(v, url, now, { fromScript: true });
        if (r.ok) diag.scriptCookiesStored++;
        changed ||= r.ok && r.changed === true;
      }
      if (changed) {
        await rebuild(sid);
        await store.save();
        notifySession(sid, tabId);
      }
      return { ok: true };
    }
    default:
      return { error: 'unknown message' };
  }
}

async function handlePopup(msg: PopupMessage): Promise<unknown> {
  switch (msg.type) {
    case 'popup:state': {
      const sid = store.tabs.get(msg.tabId) ?? null;
      return {
        sessionId: sid,
        presets: PRESETS,
        sessions: [...store.sessions.values()].map((s) => ({
          ...s,
          tabs: store.tabsOf(s.id).length,
          cookies: store.jar(s.id).size,
        })),
        diag: snapshotDiag(),
      };
    }
    case 'popup:assign':
      await assign(msg.tabId, msg.sessionId);
      return { ok: true };
    case 'popup:open':
      return openTabInSession(msg.sessionId, msg.url);
    case 'popup:reset':
      await resetSession(msg.sessionId);
      return { ok: true };
    case 'popup:permissionsChanged':
      await syncContentScripts();
      return { ok: true };
    default:
      return { error: 'unknown message' };
  }
}

/** FR-5: create the tab blank, install rules, then navigate — so the first request already carries the session. */
async function openTabInSession(sessionId: string, url: string): Promise<{ tabId: number }> {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  if (tab.id === undefined) throw new Error('tab without id');
  await assign(tab.id, sessionId);
  await chrome.tabs.update(tab.id, { url });
  return { tabId: tab.id };
}

chrome.runtime.onMessage.addListener((msg: { type?: string }, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || typeof msg?.type !== 'string') return false;
  let task: Promise<unknown>;
  if (msg.type.startsWith('popup:')) {
    if (!isExtensionPage(sender)) return false;
    task = run(() => handlePopup(msg as PopupMessage));
  } else {
    task = run(() => handleContent(msg as ContentMessage, sender));
  }
  task.then(sendResponse, (e: unknown) => sendResponse({ error: String(e) }));
  return true;
});

// ---------------------------------------------------------------- diagnostics / test hooks

function snapshotDiag() {
  return { ...diag, rules: { ...ruleStats, avgMs: ruleStats.updates ? ruleStats.totalMs / ruleStats.updates : 0 } };
}

/**
 * POC test surface, reachable from Playwright via `serviceWorker.evaluate`.
 * Cookie values are exposed only to the local test harness; never logged.
 */
const debugApi = {
  ready: () => run(() => true),
  assign: (tabId: number, sessionId: string | null) => run(() => assign(tabId, sessionId)),
  async assignByUrl(urlPart: string, sessionId: string | null): Promise<number> {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => (t.url ?? t.pendingUrl ?? '').includes(urlPart));
    if (tab?.id === undefined) throw new Error(`no tab with url containing ${urlPart}`);
    await run(() => assign(tab.id!, sessionId));
    return tab.id;
  },
  tabIdByUrl: async (urlPart: string) => (await chrome.tabs.query({})).find((t) => (t.url ?? t.pendingUrl ?? '').includes(urlPart))?.id ?? null,
  openTabInSession: (sessionId: string, url: string) => run(() => openTabInSession(sessionId, url)),
  reset: (sessionId: string) => run(() => resetSession(sessionId)),
  state: () =>
    run(() => ({
      tabs: Object.fromEntries(store.tabs),
      jars: Object.fromEntries([...store.jars].map(([k, j]) => [k, j.all().map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly }))])),
    })),
  diag: () => run(snapshotDiag),
  rules: () => chrome.declarativeNetRequest.getSessionRules(),
  setInheritOnOpen: (v: boolean) => {
    settings.inheritOnOpen = v;
  },
};
(globalThis as unknown as { sessionwoy: typeof debugApi }).sessionwoy = debugApi;

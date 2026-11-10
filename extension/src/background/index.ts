/**
 * SessionWoy service worker.
 *
 * All listeners are registered synchronously at top level (MV3 requirement so
 * that events wake the worker). Work is pushed through `run()`, a FIFO queue
 * whose first task is `init()` (state rehydration + full rule rebuild).
 */
import { buildSessionRules, type RuleSpec } from '../shared/rules.js';
import { backupFileName, createBackup, readBackup } from '../shared/backup.js';
import {
  UI_CHANGED,
  type ContentMessage,
  type ExportResult,
  type ImportPreview,
  type Snapshot,
  type UiMessage,
  type UiResult,
  type UiState,
} from '../shared/messages.js';
import {
  COLOR_HEX,
  badgeText,
  isGroupingMode,
  isSessionColor,
  normalizeMeta,
  summarizeCookies,
  validateName,
  type SessionMeta,
} from '../shared/sessions.js';
import { applySessionRules, replaceAllRules, ruleStats } from './dnr.js';
import {
  addToSessionGroup,
  forgetSessionGroups,
  groupAllTabs,
  onGroupRemoved,
  refreshSessionGroups,
  removeFromSessionGroup,
  ungroupAllTabs,
} from './groups.js';
import { CookieJar, mergeCookies, type StoredCookie } from '../shared/cookieJar.js';
import { serial } from './serial.js';
import { Store } from './state.js';
import { BackendSync, normalizeBackendUrl } from './backend.js';
import { TabMarkers } from './restore.js';
import { Vault, chromeArea, chromeVaultStorage } from './vault.js';

/** Replaced at build time: true only in the e2e build (`node build.mjs --e2e`). */
declare const __E2E__: boolean;

const store = new Store();
/** Encrypted cookie persistence (FR-15, ADR 0004). */
const vault = new Vault(chromeVaultStorage());
/** Tab restore markers (FR-17, ADR 0004). */
const markers = new TabMarkers(chromeArea(chrome.storage.local), chromeArea(chrome.storage.session));
/** Optional local backend sync (FR-18/20/21, ADR 0004). */
const backend = new BackendSync(chromeArea(chrome.storage.local));

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
  /** Tabs that rejoined their session after a browser restart (FR-17). */
  restoredTabsFromMarker: 0,
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

/** Tells open extension pages (popup, side panel) to re-fetch their state. */
function broadcastUi(): void {
  chrome.runtime.sendMessage({ type: UI_CHANGED }).catch(() => undefined);
}

/**
 * Host access for a URL. Without it, DNR rules and Set-Cookie capture do not apply to that origin,
 * so a managed tab there silently uses Chrome's shared cookie jar (F8). Non-web URLs need no access.
 */
async function hasHostAccess(url: string | undefined): Promise<boolean> {
  if (!url || !/^https?:\/\//.test(url)) return true;
  try {
    return await chrome.permissions.contains({ origins: [`${new URL(url).origin}/*`] });
  } catch {
    return false;
  }
}

/** Refuses to put a tab into a session on an origin SessionWoy cannot isolate (F8). */
async function requireHostAccess(url: string | undefined): Promise<void> {
  if (!(await hasHostAccess(url))) {
    throw new Error(
      `SessionWoy has no access to ${new URL(url!).origin}, so a session cannot keep its login separate there. Grant access to this site first.`,
    );
  }
}

const NO_ACCESS_BADGE = '#d93025';

async function paintBadge(tabId: number): Promise<void> {
  const sid = store.tabs.get(tabId);
  const meta = sid ? store.sessions.get(sid) : undefined;
  try {
    if (!meta) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      await chrome.action.setTitle({ tabId, title: 'SessionWoy: no session' });
      return;
    }
    const tab = await chrome.tabs.get(tabId);
    if (!(await hasHostAccess(tab.pendingUrl ?? tab.url))) {
      // F8: the session cannot apply here; warn instead of pretending.
      await chrome.action.setBadgeText({ tabId, text: '!' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: NO_ACCESS_BADGE });
      await chrome.action.setTitle({
        tabId,
        title: `SessionWoy: ${meta.name}, but no access to this site: normal Chrome cookies are used here`,
      });
      return;
    }
    await chrome.action.setBadgeText({ tabId, text: badgeText(meta.name) });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: COLOR_HEX[meta.color] });
    await chrome.action.setTitle({ tabId, title: `SessionWoy: ${meta.name}` });
  } catch {
    /* tab may be gone */
  }
}

async function repaintAllBadges(): Promise<void> {
  for (const tabId of store.tabs.keys()) await paintBadge(tabId);
}

async function reloadIfWeb(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (/^https?:/.test(tab.url ?? tab.pendingUrl ?? '')) await chrome.tabs.reload(tabId);
  } catch {
    /* tab gone */
  }
}

async function assign(tabId: number, sessionId: string | null): Promise<void> {
  if (sessionId) {
    const meta = store.sessions.get(sessionId);
    if (!meta) throw new Error('Unknown session');
    if (meta.status !== 'active') throw new Error('Session is archived');
  }
  const prev = store.tabs.get(tabId) ?? null;
  if (prev === sessionId) return;
  if (sessionId) store.tabs.set(tabId, sessionId);
  else store.tabs.delete(tabId);
  // New session's rules first, so the tab is never without a cookie-stripping rule.
  if (sessionId) await rebuild(sessionId);
  if (prev) await rebuild(prev);
  if (sessionId) await addToSessionGroup(store, tabId, sessionId);
  else if (prev) await removeFromSessionGroup(store, tabId, prev);
  // FR-17: remember (or forget) this tab's session for a later browser restart.
  if (sessionId) await markers.track(tabId, sessionId, await tabOrigin(tabId), Date.now());
  else await markers.forget(tabId);
  await store.save();
  await paintBadge(tabId);
  chrome.tabs.sendMessage(tabId, { type: 'session:changed' }).catch(() => undefined);
  broadcastUi();
}

async function tabOrigin(tabId: number): Promise<string | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.pendingUrl ?? tab.url ?? '';
    return /^https?:\/\//.test(url) ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

async function forgetTab(tabId: number): Promise<void> {
  const sid = store.tabs.get(tabId);
  if (!sid) return;
  store.tabs.delete(tabId); // FR-9: mapping only; session data is kept
  await rebuild(sid);
  await store.save();
  broadcastUi();
}

/** Unassigns every tab of a session (tabs become normal tabs and are reloaded). */
async function releaseTabs(sessionId: string): Promise<number[]> {
  const tabs = store.tabsOf(sessionId);
  for (const tabId of tabs) {
    store.tabs.delete(tabId);
    await removeFromSessionGroup(store, tabId, sessionId);
    await markers.forget(tabId);
  }
  await rebuild(sessionId);
  for (const tabId of tabs) {
    await paintBadge(tabId);
    chrome.tabs.sendMessage(tabId, { type: 'session:changed' }).catch(() => undefined);
  }
  return tabs;
}

// ---------------------------------------------------------------- encrypted vault (FR-15, ADR 0004)

let persistTimer: ReturnType<typeof setTimeout> | undefined;

/** Marks a session's cookies for encrypted saving; one debounced write covers bursts of changes. */
function persistLater(sessionId: string): void {
  vault.markDirty(sessionId);
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void run(flushVault), 500);
}

/** Encrypts and writes dirty sessions (no-op while locked or without a passphrase). */
async function flushVault(): Promise<string[]> {
  const ids = await vault.flush((id) => (store.sessions.has(id) ? (store.jars.get(id)?.all() ?? []) : undefined));
  if (ids.length) {
    await syncLater(ids); // new ciphertexts go to the backend too (FR-18)
    broadcastUi();
  }
  return ids;
}

// ---------------------------------------------------------------- local backend (FR-18/20/21, ADR 0004)

let syncTimer: ReturnType<typeof setTimeout> | undefined;

/** Queues backend work (`header`, `meta`, `wipe` or session ids) and sends it shortly, debounced. */
async function syncLater(items: string[]): Promise<void> {
  if (!backend.settings.enabled) return;
  await backend.queue(items);
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void run(syncBackend), 1000);
}

/** Whether this worker already compared the backend's vault with the local one. */
let backendVerified = false;

/**
 * Before the first push of a worker's lifetime: does the backend hold another device's vault?
 * If so, nothing is pushed until the user restores from it or explicitly replaces it.
 */
async function verifyBackend(): Promise<boolean> {
  if (backendVerified) return true;
  try {
    const remote = await backend.pull();
    backend.setRemoteDiffers(backend.differs(remote, vault.snapshot()));
    backendVerified = true;
    return true;
  } catch {
    return false; // offline: reduced mode, retried later
  }
}

/** Sends pending work, or just checks health. Offline = reduced mode (FR-20): retried every minute. */
async function syncBackend(): Promise<void> {
  if (!backend.settings.enabled) return;
  if (await verifyBackend()) {
    if (backend.hasPending()) await backend.flush(vault.snapshot(), [...store.sessions.values()]);
    else await backend.checkHealth();
  }
  broadcastUi();
}

/** Saves session metadata and settings, and mirrors the session list to the backend. */
async function saveMeta(): Promise<void> {
  await store.saveDurable();
  await syncLater(['meta']);
}

function allSavedIds(): string[] {
  return Object.keys(vault.snapshot()?.sessions ?? {});
}

async function configureBackend(patch: { enabled?: unknown; url?: unknown; secret?: unknown }): Promise<void> {
  const url = patch.url !== undefined ? normalizeBackendUrl(patch.url) : backend.settings.url;
  if (patch.enabled === true && !(await hasHostAccess(`${url}/`))) {
    throw new Error(`SessionWoy has no access to ${url}. Allow it when asked, then try again.`);
  }
  await backend.configure(patch);
  backendVerified = false;
  // Connecting never overwrites what is already there: compare first (see verifyBackend).
  if (backend.settings.enabled && (await verifyBackend())) await backend.pushAll(vault.snapshot(), [...store.sessions.values()]);
  broadcastUi();
}

/** Replaces this device's saved logins with the backend's copy (needs the same passphrase). */
async function restoreFromBackend(passphrase: unknown): Promise<{ sessions: number }> {
  if (typeof passphrase !== 'string') throw new Error('Passphrase is required');
  if (!backend.settings.enabled) throw new Error('Connect the backend first');
  const remote = await backend.pull();
  if (!remote.header) throw new Error('The backend has no saved logins yet');
  const record = {
    v: 1 as const,
    kdf: remote.header.kdf,
    keyVersion: remote.header.keyVersion,
    check: remote.header.check,
    sessions: Object.fromEntries(
      Object.entries(remote.sessions)
        .filter(([, s]) => s.keyVersion === remote.header!.keyVersion)
        .map(([id, s]) => [id, { iv: s.iv, ct: s.ct, updatedAt: s.updatedAt }]),
    ),
  };
  const saved = await vault.adopt(record, passphrase);
  backend.setRemoteDiffers(false); // this device now holds the backend's vault
  backendVerified = true;
  // Session list: add the ones this device does not have; newer metadata wins.
  for (const raw of remote.meta ?? []) {
    const m = normalizeMeta(raw);
    if (!m) continue;
    const local = store.sessions.get(m.id);
    if (!local || local.updatedAt < m.updatedAt) store.sessions.set(m.id, m);
  }
  await saveMeta();
  await applySavedCookies(saved);
  return { sessions: Object.keys(saved).length };
}

function jarsSnapshot(): Record<string, StoredCookie[]> {
  return Object.fromEntries(
    [...store.jars].filter(([sid, jar]) => store.sessions.has(sid) && jar.size > 0).map(([sid, jar]) => [sid, jar.all()]),
  );
}

/** Puts decrypted cookies back into memory; cookies captured while locked win. Reloads session tabs. */
async function applySavedCookies(saved: Record<string, StoredCookie[]>): Promise<void> {
  const now = Date.now();
  for (const [sid, cookies] of Object.entries(saved)) {
    if (!store.sessions.has(sid)) {
      await vault.remove(sid); // orphaned entry (session deleted elsewhere)
      continue;
    }
    store.jars.set(sid, new CookieJar(mergeCookies(store.jar(sid).all(), cookies, now)));
    await rebuild(sid);
    notifySession(sid);
  }
  // Cookies captured while locked are saved now that the key is available.
  for (const [sid, jar] of store.jars) if (store.sessions.has(sid) && jar.size) vault.markDirty(sid);
  await flushVault();
  await store.save();
  for (const tabId of store.tabs.keys()) await reloadIfWeb(tabId);
  broadcastUi();
}

async function setupVault(passphrase: unknown): Promise<void> {
  if (typeof passphrase !== 'string') throw new Error('Passphrase is required');
  await vault.setup(passphrase, jarsSnapshot());
  await syncLater(['header', 'meta', ...allSavedIds()]);
  broadcastUi();
}

async function unlockVault(passphrase: unknown): Promise<void> {
  if (typeof passphrase !== 'string') throw new Error('Passphrase is required');
  await applySavedCookies(await vault.unlock(passphrase));
}

/** Lock now: save, drop the key, and log every session tab out until the next unlock. */
async function lockVault(): Promise<void> {
  if (vault.state !== 'unlocked') return;
  for (const sid of store.jars.keys()) vault.markDirty(sid);
  await flushVault();
  await vault.lock();
  for (const sid of [...store.jars.keys()]) {
    store.jars.delete(sid);
    await rebuild(sid);
    notifySession(sid);
  }
  await store.save();
  for (const tabId of store.tabs.keys()) await reloadIfWeb(tabId);
  broadcastUi();
}

// ---------------------------------------------------------------- backup file (FR-19, ADR 0004)

async function exportBackup(passphrase: unknown): Promise<ExportResult> {
  if (typeof passphrase !== 'string') throw new Error('Passphrase is required');
  if (vault.state === 'locked') throw new Error('Unlock your saved logins first, so the backup includes them');
  const file = await createBackup({ sessions: [...store.sessions.values()], cookies: jarsSnapshot() }, passphrase);
  return { fileName: backupFileName(), data: JSON.stringify(file, null, 2) };
}

/** Preview (`apply: false`) or apply an import. Same session id = replaced (metadata and cookies). */
async function importBackup(data: unknown, passphrase: unknown, apply: boolean): Promise<ImportPreview> {
  if (typeof data !== 'string' || typeof passphrase !== 'string') throw new Error('Choose a backup file and enter its passphrase');
  if (data.length > 20_000_000) throw new Error('Backup file is too large');
  if (vault.state === 'locked') throw new Error('Unlock your saved logins first');
  const content = await readBackup(data, passphrase);
  const sessions = content.sessions.map((s) => ({
    id: s.id,
    name: s.name,
    cookies: content.cookies[s.id]?.length ?? 0,
    exists: store.sessions.has(s.id),
  }));
  if (!apply) return { sessions };
  for (const meta of content.sessions) {
    store.sessions.set(meta.id, meta);
    store.jars.set(meta.id, new CookieJar(content.cookies[meta.id] ?? []));
    await rebuild(meta.id);
    persistLater(meta.id);
    notifySession(meta.id);
    await refreshSessionGroups(store, meta.id);
    for (const tabId of store.tabsOf(meta.id)) {
      await paintBadge(tabId);
      await reloadIfWeb(tabId);
    }
  }
  await saveMeta();
  await store.save();
  broadcastUi();
  return { sessions, imported: content.sessions.length };
}

/** FR-3: clears the session's cookies, keeps its tabs assigned and reloads them. */
async function resetSession(sessionId: string): Promise<void> {
  store.jar(sessionId).clear();
  persistLater(sessionId);
  await rebuild(sessionId);
  await store.save();
  notifySession(sessionId);
  for (const tabId of store.tabsOf(sessionId)) await reloadIfWeb(tabId);
  broadcastUi();
}

function requireSession(id: string): SessionMeta {
  const meta = store.sessions.get(id);
  if (!meta) throw new Error('Unknown session');
  return meta;
}

async function createSession(name: unknown, color: unknown): Promise<SessionMeta> {
  const v = validateName(name);
  if (!v.ok) throw new Error(v.error);
  const meta = store.createSession(v.name, isSessionColor(color) ? color : undefined);
  await saveMeta();
  broadcastUi();
  return meta;
}

async function updateSession(id: string, patch: { name?: unknown; color?: unknown }): Promise<SessionMeta> {
  const meta = requireSession(id);
  if (patch.name !== undefined) {
    const v = validateName(patch.name);
    if (!v.ok) throw new Error(v.error);
    meta.name = v.name;
  }
  if (patch.color !== undefined) {
    if (!isSessionColor(patch.color)) throw new Error('Unknown color');
    meta.color = patch.color;
  }
  meta.updatedAt = Date.now();
  await saveMeta();
  await refreshSessionGroups(store, id);
  for (const tabId of store.tabsOf(id)) await paintBadge(tabId);
  await store.save();
  notifySession(id); // recolor: tabs refresh their favicon dot
  broadcastUi();
  return meta;
}

/** Archive: tabs are released, cookies are kept (in memory), the session is hidden from the popup. */
async function archiveSession(id: string): Promise<void> {
  const meta = requireSession(id);
  const tabs = await releaseTabs(id);
  forgetSessionGroups(store, id);
  meta.status = 'archived';
  meta.updatedAt = Date.now();
  await store.save();
  await saveMeta();
  for (const tabId of tabs) await reloadIfWeb(tabId);
  broadcastUi();
}

async function restoreSession(id: string): Promise<void> {
  const meta = requireSession(id);
  meta.status = 'active';
  meta.updatedAt = Date.now();
  await saveMeta();
  broadcastUi();
}

/** FR-2: deleting a session deletes all of its data (cookies, rules, groups, metadata). */
async function deleteSession(id: string): Promise<void> {
  requireSession(id);
  const tabs = await releaseTabs(id);
  forgetSessionGroups(store, id);
  store.dropSession(id);
  await vault.remove(id); // its saved (encrypted) cookies go too
  await markers.forgetSession(id);
  await syncLater([id]); // removes its ciphertext from the backend
  await applySessionRules(id, []);
  await store.save();
  await saveMeta();
  for (const tabId of tabs) await reloadIfWeb(tabId);
  broadcastUi();
}

async function updateSettings(patch: { inheritOnOpen?: unknown; grouping?: unknown }): Promise<void> {
  if (patch.grouping !== undefined && !isGroupingMode(patch.grouping)) throw new Error('Unknown mode');
  if (typeof patch.inheritOnOpen === 'boolean') store.settings.inheritOnOpen = patch.inheritOnOpen;
  if (isGroupingMode(patch.grouping) && patch.grouping !== store.settings.grouping) {
    store.settings.grouping = patch.grouping;
    // Only the marker changes: every tab keeps its session.
    if (patch.grouping === 'group') await groupAllTabs(store);
    else await ungroupAllTabs(store);
    await store.save();
  }
  await saveMeta();
  broadcastUi();
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
      persistLater(sid);
      await rebuild(sid);
      notifySession(sid);
    }
  }
  if (changed) {
    await store.save();
    broadcastUi();
  }
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
  // Unlocked after a worker restart (key in session memory); locked after a browser restart.
  await vault.load().catch((e: unknown) => console.error('[sessionwoy] vault load failed', e));
  // FR-17: empty session memory = browser start or extension reload. Open the restore window here,
  // as the first queued task, so restored tabs cannot report their marker before it is open.
  const freshStart = await markers.load();
  await backend.load();
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
  // Leftover groups from "per group" mode (or from before the per-tab default) are removed.
  if (store.settings.grouping === 'tab' && store.groups.size) await ungroupAllTabs(store);
  await store.save();
  for (const tabId of store.tabs.keys()) await paintBadge(tabId);
  await syncContentScripts().catch((e: unknown) => console.error('[sessionwoy] content script sync failed', e));
  await chrome.alarms.create('sessionwoy-purge', { periodInMinutes: 1 });
  if (freshStart) await openRestoreWindow();
  // A restore window that ended while the worker was asleep is closed now.
  else if (!markers.status(Date.now()).active) await markers.closeWindow();
}

void run(init);
// Not awaited inside init(): an unreachable backend must never delay startup (reduced mode).
void run(syncBackend);

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
  persistLater(sid);
  notifySession(sid);
  broadcastUi();
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
  if (sourceTabId === undefined || newTabId === undefined) return;
  void run(async () => {
    if (!store.settings.inheritOnOpen) return;
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

chrome.tabs.onRemoved.addListener((tabId, info) =>
  void run(async () => {
    // Closing the window (e.g. quitting Chrome) keeps the restore marker for the next start (FR-17);
    // closing a single tab forgets it.
    if (info.isWindowClosing) await markers.detach(tabId);
    else await markers.forget(tabId);
    await forgetTab(tabId);
  }),
);

// FR-17: after a browser start (or an extension update/reload), restored tabs may rejoin their
// sessions for a short window (see background/restore.ts). Opened from init(); no onStartup listener,
// because a restored tab can report its marker before onStartup would be handled.
async function openRestoreWindow(): Promise<void> {
  const until = await markers.openWindow(Date.now());
  await chrome.alarms.create('sessionwoy-restore-end', { when: until });
  broadcastUi();
}
async function closeRestoreWindow(): Promise<void> {
  await markers.closeWindow();
  broadcastUi();
}

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

// A managed tab dragged to another window joins its session's group there.
chrome.tabs.onAttached.addListener((tabId) =>
  void run(async () => {
    const sid = store.tabs.get(tabId);
    if (!sid) return;
    await addToSessionGroup(store, tabId, sid);
    await store.save();
  }),
);

chrome.tabGroups.onRemoved.addListener((group) =>
  void run(async () => {
    if (onGroupRemoved(store, group.id)) await store.save();
  }),
);

chrome.tabs.onUpdated.addListener((tabId, info) => {
  // Repaint on navigation: the "!" no-access warning depends on the tab's current site (F8).
  if (info.status === 'loading' || info.url) void run(() => (store.tabs.has(tabId) ? paintBadge(tabId) : undefined));
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'sessionwoy-purge') {
    void run(purgeAll);
    void run(flushVault); // backstop in case a debounced save was lost with a suspended worker
  }
  if (a.name === 'sessionwoy-restore-end') void run(closeRestoreWindow);
  if (a.name === 'sessionwoy-purge') void run(syncBackend); // FR-20 retry + FR-21 health, every minute
});

const onPermissionsChanged = () =>
  void run(async () => {
    await syncContentScripts();
    await repaintAllBadges(); // "!" appears or disappears (F8)
    broadcastUi();
  });
chrome.permissions.onAdded.addListener(onPermissionsChanged);
chrome.permissions.onRemoved.addListener(onPermissionsChanged);

// ---------------------------------------------------------------- messages

/** Popup and side panel (also when opened as a tab) — never a content script, whose URL is http(s). */
function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && (sender.url ?? '').startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

/**
 * FR-17: a restored tab (new id after a browser restart) reports its marker. Only inside the restore
 * window, only once per marker, only from the top frame, and only if the origin matches.
 */
async function restoreTab(tabId: number, marker: unknown, origin: string, topFrame: boolean): Promise<{ restored: boolean }> {
  if (!topFrame || typeof marker !== 'string' || store.tabs.has(tabId)) return { restored: false };
  const sid = await markers.claim(marker, origin, tabId, Date.now());
  if (!sid || store.sessions.get(sid)?.status !== 'active') return { restored: false };
  await assign(tabId, sid);
  diag.restoredTabsFromMarker++;
  await reloadIfWeb(tabId); // the first load went out without the session's cookies
  return { restored: true };
}

async function handleContent(msg: ContentMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || !sender.url || !/^https?:/.test(sender.url)) return { managed: false } satisfies Snapshot;
  const topFrame = sender.frameId === 0;
  if (msg.type === 'tab:restore') return restoreTab(tabId, msg.marker, new URL(sender.url).origin, topFrame);
  const sid = store.tabs.get(tabId);
  if (!sid) return { managed: false } satisfies Snapshot;
  // The frame URL comes from Chrome (sender.url), never from page-supplied data.
  const url = new URL(sender.url);
  const jar = store.jar(sid);
  const now = Date.now();
  switch (msg.type) {
    case 'snapshot:get':
      return {
        managed: true,
        sessionId: sid,
        cookies: jar.scriptVisibleForHost(url, now),
        color: COLOR_HEX[store.sessions.get(sid)?.color ?? 'grey'],
        // FR-17: the top frame keeps the marker; its origin is updated on every page load.
        ...(topFrame ? { marker: await markers.track(tabId, sid, url.origin, now) } : {}),
      } satisfies Snapshot;
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
        persistLater(sid);
        notifySession(sid, tabId);
        broadcastUi();
      }
      return { ok: true };
    }
    default:
      return { error: 'unknown message' };
  }
}

function uiState(tabId?: number): UiState {
  const now = Date.now();
  const sessions = [...store.sessions.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((s) => ({
      ...s,
      tabCount: store.tabsOf(s.id).length,
      cookieCount: store.jars.get(s.id)?.all().filter((c) => c.expires === null || c.expires > now).length ?? 0,
    }));
  return {
    sessions,
    settings: { ...store.settings },
    tabSessionId: tabId !== undefined ? (store.tabs.get(tabId) ?? null) : null,
    vault: vault.summary(),
    restore: markers.status(now),
    backend: backend.summary(),
    diag: snapshotDiag(),
  };
}

function isOpenableUrl(url: unknown): url is string {
  return typeof url === 'string' && (/^https?:\/\//.test(url) || url === 'about:blank');
}

async function handleUi(msg: UiMessage): Promise<UiResult> {
  try {
    switch (msg.type) {
      case 'ui:state':
        return { ok: true, data: uiState(msg.tabId) };
      case 'ui:create': {
        // Check access before creating, so a refused assignment leaves no half-done session.
        if (typeof msg.assignTabId === 'number') await requireHostAccess((await chrome.tabs.get(msg.assignTabId)).url);
        const meta = await createSession(msg.name, msg.color);
        if (typeof msg.assignTabId === 'number') {
          await assign(msg.assignTabId, meta.id);
          await reloadIfWeb(msg.assignTabId);
        }
        return { ok: true, data: meta };
      }
      case 'ui:update':
        return { ok: true, data: await updateSession(msg.id, { name: msg.name, color: msg.color }) };
      case 'ui:archive':
        await archiveSession(msg.id);
        return { ok: true, data: null };
      case 'ui:restore':
        await restoreSession(msg.id);
        return { ok: true, data: null };
      case 'ui:delete':
        await deleteSession(msg.id);
        return { ok: true, data: null };
      case 'ui:reset':
        requireSession(msg.id);
        await resetSession(msg.id);
        return { ok: true, data: null };
      case 'ui:assign':
        if (typeof msg.tabId !== 'number') throw new Error('Missing tab');
        if (msg.sessionId) await requireHostAccess((await chrome.tabs.get(msg.tabId)).url);
        await assign(msg.tabId, msg.sessionId);
        await reloadIfWeb(msg.tabId);
        return { ok: true, data: null };
      case 'ui:openTab':
        if (!isOpenableUrl(msg.url)) throw new Error('Only http(s) pages can be opened in a session');
        await requireHostAccess(msg.url);
        return { ok: true, data: await openTabInSession(msg.sessionId, msg.url) };
      case 'ui:cookies':
        requireSession(msg.id);
        return { ok: true, data: summarizeCookies(store.jars.get(msg.id)?.all() ?? [], Date.now()) };
      case 'ui:settings':
        await updateSettings(msg.patch ?? {});
        return { ok: true, data: { ...store.settings } };
      case 'ui:permissionsChanged':
        await syncContentScripts();
        return { ok: true, data: null };
      case 'ui:vaultSetup':
        await setupVault(msg.passphrase);
        return { ok: true, data: vault.summary() };
      case 'ui:unlock':
        await unlockVault(msg.passphrase);
        return { ok: true, data: vault.summary() };
      case 'ui:lock':
        await lockVault();
        return { ok: true, data: vault.summary() };
      case 'ui:changePassphrase':
        if (typeof msg.current !== 'string' || typeof msg.next !== 'string') throw new Error('Passphrase is required');
        await vault.changePassphrase(msg.current, msg.next);
        await syncLater(['header', ...allSavedIds()]); // new key: everything is re-encrypted
        broadcastUi();
        return { ok: true, data: vault.summary() };
      case 'ui:vaultReset':
        await vault.reset(); // forget saved logins; current in-memory logins keep working
        await syncLater(['wipe']);
        broadcastUi();
        return { ok: true, data: vault.summary() };
      case 'ui:export':
        return { ok: true, data: await exportBackup(msg.passphrase) };
      case 'ui:import':
        return { ok: true, data: await importBackup(msg.data, msg.passphrase, msg.apply === true) };
      case 'ui:dismissRestore':
        await markers.dismiss();
        broadcastUi();
        return { ok: true, data: null };
      case 'ui:backend':
        await configureBackend(msg.patch ?? {});
        return { ok: true, data: backend.summary() };
      case 'ui:backendSync':
        if (msg.replace === true) {
          // Explicit user choice: replace the backend's vault with this device's.
          await backend.replaceRemote(vault.snapshot(), [...store.sessions.values()]);
          backendVerified = true;
        } else if (await verifyBackend()) {
          await backend.pushAll(vault.snapshot(), [...store.sessions.values()]);
        }
        broadcastUi();
        return { ok: true, data: backend.summary() };
      case 'ui:backendRestore':
        return { ok: true, data: await restoreFromBackend(msg.passphrase) };
      default:
        return { ok: false, error: 'Unknown message' };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** FR-5: create the tab blank, install rules, then navigate — so the first request already carries the session. */
async function openTabInSession(sessionId: string, url: string): Promise<{ tabId: number }> {
  const meta = requireSession(sessionId);
  if (meta.status !== 'active') throw new Error('Session is archived');
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  if (tab.id === undefined) throw new Error('tab without id');
  await assign(tab.id, sessionId);
  await chrome.tabs.update(tab.id, { url });
  return { tabId: tab.id };
}

chrome.runtime.onMessage.addListener((msg: { type?: string }, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || typeof msg?.type !== 'string') return false;
  if (msg.type === UI_CHANGED) return false; // our own broadcast
  let task: Promise<unknown>;
  if (msg.type.startsWith('ui:')) {
    if (!isExtensionPage(sender)) return false;
    task = run(() => handleUi(msg as UiMessage));
  } else {
    task = run(() => handleContent(msg as ContentMessage, sender));
  }
  task.then(sendResponse, (e: unknown) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

// ---------------------------------------------------------------- diagnostics / test hooks

function snapshotDiag() {
  return { ...diag, rules: { ...ruleStats, avgMs: ruleStats.updates ? ruleStats.totalMs / ruleStats.updates : 0 } };
}

if (__E2E__) {
  /** Debug sessions are created on demand with id = name (e2e build only). */
  const ensureDebugSession = async (id: string) => {
    if (!store.sessions.has(id)) {
      store.createSession(id, undefined, id);
      await saveMeta();
    }
  };

  /**
   * Test surface, reachable from Playwright via `serviceWorker.evaluate`. Present only in the
   * e2e build (`extension/dist-e2e`); the release build removes it (ADR 0003).
   * Cookie values are exposed only to the local test harness; never logged.
   */
  const debugApi = {
    ready: () => run(() => true),
    assign: (tabId: number, sessionId: string | null) =>
      run(async () => {
        if (sessionId) await ensureDebugSession(sessionId);
        await assign(tabId, sessionId);
      }),
    async assignByUrl(urlPart: string, sessionId: string | null): Promise<number> {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => (t.url ?? t.pendingUrl ?? '').includes(urlPart));
      if (tab?.id === undefined) throw new Error(`no tab with url containing ${urlPart}`);
      await debugApi.assign(tab.id, sessionId);
      return tab.id;
    },
    tabIdByUrl: async (urlPart: string) => (await chrome.tabs.query({})).find((t) => (t.url ?? t.pendingUrl ?? '').includes(urlPart))?.id ?? null,
    openTabInSession: (sessionId: string, url: string) =>
      run(async () => {
        await ensureDebugSession(sessionId);
        return openTabInSession(sessionId, url);
      }),
    reset: (sessionId: string) => run(() => resetSession(sessionId)),
    /** Calls the same handler the popup / side panel use. */
    ui: (msg: UiMessage) => run(() => handleUi(msg)),
    state: () =>
      run(() => ({
        tabs: Object.fromEntries(store.tabs),
        jars: Object.fromEntries([...store.jars].map(([k, j]) => [k, j.all().map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly }))])),
        groups: Object.fromEntries(store.groups),
      })),
    diag: () => run(snapshotDiag),
    rules: () => chrome.declarativeNetRequest.getSessionRules(),
    setInheritOnOpen: (v: boolean) => run(() => updateSettings({ inheritOnOpen: v })),
    /** Ends the FR-17 restore window now instead of after 90 s. */
    endRestoreWindow: () => run(closeRestoreWindow),
  };
  (globalThis as unknown as { sessionwoy: typeof debugApi }).sessionwoy = debugApi;
}

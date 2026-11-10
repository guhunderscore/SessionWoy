import { CookieJar, type StoredCookie } from '../shared/cookieJar.js';
import {
  DEFAULT_SETTINGS,
  isSessionColor,
  nextColor,
  normalizeMeta,
  normalizeSettings,
  type SessionColor,
  type SessionMeta,
  type Settings,
} from '../shared/sessions.js';

export type { SessionMeta, Settings } from '../shared/sessions.js';

/**
 * Durable, non-secret data in chrome.storage.local (PRD §10): survives extension reloads and
 * browser restarts. Session cookies are NOT stored here until Phase 4 adds encryption.
 */
const LOCAL_SESSIONS_KEY = 'sessionwoy:sessions:v1';
const LOCAL_SETTINGS_KEY = 'sessionwoy:settings:v1';

/**
 * Runtime state in chrome.storage.session (memory only, cleared on browser restart or extension
 * reload, not readable by content scripts). Survives service-worker suspension (FR-16).
 */
const RUNTIME_KEY = 'sessionwoy:runtime:v2';

interface RuntimeState {
  v: 2;
  tabs: Record<string, string>;
  jars: Record<string, StoredCookie[]>;
  /** `${sessionId}:${windowId}` -> tab group id. */
  groups: Record<string, number>;
}

export class Store {
  readonly sessions = new Map<string, SessionMeta>();
  readonly tabs = new Map<number, string>();
  readonly jars = new Map<string, CookieJar>();
  readonly groups = new Map<string, number>();
  settings: Settings = { ...DEFAULT_SETTINGS };

  async load(): Promise<void> {
    const local = await chrome.storage.local.get([LOCAL_SESSIONS_KEY, LOCAL_SETTINGS_KEY]);
    const runtime = (await chrome.storage.session.get(RUNTIME_KEY))[RUNTIME_KEY] as RuntimeState | undefined;
    this.sessions.clear();
    this.tabs.clear();
    this.jars.clear();
    this.groups.clear();

    const rawSessions = local[LOCAL_SESSIONS_KEY];
    if (Array.isArray(rawSessions)) {
      for (const raw of rawSessions) {
        const meta = normalizeMeta(raw);
        if (meta) this.sessions.set(meta.id, meta);
      }
    }
    this.settings = normalizeSettings(local[LOCAL_SETTINGS_KEY]);

    if (runtime?.v === 2) {
      for (const [tab, sid] of Object.entries(runtime.tabs)) if (this.sessions.has(sid)) this.tabs.set(Number(tab), sid);
      for (const [sid, cookies] of Object.entries(runtime.jars)) if (this.sessions.has(sid)) this.jars.set(sid, new CookieJar(cookies));
      for (const [key, groupId] of Object.entries(runtime.groups)) this.groups.set(key, groupId);
    }
  }

  /** Saves runtime state (tabs, jars, groups). Cheap; called after most mutations. */
  async save(): Promise<void> {
    const state: RuntimeState = {
      v: 2,
      tabs: Object.fromEntries([...this.tabs].map(([k, v]) => [String(k), v])),
      jars: Object.fromEntries([...this.jars].map(([k, j]) => [k, j.all()])),
      groups: Object.fromEntries(this.groups),
    };
    await chrome.storage.session.set({ [RUNTIME_KEY]: state });
  }

  /** Saves session metadata and settings (durable). Called only when they change. */
  async saveDurable(): Promise<void> {
    await chrome.storage.local.set({
      [LOCAL_SESSIONS_KEY]: [...this.sessions.values()],
      [LOCAL_SETTINGS_KEY]: this.settings,
    });
  }

  createSession(name: string, color?: SessionColor, id: string = crypto.randomUUID()): SessionMeta {
    const now = Date.now();
    const meta: SessionMeta = {
      id,
      name,
      color: color && isSessionColor(color) ? color : nextColor([...this.sessions.values()]),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, meta);
    return meta;
  }

  /** Removes a session and its cookies from memory (caller handles tabs, rules and saving). */
  dropSession(id: string): void {
    this.sessions.delete(id);
    this.jars.delete(id);
  }

  jar(sessionId: string): CookieJar {
    let j = this.jars.get(sessionId);
    if (!j) {
      j = new CookieJar();
      this.jars.set(sessionId, j);
    }
    return j;
  }

  tabsOf(sessionId: string): number[] {
    return [...this.tabs].filter(([, sid]) => sid === sessionId).map(([t]) => t);
  }
}

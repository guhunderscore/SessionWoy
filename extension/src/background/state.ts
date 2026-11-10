import { CookieJar, type StoredCookie } from '../shared/cookieJar.js';

export interface SessionMeta {
  id: string;
  name: string;
  color: string;
  status: 'active' | 'archived';
  createdAt: number;
  updatedAt: number;
}

interface PersistedState {
  v: 1;
  sessions: Record<string, SessionMeta>;
  tabs: Record<string, string>;
  jars: Record<string, StoredCookie[]>;
}

/** POC: hard-coded sessions. Phase 3 replaces this with user-created sessions. */
export const PRESETS: Record<string, { name: string; color: string }> = {
  A: { name: 'Customer', color: '#2563eb' },
  B: { name: 'Provider', color: '#ea580c' },
  C: { name: 'Admin', color: '#16a34a' },
};

const KEY = 'sessionwoy:state:v1';

/**
 * Runtime state. Mirrored to chrome.storage.session (memory-only, cleared on
 * browser restart, not readable by content scripts) so it survives service
 * worker suspension (FR-16). Encrypted persistence in storage.local is Phase 4.
 */
export class Store {
  readonly sessions = new Map<string, SessionMeta>();
  readonly tabs = new Map<number, string>();
  readonly jars = new Map<string, CookieJar>();

  async load(): Promise<void> {
    const raw = (await chrome.storage.session.get(KEY))[KEY] as PersistedState | undefined;
    this.sessions.clear();
    this.tabs.clear();
    this.jars.clear();
    if (!raw || raw.v !== 1) return;
    for (const [id, meta] of Object.entries(raw.sessions)) this.sessions.set(id, meta);
    for (const [tab, sid] of Object.entries(raw.tabs)) this.tabs.set(Number(tab), sid);
    for (const [sid, cookies] of Object.entries(raw.jars)) this.jars.set(sid, new CookieJar(cookies));
  }

  async save(): Promise<void> {
    const state: PersistedState = {
      v: 1,
      sessions: Object.fromEntries(this.sessions),
      tabs: Object.fromEntries([...this.tabs].map(([k, v]) => [String(k), v])),
      jars: Object.fromEntries([...this.jars].map(([k, j]) => [k, j.all()])),
    };
    await chrome.storage.session.set({ [KEY]: state });
  }

  ensureSession(id: string): SessionMeta {
    let meta = this.sessions.get(id);
    if (!meta) {
      const preset = PRESETS[id] ?? { name: id, color: '#6b7280' };
      const now = Date.now();
      meta = { id, ...preset, status: 'active', createdAt: now, updatedAt: now };
      this.sessions.set(id, meta);
    }
    return meta;
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

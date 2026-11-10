/**
 * Restoring tab sessions after a browser restart (FR-17, ADR 0004).
 *
 * Chrome gives restored tabs new ids, so ids cannot be used. Instead every session tab gets a random
 * **marker**: the content script keeps it in the page's sessionStorage (Chrome restores
 * sessionStorage with restored tabs), and the worker keeps a durable list
 * `marker -> { sessionId, origin }` in chrome.storage.local (no secrets).
 *
 * After a browser start (or an extension update/reload), detected as empty session memory when the
 * worker initializes (before any message is handled, so no restored tab can report too early), a
 * **restore window** opens. A restored tab
 * reports its marker; if it is listed **and** the tab's top-frame origin matches, the tab rejoins its
 * session. Outside the window a reported marker does nothing, so a page cannot pull itself into a
 * session by replaying a marker later. When the window closes, entries nobody claimed are dropped and
 * counted, so the UI can tell the user how many tabs could not be restored.
 */
import type { RestoreStatus } from '../shared/messages.js';
import type { KeyValueArea } from './vault.js';

export type { RestoreStatus };

export interface MarkerEntry {
  sessionId: string;
  /** Origin of the tab's last top-level page while it was in the session. */
  origin: string;
  savedAt: number;
}

export const RESTORE_WINDOW_MS = 90_000;
const DURABLE_KEY = 'sessionwoy:tab-markers:v1';
const RUNTIME_KEY = 'sessionwoy:tab-markers-runtime:v1';

interface RuntimeState {
  byTab: Record<string, string>;
  restoreUntil: number;
  claimed: string[];
  unrestored: number;
}

function newMarker(): string {
  return crypto.randomUUID();
}

export class TabMarkers {
  private entries = new Map<string, MarkerEntry>();
  private byTab = new Map<number, string>();
  private claimed = new Set<string>();
  private restoreUntil = 0;
  private unrestored = 0;

  constructor(
    private readonly local: KeyValueArea,
    private readonly memory: KeyValueArea,
  ) {}

  /**
   * Returns true when session memory was empty: the browser just started or the extension was
   * reloaded, which is exactly when restored tabs may need to rejoin their sessions.
   */
  async load(): Promise<boolean> {
    const durable = (await this.local.get(DURABLE_KEY)) as Record<string, MarkerEntry> | undefined;
    this.entries = new Map(Object.entries(durable && typeof durable === 'object' ? durable : {}));
    const rt = (await this.memory.get(RUNTIME_KEY)) as RuntimeState | undefined;
    this.byTab = new Map(Object.entries(rt?.byTab ?? {}).map(([k, v]) => [Number(k), v]));
    this.claimed = new Set(rt?.claimed ?? []);
    this.restoreUntil = rt?.restoreUntil ?? 0;
    this.unrestored = rt?.unrestored ?? 0;
    return rt === undefined;
  }

  private async save(): Promise<void> {
    await this.local.set(DURABLE_KEY, Object.fromEntries(this.entries));
    const rt: RuntimeState = {
      byTab: Object.fromEntries([...this.byTab].map(([k, v]) => [String(k), v])),
      restoreUntil: this.restoreUntil,
      claimed: [...this.claimed],
      unrestored: this.unrestored,
    };
    await this.memory.set(RUNTIME_KEY, rt);
  }

  status(now: number): RestoreStatus {
    return { active: now < this.restoreUntil, unrestored: this.unrestored };
  }

  /** Marker of a session tab, created on first use; records the session and the top-level origin. */
  async track(tabId: number, sessionId: string, origin: string | null, now: number): Promise<string> {
    let marker = this.byTab.get(tabId);
    if (!marker) {
      marker = newMarker();
      this.byTab.set(tabId, marker);
    }
    const prev = this.entries.get(marker);
    const next: MarkerEntry = { sessionId, origin: origin ?? prev?.origin ?? '', savedAt: now };
    if (!prev || prev.sessionId !== next.sessionId || prev.origin !== next.origin) {
      this.entries.set(marker, next);
      await this.save();
    }
    return marker;
  }

  /** The tab left its session or was closed on purpose: its marker can never restore again. */
  async forget(tabId: number): Promise<void> {
    const marker = this.byTab.get(tabId);
    if (!marker) return;
    this.byTab.delete(tabId);
    this.entries.delete(marker);
    await this.save();
  }

  /** The tab's window is closing (e.g. Chrome quits): keep its entry for the next start. */
  async detach(tabId: number): Promise<void> {
    if (this.byTab.delete(tabId)) await this.save();
  }

  /** Drops all entries of a deleted session. */
  async forgetSession(sessionId: string): Promise<void> {
    let changed = false;
    for (const [m, e] of this.entries) {
      if (e.sessionId === sessionId) {
        this.entries.delete(m);
        changed = true;
      }
    }
    for (const [tab, m] of this.byTab) if (!this.entries.has(m)) this.byTab.delete(tab);
    if (changed) await this.save();
  }

  async openWindow(now: number, ms = RESTORE_WINDOW_MS): Promise<number> {
    this.restoreUntil = now + ms;
    this.claimed.clear();
    this.unrestored = 0;
    // Markers of tabs that are not open any more are the only restore candidates.
    this.byTab.clear();
    await this.save();
    return this.restoreUntil;
  }

  /**
   * A restored tab reports its marker. Returns the session to rejoin, or null when the window is
   * closed, the marker is unknown or already claimed, or the origin does not match.
   */
  async claim(marker: string, origin: string, tabId: number, now: number): Promise<string | null> {
    if (now >= this.restoreUntil) return null;
    const entry = this.entries.get(marker);
    if (!entry || this.claimed.has(marker) || entry.origin !== origin) return null;
    this.claimed.add(marker);
    this.byTab.set(tabId, marker);
    await this.save();
    return entry.sessionId;
  }

  /** Closes the window: unclaimed entries are dropped and counted. Returns that count. */
  async closeWindow(): Promise<number> {
    if (this.restoreUntil === 0) return this.unrestored;
    this.restoreUntil = 0;
    let missing = 0;
    for (const marker of [...this.entries.keys()]) {
      if (!this.claimed.has(marker)) {
        this.entries.delete(marker);
        missing++;
      }
    }
    this.claimed.clear();
    this.unrestored = missing;
    await this.save();
    return missing;
  }

  async dismiss(): Promise<void> {
    this.unrestored = 0;
    await this.save();
  }
}

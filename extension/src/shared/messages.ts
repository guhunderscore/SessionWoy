import type { StoredCookie } from './cookieJar.js';
import type { CookieSummary, SessionColor, SessionMeta, Settings } from './sessions.js';

/** Channel names between the MAIN-world hook and the ISOLATED-world relay (JSON string payloads). */
export const TO_MAIN = 'sessionwoy:to-main';
export const TO_RELAY = 'sessionwoy:to-relay';
/** sessionStorage key caching the last managed snapshot, so reloads have a synchronous answer. */
export const SNAPSHOT_CACHE_KEY = '__sessionwoy_snapshot';

export type Snapshot =
  | { managed: false }
  | {
      managed: true;
      sessionId: string;
      cookies: StoredCookie[];
      /** Session color (hex) for the favicon dot marker; not secret. */
      color?: string;
      /** Top frame only: this tab's restore marker, kept in sessionStorage (FR-17). */
      marker?: string;
    };

/** sessionStorage key holding the tab's restore marker (top frame). */
export const TAB_MARKER_KEY = '__sessionwoy_tab';

/** MAIN world -> relay. */
export type MainToRelay =
  | { type: 'set'; value: string }
  | { type: 'import'; values: string[] };

/** Content scripts -> service worker. */
export type ContentMessage =
  | { type: 'snapshot:get' }
  | { type: 'cookie:set'; value: string }
  | { type: 'cookie:import'; values: string[] }
  /** A restored tab reports the marker it had before the browser restart (FR-17). */
  | { type: 'tab:restore'; marker: string };

/**
 * Extension pages (popup, side panel) -> service worker. Accepted only from extension pages.
 * Every mutation is followed by a `ui:changed` broadcast so open pages refresh.
 */
export type UiMessage =
  | { type: 'ui:state'; tabId?: number }
  | { type: 'ui:create'; name: string; color?: SessionColor; assignTabId?: number }
  | { type: 'ui:update'; id: string; name?: string; color?: SessionColor }
  | { type: 'ui:archive'; id: string }
  | { type: 'ui:restore'; id: string }
  | { type: 'ui:delete'; id: string }
  | { type: 'ui:reset'; id: string }
  | { type: 'ui:assign'; tabId: number; sessionId: string | null }
  | { type: 'ui:openTab'; sessionId: string; url: string }
  | { type: 'ui:cookies'; id: string }
  | { type: 'ui:settings'; patch: Partial<Settings> }
  | { type: 'ui:permissionsChanged' }
  // Encrypted vault (Phase 4a, ADR 0004). Passphrases are never stored, logged or echoed back.
  | { type: 'ui:vaultSetup'; passphrase: string }
  | { type: 'ui:unlock'; passphrase: string }
  | { type: 'ui:lock' }
  | { type: 'ui:changePassphrase'; current: string; next: string }
  | { type: 'ui:vaultReset' }
  // Encrypted backup file (Phase 4b). `apply: false` only previews what an import would do.
  | { type: 'ui:export'; passphrase: string }
  | { type: 'ui:import'; data: string; passphrase: string; apply: boolean }
  // Tab restore after a browser restart (Phase 4c).
  | { type: 'ui:dismissRestore' }
  // Local backend (Phase 4d). The secret goes in, but is never sent back to the UI.
  | { type: 'ui:backend'; patch: { enabled?: boolean; url?: string; secret?: string } }
  | { type: 'ui:backendSync'; replace?: boolean }
  | { type: 'ui:backendRestore'; passphrase: string };

/** FR-21 connection status. `unknown` = enabled but not checked yet. */
export interface BackendSummary {
  enabled: boolean;
  url: string;
  hasSecret: boolean;
  state: 'disabled' | 'unknown' | 'connected' | 'offline';
  error: string | null;
  lastSyncAt: number | null;
  checkedAt: number | null;
  /** Changes waiting to be sent (reduced mode while offline). */
  pending: number;
  /** The backend holds another device's (or passphrase's) logins: restore or explicitly replace. */
  remoteDiffers: boolean;
}

export interface RestoreStatus {
  /** True while restored tabs can still rejoin their sessions. */
  active: boolean;
  /** Tabs from the last browser run that could not be restored (until dismissed). */
  unrestored: number;
}

export interface ExportResult {
  fileName: string;
  /** The encrypted backup file content (JSON). */
  data: string;
}

export interface ImportPreview {
  sessions: { id: string; name: string; cookies: number; exists: boolean }[];
  imported?: number;
}

export interface UiSession extends SessionMeta {
  tabCount: number;
  cookieCount: number;
}

/** `none`: no passphrase yet (logins kept in memory only); `locked`: saved logins need the passphrase. */
export interface VaultSummary {
  state: 'none' | 'locked' | 'unlocked';
  savedSessions: number;
  lastSavedAt: number | null;
}

export interface UiState {
  sessions: UiSession[];
  settings: Settings;
  /** Session of the tab passed in `ui:state`, if any. */
  tabSessionId: string | null;
  vault: VaultSummary;
  restore: RestoreStatus;
  backend: BackendSummary;
  diag: unknown;
}

export type UiResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export type UiCookies = CookieSummary[];

/** Service worker -> content scripts. */
export type BroadcastMessage = { type: 'session:changed' };

/** Service worker -> extension pages: state changed, re-fetch `ui:state`. */
export const UI_CHANGED = 'ui:changed';

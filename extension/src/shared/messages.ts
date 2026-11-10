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
    };

/** MAIN world -> relay. */
export type MainToRelay =
  | { type: 'set'; value: string }
  | { type: 'import'; values: string[] };

/** Content scripts -> service worker. */
export type ContentMessage =
  | { type: 'snapshot:get' }
  | { type: 'cookie:set'; value: string }
  | { type: 'cookie:import'; values: string[] };

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
  | { type: 'ui:permissionsChanged' };

export interface UiSession extends SessionMeta {
  tabCount: number;
  cookieCount: number;
}

export interface UiState {
  sessions: UiSession[];
  settings: Settings;
  /** Session of the tab passed in `ui:state`, if any. */
  tabSessionId: string | null;
  diag: unknown;
}

export type UiResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export type UiCookies = CookieSummary[];

/** Service worker -> content scripts. */
export type BroadcastMessage = { type: 'session:changed' };

/** Service worker -> extension pages: state changed, re-fetch `ui:state`. */
export const UI_CHANGED = 'ui:changed';

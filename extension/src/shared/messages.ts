import type { StoredCookie } from './cookieJar.js';

/** Channel names between the MAIN-world hook and the ISOLATED-world relay (JSON string payloads). */
export const TO_MAIN = 'sessionwoy:to-main';
export const TO_RELAY = 'sessionwoy:to-relay';
/** sessionStorage key caching the last managed snapshot, so reloads have a synchronous answer. */
export const SNAPSHOT_CACHE_KEY = '__sessionwoy_snapshot';

export type Snapshot =
  | { managed: false }
  | { managed: true; sessionId: string; cookies: StoredCookie[] };

/** MAIN world -> relay. */
export type MainToRelay =
  | { type: 'set'; value: string }
  | { type: 'import'; values: string[] };

/** Content scripts -> service worker. */
export type ContentMessage =
  | { type: 'snapshot:get' }
  | { type: 'cookie:set'; value: string }
  | { type: 'cookie:import'; values: string[] };

/** Popup -> service worker. */
export type PopupMessage =
  | { type: 'popup:state'; tabId: number }
  | { type: 'popup:assign'; tabId: number; sessionId: string | null }
  | { type: 'popup:open'; sessionId: string; url: string }
  | { type: 'popup:reset'; sessionId: string }
  | { type: 'popup:permissionsChanged' };

/** Service worker -> content scripts. */
export type BroadcastMessage = { type: 'session:changed' };

/**
 * MAIN-world hook (document_start, all frames). Virtualizes `document.cookie`
 * for tabs that belong to a SessionWoy session (FR-12):
 *
 *  - managed:   reads come from the session snapshot; writes update the local
 *               snapshot synchronously and are forwarded to the service worker.
 *               Nothing reaches the shared Chrome cookie jar.
 *  - unmanaged: native behavior, untouched (G6 / FR-14).
 *  - unknown:   (first document of an origin in a tab, before the async answer)
 *               native behavior; writes are remembered and imported into the
 *               session if the tab turns out to be managed. Documented leak window.
 */
import { CookieJar } from '../shared/cookieJar.js';
import { SNAPSHOT_CACHE_KEY, TO_MAIN, TO_RELAY, type MainToRelay, type Snapshot } from '../shared/messages.js';

(() => {
  const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (!desc?.get || !desc.set || !/^https?:$/.test(location.protocol)) return;
  const nativeGet = desc.get;
  const nativeSet = desc.set;

  type State = { managed: false } | { managed: true; sessionId: string; jar: CookieJar };
  let state: State | null = null;
  const pendingUnknownWrites: string[] = [];

  const toRelay = (msg: MainToRelay): void => {
    document.dispatchEvent(new CustomEvent(TO_RELAY, { detail: JSON.stringify(msg) }));
  };

  const adopt = (snap: Snapshot, cache: boolean): void => {
    if (snap.managed) {
      state = { managed: true, sessionId: snap.sessionId, jar: new CookieJar(snap.cookies) };
      if (pendingUnknownWrites.length) {
        const values = pendingUnknownWrites.splice(0);
        const now = Date.now();
        for (const v of values) state.jar.setFromHeader(v, new URL(location.href), now, { fromScript: true });
        toRelay({ type: 'import', values });
      }
    } else {
      state = { managed: false };
      pendingUnknownWrites.length = 0;
    }
    if (!cache) return;
    try {
      if (snap.managed) sessionStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify(snap));
      else sessionStorage.removeItem(SNAPSHOT_CACHE_KEY);
    } catch {
      /* sandboxed / storage disabled */
    }
  };

  // Synchronous answer for reloads and same-origin navigations in this tab.
  try {
    const cached = sessionStorage.getItem(SNAPSHOT_CACHE_KEY);
    if (cached) adopt(JSON.parse(cached) as Snapshot, false);
  } catch {
    /* ignore */
  }

  Object.defineProperty(Document.prototype, 'cookie', {
    configurable: true,
    enumerable: desc.enumerable ?? true,
    get(this: Document): string {
      if (state?.managed) return state.jar.documentCookieFor(new URL(location.href), Date.now());
      return nativeGet.call(this) as string;
    },
    set(this: Document, v: unknown): void {
      const value = String(v);
      if (state?.managed) {
        state.jar.setFromHeader(value, new URL(location.href), Date.now(), { fromScript: true });
        toRelay({ type: 'set', value });
        return;
      }
      if (state === null && pendingUnknownWrites.length < 50) pendingUnknownWrites.push(value);
      nativeSet.call(this, value);
    },
  });

  document.addEventListener(TO_MAIN, (e) => {
    const detail = (e as CustomEvent<unknown>).detail;
    if (typeof detail !== 'string') return;
    try {
      adopt(JSON.parse(detail) as Snapshot, true);
    } catch {
      /* ignore malformed */
    }
  });
})();

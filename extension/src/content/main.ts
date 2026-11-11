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
 *
 * It also keeps site Service Workers out of session frames (F9, ADR 0005): requests a Service
 * Worker makes have no tab id, so they would use (and write to) Chrome's shared cookie jar.
 */
import { CookieJar } from '../shared/cookieJar.js';
import { SNAPSHOT_CACHE_KEY, SW_RELOAD_KEY, TO_MAIN, TO_RELAY, type MainToRelay, type Snapshot } from '../shared/messages.js';

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

  // ---- Service Worker guard (F9)
  let onDecided: (() => void) | null = null;
  /** Resolves once managed/unmanaged is known (or after 3 s, so unmanaged pages never hang). */
  const decided = new Promise<void>((resolve) => {
    onDecided = resolve;
    setTimeout(resolve, 3_000);
  });
  let swEvicted = false;

  /**
   * A session frame must not be controlled by a site Service Worker. Unregisters every
   * registration of this origin (this also affects normal tabs of the site until it registers
   * again) and, if this document itself came through the worker, loads it again directly.
   */
  const evictServiceWorkers = async (): Promise<void> => {
    if (swEvicted) return;
    swEvicted = true;
    const container = typeof navigator.serviceWorker === 'object' ? navigator.serviceWorker : undefined;
    if (!container) return; // insecure context: no Service Workers
    const regs = await container.getRegistrations().catch(() => []);
    if (!regs.length && !container.controller) return;
    await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
    toRelay({ type: 'sw', action: 'unregistered' });
    if (!container.controller) return;
    try {
      // Loop guard: at most one reload per 10 s in this frame.
      if (Date.now() - Number(sessionStorage.getItem(SW_RELOAD_KEY) ?? 0) < 10_000) return;
      sessionStorage.setItem(SW_RELOAD_KEY, String(Date.now()));
    } catch {
      return; // storage disabled: no loop guard, so no reload
    }
    location.reload();
  };

  const adopt = (snap: Snapshot, cache: boolean): void => {
    onDecided?.();
    if (snap.managed) void evictServiceWorkers();
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

  // Session frames may not register a Service Worker. While the answer is unknown, wait for it.
  const SWC = typeof ServiceWorkerContainer === 'function' ? ServiceWorkerContainer : undefined;
  if (SWC) {
    const nativeRegister = SWC.prototype.register;
    SWC.prototype.register = function register(
      this: ServiceWorkerContainer,
      ...args: Parameters<ServiceWorkerContainer['register']>
    ): Promise<ServiceWorkerRegistration> {
      return decided.then(() => {
        if (state?.managed) {
          toRelay({ type: 'sw', action: 'blocked' });
          throw new DOMException('Service Workers are disabled in SessionWoy session tabs', 'SecurityError');
        }
        return nativeRegister.apply(this, args);
      });
    };
  }

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

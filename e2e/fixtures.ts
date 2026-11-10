import { test as base, chromium, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The e2e build (`npm run build:e2e -w extension`): same code as release plus the debug API. */
export const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension/dist-e2e');

export interface WhoAmI {
  identity: string;
  cookies: Record<string, string>;
  trail?: string[];
}

declare global {
  // Exists only inside the extension service worker (see extension/src/background/index.ts).
  var sessionwoy: SessionWoyDebug;
}

/** Result of a `ui:*` message (same shape the popup and side panel receive). */
export type UiResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Shape of the debug surface exposed by the service worker as `globalThis.sessionwoy`
 * (e2e build only). Unknown session ids passed to `assign*` / `openTabInSession` are created
 * on the fly with id = name.
 */
export interface SessionWoyDebug {
  rules(): Promise<unknown[]>;
  reset(sessionId: string): Promise<void>;
  ready(): Promise<boolean>;
  assignByUrl(urlPart: string, sessionId: string | null): Promise<number>;
  assign(tabId: number, sessionId: string | null): Promise<void>;
  tabIdByUrl(urlPart: string): Promise<number | null>;
  openTabInSession(sessionId: string, url: string): Promise<{ tabId: number }>;
  /** Calls the same `ui:*` handler as the popup / side panel. */
  ui(msg: { type: string } & Record<string, unknown>): Promise<UiResult>;
  state(): Promise<{
    tabs: Record<string, string>;
    jars: Record<string, { name: string; value: string }[]>;
    groups: Record<string, number>;
  }>;
  diag(): Promise<Record<string, unknown> & { rules: { avgMs: number; maxMs: number; updates: number } }>;
  setInheritOnOpen(v: boolean): Promise<void>;
}

/** The extension handle of the running test (workers: 1), used by gotoJson to wait for heals. */
let activeExt: Ext | undefined;

type Fixtures ={ context: BrowserContext; sw: Worker; extensionId: string; ext: Ext };

export class Ext {
  constructor(
    private readonly context: BrowserContext,
    private swRef: { current: Worker },
  ) {}

  get sw(): Worker {
    return this.swRef.current;
  }

  /** The service worker, re-acquired if it was stopped and restarted. */
  async worker(): Promise<Worker> {
    if (!this.context.serviceWorkers().includes(this.swRef.current)) {
      this.swRef.current = this.context.serviceWorkers()[0] ?? (await this.context.waitForEvent('serviceworker'));
    }
    return this.swRef.current;
  }

  /** Runs `fn` inside the service worker, where the global `sessionwoy` debug API exists. */
  async call<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> {
    const w = await this.worker();
    await w.evaluate(() => sessionwoy.ready());
    return w.evaluate(fn as (arg: unknown) => Promise<R>, arg as unknown);
  }

  /** Opens a tab on a unique probe URL (unmanaged), optionally assigning it to a session. */
  async openTab(sessionId: string | null): Promise<{ page: Page; tabId: number }> {
    const page = await this.context.newPage();
    const probe = `probe=${randomUUID()}`;
    await page.goto(`/whoami?${probe}`);
    const tabId = sessionId
      ? await this.call((a) => sessionwoy.assignByUrl(a.probe, a.sessionId), { probe, sessionId })
      : await this.call((p) => sessionwoy.tabIdByUrl(p), probe);
    if (tabId === null) throw new Error('tab not found');
    return { page, tabId };
  }

  state() {
    return this.call(() => sessionwoy.state(), null);
  }

  diag() {
    return this.call(() => sessionwoy.diag(), null);
  }

  /** Sends a `ui:*` message (as the popup / side panel would) and returns the raw result. */
  uiRaw(msg: { type: string } & Record<string, unknown>): Promise<UiResult> {
    return this.call((m) => sessionwoy.ui(m), msg);
  }

  /** Sends a `ui:*` message and returns its data, throwing on `{ ok: false }`. */
  async ui<T = unknown>(msg: { type: string } & Record<string, unknown>): Promise<T> {
    const r = await this.uiRaw(msg);
    if (!r.ok) throw new Error(r.error);
    return r.data as T;
  }

  /** Tab-group info of a tab, read inside the service worker. */
  tabGroup(tabId: number): Promise<{ groupId: number; title?: string; color?: string }> {
    return this.call(async (id) => {
      const tab = await chrome.tabs.get(id);
      if (tab.groupId === undefined || tab.groupId < 0) return { groupId: -1 };
      const g = await chrome.tabGroups.get(tab.groupId);
      return { groupId: tab.groupId, title: g.title, color: g.color };
    }, tabId);
  }
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', // bundled Chromium: branded Chrome ignores --load-extension
      headless: !process.env.HEADED,
      baseURL: process.env.BASE_URL ?? 'http://localhost:3003',
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(sw);
  },
  extensionId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
  ext: async ({ context, sw }, use) => {
    const ext = new Ext(context, { current: sw });
    await ext.call(() => sessionwoy.ready(), null);
    activeExt = ext;
    await use(ext);
    activeExt = undefined;
  },
});

export { expect };

/**
 * Navigates and parses the JSON body of the page that finally settles.
 * The extension may re-issue a navigation that went out with stale cookies
 * ("heal"), which aborts or replaces the original one, so the helper waits for
 * the tab to settle instead of trusting the first response.
 */
export async function gotoJson<T = WhoAmI>(page: Page, url: string, settleMs = 50): Promise<T> {
  try {
    await page.goto(url);
  } catch (e) {
    if (!/ERR_ABORTED|interrupted|detached/i.test(String(e))) throw e;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      // Queue drained => any heal() for this navigation has already called tabs.update.
      if (activeExt) await activeExt.call(() => sessionwoy.ready(), null);
      await page.waitForTimeout(settleMs);
      await page.waitForLoadState('load');
      return JSON.parse(await page.locator('body').innerText()) as T;
    } catch (e) {
      if (attempt >= 5) throw e;
    }
  }
}

/** fetch() from inside the page (subresource request carrying the tab id). */
export async function fetchJson<T = WhoAmI>(page: Page, url: string): Promise<T> {
  return page.evaluate(async (u) => (await fetch(u, { cache: 'no-store' })).json(), url) as Promise<T>;
}

export async function sharedJarNames(context: BrowserContext): Promise<string[]> {
  return (await context.cookies('http://localhost:3003')).map((c) => c.name).sort();
}

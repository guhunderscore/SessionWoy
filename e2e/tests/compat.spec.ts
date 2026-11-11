/**
 * Phase 5 compatibility scenarios (ADR 0005) against the test server's compatibility pages
 * (test-server/src/compat.ts). localhost:3003 and 127.0.0.1:3003 are two different sites.
 */
import { readFile } from 'node:fs/promises';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, fetchJson, gotoJson, sharedJarNames, test } from '../fixtures.js';

const PROVIDER = 'http://127.0.0.1:3003';

const sharedProviderJar = async (context: BrowserContext) =>
  (await context.cookies(PROVIDER)).map((c) => c.name).sort();

const swReady = (page: Page) =>
  page.evaluate(() => (window as unknown as { swReady: Promise<string> }).swReady);

test('S28 login inside a cross-site iframe stays in the session; the stale hop is healed', async ({
  ext,
  context,
}) => {
  const a = await ext.openTab('A');
  const b = await ext.openTab('B');
  for (const t of [a, b]) {
    await t.page.goto('/frame');
    await expect(t.page.frameLocator('#f').locator('#who')).toHaveText('anonymous');
  }
  const before = await ext.diag();
  // The provider's 302 sets a SameSite=None cookie, and Chrome follows it before the rules update.
  await a.page.evaluate(
    (u) => ((document.getElementById('f') as HTMLIFrameElement).src = u),
    `${PROVIDER}/frame/login?user=frameA`,
  );
  // No manual reload: the stale hop is re-issued inside the frame (F10).
  await expect(a.page.frameLocator('#f').locator('#who')).toHaveText('frameA');
  const after = await ext.diag();
  expect(Number(after.healedFrames)).toBeGreaterThan(Number(before.healedFrames));

  await b.page.reload();
  await expect(b.page.frameLocator('#f').locator('#who')).toHaveText('anonymous');
  expect((await ext.state()).jars.A?.map((c) => c.name)).toContain('sid');
  expect(await sharedProviderJar(context)).toEqual([]);
});

test('S29 OAuth-style popup login: the popup inherits its opener session', async ({
  ext,
  context,
}) => {
  const a = await ext.openTab('A');
  const b = await ext.openTab('B');
  for (const [t, user] of [
    [a, 'oauthA'],
    [b, 'oauthB'],
  ] as const) {
    await t.page.goto('/oauth/start');
    const popup = t.page.waitForEvent('popup');
    await t.page.evaluate(
      (u) => (window as unknown as { startLogin: (u: string) => void }).startLogin(u),
      user,
    );
    await (await popup).waitForEvent('close');
    await expect(t.page.locator('#result')).toHaveText(`logged in as ${user}`);
  }
  expect((await fetchJson(a.page, '/whoami')).identity).toBe('oauthA');
  expect((await fetchJson(b.page, '/whoami')).identity).toBe('oauthB');
  const st = await ext.state();
  expect(st.jars.A?.map((c) => c.name).sort()).toEqual(['psid', 'sid']);
  expect(st.jars.B?.map((c) => c.name).sort()).toEqual(['psid', 'sid']);
  expect(await sharedJarNames(context)).toEqual([]);
  expect(await sharedProviderJar(context)).toEqual([]);
});

test('S30 a session tab cannot register a site Service Worker', async ({ ext, context }) => {
  const a = await ext.openTab('A');
  await gotoJson(a.page, '/login?user=customer');
  await a.page.goto('/sw/');
  expect(await swReady(a.page)).toMatch(/^blocked: .*SessionWoy/);
  await a.page.reload();
  expect(await a.page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
  expect((await fetchJson(a.page, '/sw/whoami')).identity).toBe('customer');
  expect(Number((await ext.diag()).swBlocked)).toBeGreaterThan(0);
  expect(await sharedJarNames(context)).toEqual([]);

  // A normal tab is not affected.
  const u = await ext.openTab(null);
  await u.page.goto('/sw/');
  expect(await swReady(u.page)).toBe('registered');
});

test('S31 a Service Worker registered by a normal tab is removed from a session tab; no leak', async ({
  ext,
  context,
}) => {
  const u = await ext.openTab(null);
  await u.page.goto('/sw/');
  expect(await swReady(u.page)).toBe('registered');
  await u.page.reload();
  expect(await u.page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  const a = await ext.openTab('A');
  await gotoJson(a.page, '/login?user=customer');
  await a.page.goto('/sw/');
  // The guard unregisters the worker and reloads the page once, without the worker.
  await expect.poll(() => a.page.evaluate(() => !!navigator.serviceWorker?.controller)).toBe(false);
  expect(Number((await ext.diag()).swUnregistered)).toBeGreaterThan(0);

  // A login in the session tab stays in the session (before F9 it went to Chrome's shared jar).
  await a.page.evaluate(() => fetch('/login?user=swuser', { redirect: 'manual' }));
  expect((await fetchJson(a.page, '/whoami')).identity).toBe('swuser');
  expect(await sharedJarNames(context)).toEqual([]);
  const u2 = await ext.openTab(null);
  expect((await fetchJson(u2.page, '/whoami')).identity).toBe('anonymous');
});

test('S32 a download carries the session identity', async ({ ext, context }) => {
  const a = await ext.openTab('A');
  const b = await ext.openTab('B');
  await gotoJson(a.page, '/login?user=customer');
  await gotoJson(b.page, '/login?user=provider');
  for (const [t, expected] of [
    [a, 'customer'],
    [b, 'provider'],
  ] as const) {
    await t.page.goto('/');
    const download = t.page.waitForEvent('download');
    await t.page.evaluate(() => {
      const link = document.createElement('a');
      link.href = '/download';
      link.click();
    });
    expect(await readFile(await (await download).path(), 'utf8')).toBe(expected);
  }
  expect(await sharedJarNames(context)).toEqual([]);
});

test('S33 web storage matrix: sessionStorage is per tab, localStorage and IndexedDB stay shared', async ({
  ext,
}) => {
  const a = await ext.openTab('A');
  const b = await ext.openTab('B');
  await a.page.goto('/');
  await b.page.goto('/');
  await a.page.evaluate(async () => {
    sessionStorage.setItem('probe', 'A');
    localStorage.setItem('probe', 'A');
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('swprobe', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('kv', 'readwrite');
        tx.objectStore('kv').put('A', 'probe');
        tx.oncomplete = () => resolve();
      };
    });
  });
  const seenByB = await b.page.evaluate(
    async () =>
      ({
        sessionStorage: sessionStorage.getItem('probe'),
        localStorage: localStorage.getItem('probe'),
        indexedDB: await new Promise<unknown>((resolve) => {
          const open = indexedDB.open('swprobe', 1);
          open.onupgradeneeded = () => open.result.createObjectStore('kv');
          open.onsuccess = () => {
            const req = open.result.transaction('kv').objectStore('kv').get('probe');
            req.onsuccess = () => resolve(req.result ?? null);
          };
        }),
      }) as Record<string, unknown>,
  );
  // Known limitation 4 (ADR 0002): only cookies are isolated. This pins the current behavior.
  expect(seenByB).toEqual({ sessionStorage: null, localStorage: 'A', indexedDB: 'A' });
});

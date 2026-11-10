/**
 * Phase 2 go/no-go scenarios (PRD §12) against the Docker test server.
 * Each test gets a fresh browser profile with the unpacked extension.
 */
import { expect, fetchJson, gotoJson, sharedJarNames, test, type WhoAmI } from '../fixtures.js';

const STRESS_N = Number.parseInt(process.env.STRESS_N ?? '1000', 10);

test('S1 two tabs, same origin, different sessions get their own identity', async ({ ext, context }) => {
  const a = await ext.openTab('A');
  const b = await ext.openTab('B');
  expect((await gotoJson(a.page, '/login?user=customer')).identity).toBe('customer');
  expect((await gotoJson(b.page, '/login?user=provider')).identity).toBe('provider');
  expect((await fetchJson(a.page, '/whoami')).identity).toBe('customer');
  expect((await fetchJson(b.page, '/whoami')).identity).toBe('provider');
  // FR-11: nothing reached the shared Chrome jar
  expect(await sharedJarNames(context)).toEqual([]);
});

test('S2 parallel requests from both sessions never cross-contaminate', async ({ ext }) => {
  test.setTimeout(600_000);
  const a = await ext.openTab('A');
  const b = await ext.openTab('B');
  await gotoJson(a.page, '/login?user=customer');
  await gotoJson(b.page, '/login?user=provider');

  // Interleave identity checks with response-cookie churn in both sessions.
  const burst = (page: typeof a.page, expected: string, tag: string) =>
    page.evaluate(
      async ({ n, expected, tag }) => {
        // Pool of 64 in-flight requests per tab: Chromium rejects ~10k simultaneous
        // fetches with ERR_INSUFFICIENT_RESOURCES, which is not what we are testing.
        let next = 0;
        let leaks = 0;
        const worker = async () => {
          for (let i = next++; i < n; i = next++) {
            if (i % 50 === 0) await fetch(`/set-cookie?name=churn&value=${tag}-${i}`);
            const r = (await (await fetch(`/parallel?id=${i}`, { cache: 'no-store' })).json()) as { identity: string };
            if (r.identity !== expected) leaks++;
          }
        };
        await Promise.all(Array.from({ length: 64 }, worker));
        return leaks;
      },
      { n: STRESS_N, expected, tag },
    );
  const [leakA, leakB] = await Promise.all([burst(a.page, 'customer', 'A'), burst(b.page, 'provider', 'B')]);
  expect({ leakA, leakB, perTab: STRESS_N }).toEqual({ leakA: 0, leakB: 0, perTab: STRESS_N });

  const ca = await fetchJson(a.page, '/whoami');
  const cb = await fetchJson(b.page, '/whoami');
  expect(ca.cookies.churn).toMatch(/^A-/);
  expect(cb.cookies.churn).toMatch(/^B-/);
});

test('S3 response cookie is stored in the correct session only; shared jar unchanged', async ({ ext, context }) => {
  const a = await ext.openTab('A');
  const b = await ext.openTab('B');
  await fetchJson(a.page, '/set-cookie?name=pref&value=dark');
  await expect.poll(async () => (await fetchJson(a.page, '/whoami')).cookies.pref).toBe('dark');
  expect((await fetchJson(b.page, '/whoami')).cookies.pref).toBeUndefined();
  expect(await sharedJarNames(context)).toEqual([]);
  const st = await ext.state();
  expect(st.jars.A?.map((c) => c.name)).toContain('pref');
  expect(st.jars.B ?? []).toEqual([]);
});

test('S4 document.cookie writes are captured into the session and hidden from others', async ({ ext, context }) => {
  const a = await ext.openTab('A');
  const b = await ext.openTab('B');
  await gotoJson(a.page, '/login?user=customer');
  await a.page.goto('/');
  await a.page.waitForFunction(() => sessionStorage.getItem('__sessionwoy_snapshot') !== null);
  await a.page.evaluate(() => {
    document.cookie = 'jsval=fromjs; path=/';
  });
  // Page-world read reflects the write synchronously; HttpOnly sid stays hidden.
  expect(await a.page.evaluate(() => document.cookie)).toBe('jsval=fromjs');
  await expect.poll(async () => (await fetchJson(a.page, '/whoami')).cookies.jsval).toBe('fromjs');
  expect((await fetchJson(a.page, '/whoami')).identity).toBe('customer');
  expect((await fetchJson(b.page, '/whoami')).cookies.jsval).toBeUndefined();
  expect(await sharedJarNames(context)).toEqual([]);
});

test('S5 reload and redirect chain keep the identity at every hop', async ({ ext }) => {
  const a = await ext.openTab('A');
  const b = await ext.openTab('B');
  await gotoJson(a.page, '/login?user=customer');
  await gotoJson(b.page, '/login?user=provider');
  const ra = await a.page.reload();
  expect(((await ra!.json()) as WhoAmI).identity).toBe('customer');
  expect((await gotoJson(a.page, '/redirect?hops=4')).trail).toEqual(Array(5).fill('customer'));
  expect((await gotoJson(b.page, '/redirect?hops=4')).trail).toEqual(Array(5).fill('provider'));
});

test('S6 link opened in a new tab inherits the session', async ({ ext, context }) => {
  const a = await ext.openTab('A');
  await gotoJson(a.page, '/login?user=customer');
  await a.page.goto('/');
  const [child] = await Promise.all([context.waitForEvent('page'), a.page.click('#new-tab-link')]);
  await child.waitForLoadState();
  const body = JSON.parse(await child.locator('body').innerText()) as WhoAmI;
  const st = await ext.state();
  expect(Object.values(st.tabs).filter((s) => s === 'A').length).toBe(2);
  // The first navigation of the new tab races the rule update; record and assert.
  expect(body.identity).toBe('customer');
  expect((await fetchJson(child, '/whoami')).identity).toBe('customer');
});

test('S7 duplicated tab inherits the session', async ({ ext, context }) => {
  const a = await ext.openTab('A');
  await gotoJson(a.page, '/login?user=customer');
  const [dup] = await Promise.all([
    context.waitForEvent('page'),
    ext.call((id) => chrome.tabs.duplicate(id), a.tabId),
  ]);
  await dup.waitForLoadState();
  await expect.poll(async () => Object.values((await ext.state()).tabs).filter((s) => s === 'A').length).toBe(2);
  // The duplicate is reloaded after it is assigned (F6), so navigate fresh instead of fetch() in it.
  expect((await gotoJson(dup, '/whoami')).identity).toBe('customer');
});

test('S8 unmanaged tab behaves like normal Chrome and does not affect managed tabs', async ({ ext, context }) => {
  const a = await ext.openTab('A');
  const c = await ext.openTab(null);
  await gotoJson(a.page, '/login?user=customer');
  expect((await gotoJson(c.page, '/login?user=admin')).identity).toBe('admin');
  expect(await sharedJarNames(context)).toEqual(['sid']);
  expect((await fetchJson(a.page, '/whoami')).identity).toBe('customer');
  await c.page.evaluate(() => {
    document.cookie = 'plain=1; path=/';
  });
  expect(await c.page.evaluate(() => document.cookie)).toBe('plain=1');
  expect(await sharedJarNames(context)).toEqual(['plain', 'sid']);
  expect((await fetchJson(a.page, '/whoami')).cookies.plain).toBeUndefined();
});

test('S9 cookie deletion (Max-Age=0) and expiry are honored per session', async ({ ext }) => {
  const a = await ext.openTab('A');
  const b = await ext.openTab('B');
  await fetchJson(a.page, '/set-cookie?name=tmp&value=1');
  await fetchJson(b.page, '/set-cookie?name=tmp&value=2');
  await expect.poll(async () => (await fetchJson(a.page, '/whoami')).cookies.tmp).toBe('1');
  await fetchJson(a.page, '/set-cookie?name=tmp&value=x&maxAge=0');
  await expect.poll(async () => (await fetchJson(a.page, '/whoami')).cookies.tmp).toBeUndefined();
  expect((await fetchJson(b.page, '/whoami')).cookies.tmp).toBe('2');

  await fetchJson(b.page, '/set-cookie?name=short&value=1&maxAge=2');
  await expect.poll(async () => (await fetchJson(b.page, '/whoami')).cookies.short).toBe('1');
  await expect.poll(async () => (await fetchJson(b.page, '/whoami')).cookies.short, { timeout: 10_000 }).toBeUndefined();
});

test('S10 service worker restart recovers mappings and keeps capturing', async ({ ext, context, extensionId }) => {
  const a = await ext.openTab('A');
  const b = await ext.openTab('B');
  await gotoJson(a.page, '/login?user=customer');
  await gotoJson(b.page, '/login?user=provider');

  const startedBefore = (await ext.diag()).workerStartedAt;
  // Stop the extension service worker via the ServiceWorker CDP domain of an extension page.
  // (Target.closeTarget reports success but does not stop it; Playwright emits no 'close'.)
  const extPage = await context.newPage();
  await extPage.goto(`chrome-extension://${extensionId}/popup.html`);
  const cdp = await context.newCDPSession(extPage);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await extPage.close();

  // DNR session rules survive the worker; identities still hold while it is down.
  expect((await fetchJson(a.page, '/whoami')).identity).toBe('customer');
  // A Set-Cookie wakes the worker, which must rehydrate and capture into the right session.
  expect((await gotoJson(a.page, '/login?user=customer2')).identity).toMatch(/^customer2?$/);
  await expect.poll(async () => (await fetchJson(a.page, '/whoami')).identity).toBe('customer2');
  expect((await fetchJson(b.page, '/whoami')).identity).toBe('provider');
  const d = await ext.diag();
  expect(d.workerStartedAt, 'worker actually restarted').not.toBe(startedBefore);
  expect(d.restoredTabs).toBe(2);
  const st = await ext.state();
  expect(st.tabs[String(a.tabId)]).toBe('A');
  expect(st.tabs[String(b.tabId)]).toBe('B');
  expect(await context.cookies('http://localhost:3003')).toEqual([]);
});

test('S11 first navigation after assignment / open-in-session carries the session', async ({ ext, context }) => {
  const a = await ext.openTab('A');
  await gotoJson(a.page, '/login?user=customer');
  // Assign a fresh tab and navigate immediately.
  const b = await ext.openTab('A');
  expect((await gotoJson(b.page, '/whoami')).identity).toBe('customer');
  // FR-5 open a new tab directly in a session.
  const [page] = await Promise.all([
    context.waitForEvent('page'),
    ext.call((u) => sessionwoy.openTabInSession('A', u), 'http://localhost:3003/whoami?opened=1'),
  ]);
  await page.waitForURL(/opened=1/);
  expect((JSON.parse(await page.locator('body').innerText()) as WhoAmI).identity).toBe('customer');
});

test('S12 login redirect (Set-Cookie on 302, immediate follow-up) — rule-update race', async ({ ext }) => {
  const results: string[] = [];
  for (let i = 0; i < 20; i++) {
    const a = await ext.openTab(i % 2 ? 'A' : 'B');
    const user = `u${i}`;
    results.push((await gotoJson(a.page, `/login?user=${user}`)).identity === user ? 'ok' : 'stale');
    await a.page.close();
  }
  const d = await ext.diag();
  const summary = { results, staleRequests: d.staleRequests, healed: d.healed, healSkipped: d.healSkipped, discarded: d.setCookieDiscardedStale, rules: d.rules };
  test.info().annotations.push({ type: 'redirect-race', description: JSON.stringify(summary) });
  console.info('[redirect-race]', JSON.stringify(summary));
  expect(results.filter((r) => r !== 'ok')).toEqual([]);
});

test('S14 added latency per request (managed vs unmanaged tab), p95 delta < 5 ms', async ({ ext }) => {
  const a = await ext.openTab('A');
  const u = await ext.openTab(null);
  await gotoJson(a.page, '/login?user=customer');
  for (let i = 0; i < 30; i++) await fetchJson(a.page, `/set-cookie?name=c${i}&value=${'x'.repeat(40)}`); // realistic header size
  const measure = (page: typeof a.page) =>
    page.evaluate(async () => {
      const t: number[] = [];
      for (let i = 0; i < 400; i++) {
        const s = performance.now();
        await (await fetch(`/parallel?id=${i}`, { cache: 'no-store' })).text();
        t.push(performance.now() - s);
      }
      t.sort((x, y) => x - y);
      return { p50: t[Math.floor(t.length * 0.5)]!, p95: t[Math.floor(t.length * 0.95)]! };
    });
  const unmanaged = await measure(u.page);
  const managed = await measure(a.page);
  const summary = { unmanaged, managed, p95DeltaMs: managed.p95 - unmanaged.p95 };
  console.info('[latency]', JSON.stringify(summary));
  test.info().annotations.push({ type: 'latency', description: JSON.stringify(summary) });
  expect(summary.p95DeltaMs).toBeLessThan(5);
});

test('S15 link-opened tab keeps the source session even when another session has the same URL open', async ({ ext, context }) => {
  const a = await ext.openTab('A');
  const b = await ext.openTab('B');
  await gotoJson(a.page, '/login?user=customer');
  await gotoJson(b.page, '/login?user=provider');
  // Session B already shows exactly the URL the link in A will open.
  await b.page.goto('/whoami');
  await a.page.goto('/');
  await b.page.bringToFront(); // the active tab is not the link's source tab
  const [child] = await Promise.all([context.waitForEvent('page'), a.page.click('#new-tab-link')]);
  await child.waitForLoadState();
  await child.waitForTimeout(600); // longer than the duplicate heuristic's settle delay
  const st = await ext.state();
  const others = Object.entries(st.tabs).filter(([id]) => Number(id) !== a.tabId && Number(id) !== b.tabId);
  expect(others.map(([, s]) => s)).toEqual(['A']);
  expect((await fetchJson(child, '/whoami')).identity).toBe('customer');
  const d = (await ext.diag()) as unknown as { inheritLog: { via: string; applied: boolean; sessionId: string | null }[] };
  expect(d.inheritLog.some((e) => e.via === 'link' && e.applied && e.sessionId === 'A')).toBe(true);
  expect(d.inheritLog.some((e) => e.applied && e.sessionId === 'B')).toBe(false);
});

test('S13 diagnostics: webRequest sees Set-Cookie despite DNR removal; rule update latency', async ({ ext }) => {
  const a = await ext.openTab('A');
  await gotoJson(a.page, '/login?user=customer');
  for (let i = 0; i < 20; i++) await fetchJson(a.page, `/set-cookie?name=k${i}&value=${i}`);
  const d = (await ext.diag()) as Record<string, unknown> & { rules: { avgMs: number; maxMs: number; updates: number } };
  test.info().annotations.push({ type: 'diag', description: JSON.stringify(d) });
  console.info('[diag]', JSON.stringify(d));
  expect(d.setCookieHeadersSeen as number).toBeGreaterThanOrEqual(21);
  expect(d.setCookieStored as number).toBeGreaterThanOrEqual(21);
});

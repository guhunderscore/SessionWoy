/**
 * Phase 3 scenarios (ADR 0003): session management through the same `ui:*` messages the popup
 * and side panel use, tab groups, persistence of the session list, and a side-panel UI smoke test.
 */
import { expect, gotoJson, test } from '../fixtures.js';

interface Meta {
  id: string;
  name: string;
  color: string;
  status: 'active' | 'archived';
}
interface State {
  sessions: (Meta & { tabCount: number; cookieCount: number })[];
  settings: { inheritOnOpen: boolean; grouping: 'tab' | 'group' };
  tabSessionId: string | null;
}

test('S16 create, rename, recolor, archive, restore, reset and delete a session', async ({ ext }) => {
  const created = await ext.ui<Meta>({ type: 'ui:create', name: '  Customer  ', color: 'blue' });
  expect(created).toMatchObject({ name: 'Customer', color: 'blue', status: 'active' });
  expect((await ext.uiRaw({ type: 'ui:create', name: '   ' })).ok).toBe(false);
  expect((await ext.uiRaw({ type: 'ui:update', id: created.id, color: 'magenta' })).ok).toBe(false);

  const t = await ext.openTab(null);
  await ext.ui({ type: 'ui:assign', tabId: t.tabId, sessionId: created.id });
  expect((await gotoJson(t.page, '/login?user=customer')).identity).toBe('customer');

  // Cookie overview: names and flags only, never values.
  const cookies = await ext.ui<{ domain: string; cookies: { name: string; httpOnly: boolean }[] }[]>({ type: 'ui:cookies', id: created.id });
  expect(cookies).toEqual([{ domain: 'localhost', cookies: [expect.objectContaining({ name: 'sid', httpOnly: true })] }]);
  expect(JSON.stringify(cookies)).not.toContain('customer');

  await ext.ui({ type: 'ui:update', id: created.id, name: 'Customer QA', color: 'red' });
  let st = await ext.ui<State>({ type: 'ui:state', tabId: t.tabId });
  expect(st.sessions[0]).toMatchObject({ name: 'Customer QA', color: 'red', tabCount: 1, cookieCount: 1 });
  expect(st.tabSessionId).toBe(created.id);

  // Archive: the tab becomes a normal tab; cookies are kept; assigning is refused.
  await ext.ui({ type: 'ui:archive', id: created.id });
  st = await ext.ui<State>({ type: 'ui:state', tabId: t.tabId });
  expect(st.sessions[0]).toMatchObject({ status: 'archived', tabCount: 0, cookieCount: 1 });
  expect(st.tabSessionId).toBeNull();
  // Archive reloads the tab; navigate fresh rather than fetch() inside a page that is reloading.
  expect((await gotoJson(t.page, '/whoami')).identity).toBe('anonymous');
  expect((await ext.uiRaw({ type: 'ui:assign', tabId: t.tabId, sessionId: created.id })).ok).toBe(false);

  // Restore and reassign: the kept cookies log the tab straight back in.
  await ext.ui({ type: 'ui:restore', id: created.id });
  await ext.ui({ type: 'ui:assign', tabId: t.tabId, sessionId: created.id });
  expect((await gotoJson(t.page, '/whoami')).identity).toBe('customer');

  // Reset: cookies cleared, tab stays in the session.
  await ext.ui({ type: 'ui:reset', id: created.id });
  expect((await gotoJson(t.page, '/whoami')).identity).toBe('anonymous');
  expect((await ext.ui<State>({ type: 'ui:state', tabId: t.tabId })).tabSessionId).toBe(created.id);

  // Delete: metadata, cookies, tab mapping and DNR rules are all gone.
  await gotoJson(t.page, '/login?user=customer');
  await ext.ui({ type: 'ui:delete', id: created.id });
  st = await ext.ui<State>({ type: 'ui:state', tabId: t.tabId });
  expect(st.sessions).toEqual([]);
  expect(st.tabSessionId).toBeNull();
  const rules = (await ext.call(() => sessionwoy.rules(), null)) as { condition: { tabIds?: number[] } }[];
  expect(rules.filter((r) => r.condition.tabIds?.includes(t.tabId))).toEqual([]);
  expect((await ext.uiRaw({ type: 'ui:cookies', id: created.id })).ok).toBe(false);
});

test('S17 marker mode: per tab by default (no groups); per group follows name and color; switching keeps sessions', async ({ ext }) => {
  const s = await ext.ui<Meta>({ type: 'ui:create', name: 'Provider', color: 'orange' });
  const a = await ext.openTab(null);
  const b = await ext.openTab(null);
  await ext.ui({ type: 'ui:assign', tabId: a.tabId, sessionId: s.id });
  await ext.ui({ type: 'ui:assign', tabId: b.tabId, sessionId: s.id });

  // Default mode is per tab: sessions apply, but tabs stay ungrouped.
  expect((await ext.ui<State>({ type: 'ui:state' })).settings.grouping).toBe('tab');
  expect((await ext.tabGroup(a.tabId)).groupId).toBe(-1);
  expect((await ext.ui<State>({ type: 'ui:state', tabId: a.tabId })).tabSessionId).toBe(s.id);
  expect((await ext.uiRaw({ type: 'ui:settings', patch: { grouping: 'window' } })).ok).toBe(false);

  // Per group: existing session tabs are grouped at once.
  await ext.ui({ type: 'ui:settings', patch: { grouping: 'group' } });
  const ga = await ext.tabGroup(a.tabId);
  const gb = await ext.tabGroup(b.tabId);
  expect(ga).toMatchObject({ title: 'Provider', color: 'orange' });
  expect(gb.groupId).toBe(ga.groupId);

  await ext.ui({ type: 'ui:update', id: s.id, name: 'Provider QA', color: 'green' });
  expect(await ext.tabGroup(a.tabId)).toMatchObject({ groupId: ga.groupId, title: 'Provider QA', color: 'green' });

  await ext.ui({ type: 'ui:assign', tabId: a.tabId, sessionId: null });
  expect((await ext.tabGroup(a.tabId)).groupId).toBe(-1);

  // Back to per tab: groups go away, the session stays.
  await ext.ui({ type: 'ui:settings', patch: { grouping: 'tab' } });
  expect((await ext.tabGroup(b.tabId)).groupId).toBe(-1);
  expect((await ext.ui<State>({ type: 'ui:state', tabId: b.tabId })).tabSessionId).toBe(s.id);
  await ext.ui({ type: 'ui:settings', patch: { grouping: 'group' } });
  expect(await ext.tabGroup(b.tabId)).toMatchObject({ title: 'Provider QA', color: 'green' });
});

test('S18 session list and settings persist in storage.local (cookies never do) and survive a worker restart', async ({ ext, context, extensionId }) => {
  const s = await ext.ui<Meta>({ type: 'ui:create', name: 'Persist', color: 'cyan' });
  await ext.ui({ type: 'ui:settings', patch: { inheritOnOpen: false } });
  const t = await ext.openTab(null);
  await ext.ui({ type: 'ui:assign', tabId: t.tabId, sessionId: s.id });
  await gotoJson(t.page, '/login?user=persistuser');

  const local = await ext.call(() => chrome.storage.local.get(null), null);
  expect(JSON.stringify(local)).toContain('Persist');
  expect(JSON.stringify(local)).not.toContain('persistuser'); // no cookie values on disk

  const startedBefore = (await ext.diag()).workerStartedAt;
  const extPage = await context.newPage();
  await extPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const cdp = await context.newCDPSession(extPage);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await extPage.close();
  await expect.poll(async () => (await ext.diag()).workerStartedAt).not.toBe(startedBefore);

  const st = await ext.ui<State>({ type: 'ui:state', tabId: t.tabId });
  expect(st.sessions.map((x) => x.name)).toEqual(['Persist']);
  expect(st.settings.inheritOnOpen).toBe(false);
  expect(st.tabSessionId).toBe(s.id);
  expect((await gotoJson(t.page, '/whoami')).identity).toBe('persistuser');
});

test('S20 no host access: assigning is refused, and a session tab on such a site shows "!" (F8)', async ({ ext, context }) => {
  // localhost:3999 is not in the manifest and was never granted (it does not even need to answer).
  const NO_ACCESS = 'http://localhost:3999/f8';
  const s = await ext.ui<Meta>({ type: 'ui:create', name: 'Guarded', color: 'blue' });
  const page = await context.newPage();
  await page.goto(NO_ACCESS).catch(() => undefined); // connection refused is fine; the tab keeps the URL
  // The tab's URL is updated a moment after a failed load: wait for it.
  let tabId: number | null = null;
  await expect
    .poll(async () => (tabId = await ext.call((u) => sessionwoy.tabIdByUrl(u), 'localhost:3999')))
    .not.toBeNull();

  const refused = await ext.uiRaw({ type: 'ui:assign', tabId, sessionId: s.id });
  expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('no access to http://localhost:3999') });
  expect((await ext.ui<State>({ type: 'ui:state', tabId: tabId! })).tabSessionId).toBeNull();

  // "Create and use here" on such a site creates nothing.
  expect((await ext.uiRaw({ type: 'ui:create', name: 'Orphan', assignTabId: tabId })).ok).toBe(false);
  expect((await ext.ui<State>({ type: 'ui:state' })).sessions.map((x) => x.name)).toEqual(['Guarded']);
  expect((await ext.uiRaw({ type: 'ui:openTab', sessionId: s.id, url: NO_ACCESS })).ok).toBe(false);
  // Removing a tab from a session is always allowed.
  expect((await ext.uiRaw({ type: 'ui:assign', tabId, sessionId: null })).ok).toBe(true);

  // A session tab that navigates to a site without access warns with "!" instead of its name.
  const t = await ext.openTab(null);
  await ext.ui({ type: 'ui:assign', tabId: t.tabId, sessionId: s.id });
  const badge = () => ext.call((id) => chrome.action.getBadgeText({ tabId: id }), t.tabId);
  await expect.poll(badge).toBe('Guar');
  await t.page.goto(NO_ACCESS).catch(() => undefined);
  await expect.poll(badge).toBe('!');
  await t.page.goto('/whoami');
  await expect.poll(badge).toBe('Guar');
});

test('S21 favicon dot: composed on the site icon, follows the color, survives page icon changes, restored on leave', async ({ ext }) => {
  const s = await ext.ui<Meta>({ type: 'ui:create', name: 'Dotted', color: 'blue' });
  const t = await ext.openTab(null);
  await ext.ui({ type: 'ui:assign', tabId: t.tabId, sessionId: s.id });
  await t.page.goto('/');
  const ours = t.page.locator('link[data-sessionwoy-icon]');
  const marker = async () => ({
    color: await ours.getAttribute('data-sessionwoy-color'),
    source: await ours.getAttribute('data-sessionwoy-source'),
    rel: await ours.getAttribute('rel'),
  });

  // Composed on top of the site's own (same-origin SVG) favicon, which is disabled meanwhile.
  await expect.poll(marker).toEqual({ color: '#1a73e8', source: 'page', rel: 'icon' });
  expect(await ours.getAttribute('href')).toMatch(/^data:image\/png;base64,/);
  await expect(t.page.locator('link[href="/favicon.svg"]')).toHaveAttribute('rel', 'sessionwoy-disabled-icon');

  // Recolor: the dot follows without a reload.
  await ext.ui({ type: 'ui:update', id: s.id, color: 'red' });
  await expect.poll(marker).toEqual({ color: '#d93025', source: 'page', rel: 'icon' });

  // The page swaps its favicon (e.g. an unread counter): the dot is re-applied on top.
  await t.page.evaluate(() => {
    const l = document.createElement('link');
    l.rel = 'icon';
    l.href = '/favicon.svg?unread=3';
    document.head.appendChild(l);
  });
  await expect(t.page.locator('link[href="/favicon.svg?unread=3"]')).toHaveAttribute('rel', 'sessionwoy-disabled-icon');
  await expect(t.page.locator('link[rel="icon"]')).toHaveCount(1);
  await expect.poll(marker).toEqual({ color: '#d93025', source: 'page', rel: 'icon' });

  // Leaving the session (no reload): the marker goes away and the page icons are restored.
  await ext.call((id) => sessionwoy.assign(id, null), t.tabId);
  await expect(ours).toHaveCount(0);
  await expect(t.page.locator('link[href="/favicon.svg"]')).toHaveAttribute('rel', 'icon');

  // A page without a usable favicon (/whoami, and /favicon.ico is 404) gets a plain circle.
  await ext.call((a) => sessionwoy.assign(a.tab, a.sid), { tab: t.tabId, sid: s.id });
  await t.page.goto('/whoami?fallback=1');
  await expect.poll(marker).toEqual({ color: '#d93025', source: 'fallback', rel: 'icon' });
});

test('S19 side panel UI: create, rename and delete a session with real clicks', async ({ context, extensionId }) => {
  const errors: string[] = [];
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  await page.getByRole('button', { name: '+ New session' }).click();
  await page.getByLabel('Session name').fill('Smoke');
  await page.getByRole('radio', { name: 'purple' }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const row = page.locator('li[data-session="Smoke"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText('0 tabs · 0 cookies');

  await row.getByRole('button', { name: 'Rename' }).click();
  await row.getByLabel('New name').fill('Smoke 2');
  await row.getByRole('button', { name: 'Save' }).click();
  const renamed = page.locator('li[data-session="Smoke 2"]');
  await expect(renamed).toBeVisible();

  await renamed.getByRole('button', { name: 'Delete' }).click();
  await expect(renamed.getByRole('alert')).toContainText('cannot be undone');
  await renamed.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('li[data-session]')).toHaveCount(0);
  await expect(page.getByText('No sessions yet')).toBeVisible();

  // Marker mode in the side panel: "Per tab" by default, switchable with one click.
  const panelMode = page.getByRole('radiogroup', { name: 'Session marker mode' });
  await expect(panelMode.getByRole('radio', { name: 'Per tab' })).toHaveAttribute('aria-checked', 'true');
  await panelMode.getByRole('radio', { name: 'Per group' }).click();
  await expect(panelMode.getByRole('radio', { name: 'Per group' })).toHaveAttribute('aria-checked', 'true');

  // The popup also renders (opened as a page, its "active tab" is itself: not an http(s) page),
  // shows the same mode, and switching there updates the open side panel live.
  const popup = await context.newPage();
  popup.on('pageerror', (e) => errors.push(String(e)));
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.getByText('SessionWoy works on http(s) pages only.')).toBeVisible();
  const popupMode = popup.getByRole('radiogroup', { name: 'Session marker mode' });
  await expect(popupMode.getByRole('radio', { name: 'Per group' })).toHaveAttribute('aria-checked', 'true');
  await popupMode.getByRole('radio', { name: 'Per tab' }).click();
  await expect(panelMode.getByRole('radio', { name: 'Per tab' })).toHaveAttribute('aria-checked', 'true');
  expect(errors).toEqual([]);
});

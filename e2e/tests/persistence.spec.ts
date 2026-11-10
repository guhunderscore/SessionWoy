/**
 * Phase 4 scenarios (ADR 0004): encrypted persistence across a real browser restart (the same
 * profile directory is relaunched), passphrase lifecycle, backup, tab restore, backend.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, extFor, gotoJson, launchBrowser, test, type Ext } from '../fixtures.js';

const BACKEND_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend/dist/server.js');
const BACKEND_PORT = 3014;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

/**
 * Starts a private backend instance (own port, temp SQLite, random secret), so tests never touch the
 * `backend` Docker container's data. Same code as the container (`npm run build -w backend`).
 */
async function startBackend(dbFile: string, secret: string): Promise<{ stop: () => Promise<void> }> {
  const child: ChildProcess = spawn(process.execPath, [BACKEND_ENTRY], {
    env: { ...process.env, PORT: String(BACKEND_PORT), HOST: '127.0.0.1', DATABASE_PATH: dbFile, API_SECRET: secret, LOG: '0' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BACKEND_URL}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}

async function backendVault(secret: string) {
  const res = await fetch(`${BACKEND_URL}/v1/vault`, { headers: { authorization: `Bearer ${secret}`, origin: 'chrome-extension://e2e' } });
  return (await res.json()) as { header: unknown; sessions: Record<string, { ct: string; updatedAt: number }>; meta: { name: string }[] };
}

interface BackendState {
  backend: { enabled: boolean; state: string; pending: number; error: string | null; lastSyncAt: number | null };
}

const PASS = 'correct horse battery';

interface State {
  sessions: { id: string; name: string; cookieCount: number }[];
  tabSessionId: string | null;
  vault: { state: 'none' | 'locked' | 'unlocked'; savedSessions: number; lastSavedAt: number | null };
}

function profileDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'sessionwoy-profile-'));
}

/** Opens a tab on the test server and puts it into `sessionId` (via the same path as the popup). */
async function sessionTab(ext: Ext, sessionId: string) {
  const t = await ext.openTab(null);
  await ext.ui({ type: 'ui:assign', tabId: t.tabId, sessionId });
  return t;
}

test.describe.configure({ timeout: 120_000 });

test('S22 encrypted logins survive a browser restart: locked until unlock, ciphertext only on disk', async () => {
  const dir = profileDir();
  try {
    // --- first browser run
    let context = await launchBrowser(dir);
    let ext = await extFor(context);
    const s = await ext.ui<{ id: string }>({ type: 'ui:create', name: 'Keep', color: 'green' });
    const t = await sessionTab(ext, s.id);
    expect((await gotoJson(t.page, '/login?user=keepuser')).identity).toBe('keepuser');
    expect((await ext.ui<State>({ type: 'ui:state' })).vault.state).toBe('none');

    expect((await ext.uiRaw({ type: 'ui:vaultSetup', passphrase: 'short' })).ok).toBe(false);
    await ext.ui({ type: 'ui:vaultSetup', passphrase: PASS });
    let st = await ext.ui<State>({ type: 'ui:state' });
    expect(st.vault).toMatchObject({ state: 'unlocked', savedSessions: 1 });

    // A cookie set after setup is saved too (debounced write).
    await gotoJson(t.page, '/set-cookie?name=pref&value=dark');
    await expect.poll(async () => (await ext.ui<State>({ type: 'ui:state' })).vault.lastSavedAt).toBeGreaterThan(st.vault.lastSavedAt ?? 0);

    const disk = JSON.stringify(await ext.call(() => chrome.storage.local.get(null), null));
    expect(disk).toContain('sessionwoy:vault:v1');
    expect(disk).not.toContain('keepuser'); // cookie values are never on disk in plaintext
    expect(disk).not.toContain(PASS);
    await context.close();

    // --- browser restart (same profile)
    context = await launchBrowser(dir);
    ext = await extFor(context);
    st = await ext.ui<State>({ type: 'ui:state' });
    expect(st.vault).toMatchObject({ state: 'locked', savedSessions: 1 });
    expect(st.sessions.map((x) => [x.name, x.cookieCount])).toEqual([['Keep', 0]]);

    // While locked, a session tab runs logged out (never with shared cookies).
    const t2 = await sessionTab(ext, s.id);
    expect((await gotoJson(t2.page, '/whoami')).identity).toBe('anonymous');

    const wrong = await ext.uiRaw({ type: 'ui:unlock', passphrase: 'not the passphrase' });
    expect(wrong).toMatchObject({ ok: false, error: 'Wrong passphrase' });
    await ext.ui({ type: 'ui:unlock', passphrase: PASS });
    // Unlock reloads session tabs; navigate fresh afterwards.
    const after = await gotoJson(t2.page, '/whoami');
    expect(after.identity).toBe('keepuser');
    expect(after.cookies.pref).toBe('dark');
    expect((await ext.ui<State>({ type: 'ui:state' })).vault.state).toBe('unlocked');
    await context.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S25 tab sessions are restored after a browser restart; unmatched tabs are reported (FR-17)', async () => {
  const dir = profileDir();
  try {
    let context = await launchBrowser(dir);
    let ext = await extFor(context);
    const s = await ext.ui<{ id: string }>({ type: 'ui:create', name: 'Restored', color: 'cyan' });
    await ext.ui({ type: 'ui:vaultSetup', passphrase: PASS });
    const t = await sessionTab(ext, s.id);
    await gotoJson(t.page, '/login?user=restoreuser');
    await gotoJson(t.page, '/whoami?mark=restored');
    await t.page.waitForFunction(() => sessionStorage.getItem('__sessionwoy_tab') !== null);
    // A second session tab ends on a site without access: no content script there, so it cannot
    // report its marker after the restart and must be reported as not restored.
    const u = await sessionTab(ext, s.id);
    await u.page.goto('http://localhost:3999/unreachable').catch(() => undefined);
    await expect.poll(async () => (await ext.ui<State>({ type: 'ui:state' })).vault.savedSessions).toBe(1);
    await context.close();

    context = await launchBrowser(dir, ['--restore-last-session']);
    ext = await extFor(context);
    // The restored tab rejoins its session by itself.
    await expect
      .poll(async () => (await ext.ui<State & { sessions: { tabCount: number }[] }>({ type: 'ui:state' })).sessions[0]?.tabCount, {
        timeout: 20_000,
      })
      .toBe(1);
    const restored = context.pages().find((p) => p.url().includes('mark=restored'));
    expect(restored, 'restored tab').toBeTruthy();
    expect((await gotoJson(restored!, '/whoami?mark=restored')).identity).toBe('anonymous'); // locked
    await ext.ui({ type: 'ui:unlock', passphrase: PASS });
    expect((await gotoJson(restored!, '/whoami?mark=restored')).identity).toBe('restoreuser');

    // When the restore window ends, the tab that could not rejoin is reported, until dismissed.
    await ext.call(() => sessionwoy.endRestoreWindow(), null);
    expect((await ext.ui<State & { restore: { unrestored: number } }>({ type: 'ui:state' })).restore).toEqual({ active: false, unrestored: 1 });
    await ext.ui({ type: 'ui:dismissRestore' });
    expect((await ext.ui<State & { restore: { unrestored: number } }>({ type: 'ui:state' })).restore.unrestored).toBe(0);
    await context.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S26 backend: ciphertext only on the server; a fresh profile restores the logins from it (FR-18)', async ({ ext }) => {
  const dir = profileDir();
  const secret = randomBytes(32).toString('hex');
  const server = await startBackend(path.join(dir, 'backend.sqlite'), secret);
  try {
    const s = await ext.ui<{ id: string }>({ type: 'ui:create', name: 'Synced', color: 'orange' });
    const t = await sessionTab(ext, s.id);
    await gotoJson(t.page, '/login?user=backenduser');
    await ext.ui({ type: 'ui:vaultSetup', passphrase: PASS });

    expect((await ext.uiRaw({ type: 'ui:backend', patch: { url: 'http://192.168.0.2:3004', secret, enabled: true } })).ok).toBe(false);
    expect((await ext.uiRaw({ type: 'ui:backend', patch: { url: BACKEND_URL, secret: 'too short', enabled: true } })).ok).toBe(false);
    await ext.ui({ type: 'ui:backend', patch: { url: BACKEND_URL, secret, enabled: true } });
    await expect.poll(async () => (await ext.ui<BackendState>({ type: 'ui:state' })).backend).toMatchObject({ state: 'connected', pending: 0 });
    expect(JSON.stringify(await ext.ui<BackendState>({ type: 'ui:state' }))).not.toContain(secret); // never sent to the UI

    const remote = await backendVault(secret);
    expect(Object.keys(remote.sessions)).toEqual([s.id]);
    expect(remote.meta.map((m) => m.name)).toEqual(['Synced']);
    expect(JSON.stringify(remote)).not.toContain('backenduser');

    // A brand-new browser profile connects and restores.
    const other = await launchBrowser('');
    try {
      const ext2 = await extFor(other);
      await ext2.ui({ type: 'ui:backend', patch: { url: BACKEND_URL, secret, enabled: true } });
      // Connecting a new device must not overwrite what the backend already holds.
      expect((await ext2.ui<BackendState & { backend: { remoteDiffers: boolean } }>({ type: 'ui:state' })).backend.remoteDiffers).toBe(true);
      const untouched = await backendVault(secret);
      expect(untouched.meta.map((m) => m.name)).toEqual(['Synced']);
      expect(Object.keys(untouched.sessions)).toEqual([s.id]);
      expect(await ext2.uiRaw({ type: 'ui:backendRestore', passphrase: 'wrong passphrase' })).toMatchObject({ ok: false });
      expect(await ext2.ui({ type: 'ui:backendRestore', passphrase: PASS })).toEqual({ sessions: 1 });
      const st = await ext2.ui<State>({ type: 'ui:state' });
      expect(st.sessions.map((x) => x.name)).toEqual(['Synced']);
      expect(st.vault.state).toBe('unlocked');
      const t2 = await sessionTab(ext2, s.id);
      expect((await gotoJson(t2.page, '/whoami')).identity).toBe('backenduser');
    } finally {
      await other.close();
    }
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S27 reduced mode: backend down → offline, local saving continues, queued changes sync when it is back (FR-20)', async ({ ext }) => {
  const dir = profileDir();
  const secret = randomBytes(32).toString('hex');
  const db = path.join(dir, 'backend.sqlite');
  let server = await startBackend(db, secret);
  try {
    const s = await ext.ui<{ id: string }>({ type: 'ui:create', name: 'Offline', color: 'grey' });
    const t = await sessionTab(ext, s.id);
    await gotoJson(t.page, '/login?user=offlineuser');
    await ext.ui({ type: 'ui:vaultSetup', passphrase: PASS });
    await ext.ui({ type: 'ui:backend', patch: { url: BACKEND_URL, secret, enabled: true } });
    await expect.poll(async () => (await ext.ui<BackendState>({ type: 'ui:state' })).backend.state).toBe('connected');
    const before = (await backendVault(secret)).sessions[s.id]!.updatedAt;

    await server.stop();
    const savedBefore = (await ext.ui<State>({ type: 'ui:state' })).vault.lastSavedAt ?? 0;
    await gotoJson(t.page, '/set-cookie?name=pref&value=offline');
    // Local encrypted saving goes on; the backend change waits.
    await expect.poll(async () => (await ext.ui<State>({ type: 'ui:state' })).vault.lastSavedAt ?? 0).toBeGreaterThan(savedBefore);
    await expect
      .poll(async () => (await ext.ui<BackendState>({ type: 'ui:state' })).backend, { timeout: 15_000 })
      .toMatchObject({ state: 'offline', error: 'Backend is not reachable' });
    expect((await ext.ui<BackendState>({ type: 'ui:state' })).backend.pending).toBeGreaterThan(0);
    expect((await gotoJson(t.page, '/whoami')).identity).toBe('offlineuser'); // the session itself is unaffected

    server = await startBackend(db, secret);
    await ext.ui({ type: 'ui:backendSync' }); // the minute alarm would do the same
    await expect.poll(async () => (await ext.ui<BackendState>({ type: 'ui:state' })).backend).toMatchObject({ state: 'connected', pending: 0 });
    expect((await backendVault(secret)).sessions[s.id]!.updatedAt).toBeGreaterThan(before);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S24 encrypted backup: export, delete, import restores the login; wrong passphrase rejected', async ({ ext, context, extensionId }) => {
  const s = await ext.ui<{ id: string }>({ type: 'ui:create', name: 'Backed up', color: 'purple' });
  const t = await sessionTab(ext, s.id);
  await gotoJson(t.page, '/login?user=backupuser');

  const { fileName, data } = await ext.ui<{ fileName: string; data: string }>({ type: 'ui:export', passphrase: 'backup pass 1' });
  expect(fileName).toMatch(/^sessionwoy-backup-\d{4}-\d{2}-\d{2}\.json$/);
  expect(data).not.toContain('backupuser');
  expect(data).not.toContain('Backed up');

  // Replace: change the login, then import the backup over the existing session.
  await gotoJson(t.page, '/login?user=changed');
  const previewReplace = await ext.ui<{ sessions: { name: string; exists: boolean }[] }>({
    type: 'ui:import',
    data,
    passphrase: 'backup pass 1',
    apply: false,
  });
  expect(previewReplace.sessions).toEqual([expect.objectContaining({ name: 'Backed up', exists: true, cookies: 1 })]);
  expect((await gotoJson(t.page, '/whoami')).identity).toBe('changed'); // preview changes nothing
  await ext.ui({ type: 'ui:import', data, passphrase: 'backup pass 1', apply: true });
  expect((await gotoJson(t.page, '/whoami')).identity).toBe('backupuser');

  // Delete, then restore from the file.
  await ext.ui({ type: 'ui:delete', id: s.id });
  expect((await ext.ui<State>({ type: 'ui:state' })).sessions).toEqual([]);
  expect(await ext.uiRaw({ type: 'ui:import', data, passphrase: 'wrong passphrase', apply: true })).toMatchObject({
    ok: false,
    error: expect.stringContaining('Wrong passphrase'),
  });
  expect((await ext.uiRaw({ type: 'ui:import', data: '{"x":1}', passphrase: 'backup pass 1', apply: true })).ok).toBe(false);
  await ext.ui({ type: 'ui:import', data, passphrase: 'backup pass 1', apply: true });
  expect((await ext.ui<State>({ type: 'ui:state' })).sessions.map((x) => [x.name, x.cookieCount])).toEqual([['Backed up', 1]]);
  await ext.ui({ type: 'ui:assign', tabId: t.tabId, sessionId: s.id });
  expect((await gotoJson(t.page, '/whoami')).identity).toBe('backupuser');

  // The side panel's Export produces a real download.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: 'Export backup…' }).click();
  const backup = panel.getByRole('region', { name: 'Backup' });
  await backup.getByLabel('Passphrase', { exact: true }).fill('panel export 1');
  await backup.getByLabel('Repeat passphrase').fill('panel export 1');
  const [download] = await Promise.all([panel.waitForEvent('download'), backup.getByRole('button', { name: 'Export encrypted backup' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^sessionwoy-backup-.*\.json$/);
  await expect(backup.getByRole('status')).toContainText('Backup saved');
});

test('S23 lock now, change passphrase, forget saved logins', async ({ ext }) => {
  const s = await ext.ui<{ id: string }>({ type: 'ui:create', name: 'Lockable', color: 'red' });
  const t = await sessionTab(ext, s.id);
  await gotoJson(t.page, '/login?user=lockuser');
  await ext.ui({ type: 'ui:vaultSetup', passphrase: PASS });

  // Lock now: saved first, then every session tab is logged out.
  await ext.ui({ type: 'ui:lock' });
  expect((await ext.ui<State>({ type: 'ui:state' })).vault.state).toBe('locked');
  expect((await gotoJson(t.page, '/whoami')).identity).toBe('anonymous');
  await ext.ui({ type: 'ui:unlock', passphrase: PASS });
  expect((await gotoJson(t.page, '/whoami')).identity).toBe('lockuser');

  // Change passphrase: the old one stops working, the new one unlocks the same logins.
  expect((await ext.uiRaw({ type: 'ui:changePassphrase', current: 'wrong wrong', next: 'new passphrase!' })).ok).toBe(false);
  await ext.ui({ type: 'ui:changePassphrase', current: PASS, next: 'new passphrase!' });
  await ext.ui({ type: 'ui:lock' });
  expect((await ext.uiRaw({ type: 'ui:unlock', passphrase: PASS })).ok).toBe(false);
  await ext.ui({ type: 'ui:unlock', passphrase: 'new passphrase!' });
  expect((await gotoJson(t.page, '/whoami')).identity).toBe('lockuser');

  // Forget saved logins: the vault is gone, current in-memory logins keep working.
  await ext.ui({ type: 'ui:vaultReset' });
  const st = await ext.ui<State>({ type: 'ui:state' });
  expect(st.vault).toMatchObject({ state: 'none', savedSessions: 0 });
  expect((await gotoJson(t.page, '/whoami')).identity).toBe('lockuser');
  const disk = JSON.stringify(await ext.call(() => chrome.storage.local.get(null), null));
  expect(disk).not.toContain('sessionwoy:vault:v1');
});

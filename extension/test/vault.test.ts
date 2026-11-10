import { describe, expect, it } from 'vitest';
import { CookieJar, type StoredCookie } from '../src/shared/cookieJar.js';
import { VAULT_KEY, Vault, type KeyValueArea, type VaultStorage } from '../src/background/vault.js';

const FAST = 1_000; // low PBKDF2 iteration count keeps unit tests fast

function memoryArea(): KeyValueArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (k) => structuredClone(data.get(k)),
    set: async (k, v) => void data.set(k, structuredClone(v)),
    remove: async (k) => void data.delete(k),
  };
}

function storage() {
  const local = memoryArea();
  const memory = memoryArea();
  return { local, memory, s: { local, memory } satisfies VaultStorage };
}

function jarWith(...headers: string[]): StoredCookie[] {
  const jar = new CookieJar();
  for (const h of headers) jar.setFromHeader(h, new URL('http://localhost:3000/'), Date.now());
  return jar.all();
}

describe('Vault', () => {
  it('setup writes ciphertext only and is unlocked', async () => {
    const st = storage();
    const v = new Vault(st.s, FAST);
    expect(v.state).toBe('none');
    await v.setup('correct horse', { A: jarWith('sid=SECRET-A; HttpOnly') });
    expect(v.summary()).toMatchObject({ state: 'unlocked', savedSessions: 1 });
    const disk = JSON.stringify(st.local.data.get(VAULT_KEY));
    expect(disk).not.toContain('SECRET-A');
    expect(disk).not.toContain('correct horse');
    await expect(v.setup('again again', {})).rejects.toThrow('already set');
  });

  it('rejects a short passphrase', async () => {
    await expect(new Vault(storage().s, FAST).setup('short', {})).rejects.toThrow('at least 8');
  });

  it('survives a worker restart unlocked, and a browser restart locked', async () => {
    const st = storage();
    await new Vault(st.s, FAST).setup('correct horse', { A: jarWith('sid=a') });

    const afterWorkerRestart = new Vault(st.s, FAST);
    await afterWorkerRestart.load();
    expect(afterWorkerRestart.state).toBe('unlocked'); // key still in session memory

    st.memory.data.clear(); // browser restart: chrome.storage.session is gone
    const afterBrowserRestart = new Vault(st.s, FAST);
    await afterBrowserRestart.load();
    expect(afterBrowserRestart.state).toBe('locked');
    await expect(afterBrowserRestart.unlock('wrong horse!')).rejects.toThrow('Wrong passphrase');
    const plain = await afterBrowserRestart.unlock('correct horse');
    expect(plain.A?.map((c) => `${c.name}=${c.value}`)).toEqual(['sid=a']);
    expect(afterBrowserRestart.state).toBe('unlocked');
  });

  it('flushes dirty sessions only when unlocked; delete works while locked', async () => {
    const st = storage();
    const v = new Vault(st.s, FAST);
    await v.setup('correct horse', {});
    const jars: Record<string, StoredCookie[]> = { A: jarWith('sid=a'), B: jarWith('sid=b') };
    v.markDirty('A');
    v.markDirty('B');
    expect(await v.flush((id) => jars[id])).toEqual(['A', 'B']);
    expect(v.summary().savedSessions).toBe(2);

    await v.lock();
    v.markDirty('A');
    expect(await v.flush((id) => jars[id])).toEqual([]); // nothing can be written while locked
    expect(v.hasDirty()).toBe(true);
    await v.remove('B');
    expect(v.summary().savedSessions).toBe(1);

    await v.unlock('correct horse');
    jars.A = jarWith('sid=a2');
    expect(await v.flush((id) => jars[id])).toEqual(['A']);
    const plain = await v.decryptAll();
    expect(plain.A?.[0]?.value).toBe('a2');
    expect(plain.B).toBeUndefined();

    // An emptied jar or a deleted session removes its entry.
    v.markDirty('A');
    await v.flush(() => undefined);
    expect(v.summary().savedSessions).toBe(0);
  });

  it('changes the passphrase, re-encrypting everything', async () => {
    const st = storage();
    const v = new Vault(st.s, FAST);
    await v.setup('old passphrase', { A: jarWith('sid=a') });
    await expect(v.changePassphrase('not the old one', 'new passphrase')).rejects.toThrow('Current passphrase is wrong');
    await v.changePassphrase('old passphrase', 'new passphrase');
    expect(v.snapshot()!.keyVersion).toBe(2);
    st.memory.data.clear();
    const fresh = new Vault(st.s, FAST);
    await fresh.load();
    await expect(fresh.unlock('old passphrase')).rejects.toThrow();
    expect((await fresh.unlock('new passphrase')).A?.[0]?.value).toBe('a');
  });

  it('reset forgets saved logins', async () => {
    const st = storage();
    const v = new Vault(st.s, FAST);
    await v.setup('correct horse', { A: jarWith('sid=a') });
    await v.reset();
    expect(v.state).toBe('none');
    expect(st.local.data.has(VAULT_KEY)).toBe(false);
    expect(st.memory.data.size).toBe(0);
  });

  it('adopts a record from elsewhere (backend / import) with its passphrase', async () => {
    const a = storage();
    const source = new Vault(a.s, FAST);
    await source.setup('shared passphrase', { A: jarWith('sid=a') });
    const record = source.snapshot()!;

    const b = new Vault(storage().s, FAST);
    await expect(b.adopt(record, 'wrong passphrase')).rejects.toThrow('Wrong passphrase');
    expect((await b.adopt(record, 'shared passphrase')).A?.[0]?.value).toBe('a');
    expect(b.state).toBe('unlocked');
  });
});

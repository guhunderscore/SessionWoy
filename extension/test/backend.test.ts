import { describe, expect, it } from 'vitest';
import { BackendSync, normalizeBackendUrl } from '../src/background/backend.js';
import type { KeyValueArea, VaultRecord } from '../src/background/vault.js';

const SECRET = 's'.repeat(64);

function area(): KeyValueArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (k) => structuredClone(data.get(k)),
    set: async (k, v) => void data.set(k, structuredClone(v)),
    remove: async (k) => void data.delete(k),
  };
}

const record: VaultRecord = {
  v: 1,
  kdf: { alg: 'PBKDF2-SHA-256', iterations: 600_000, salt: 'c2FsdA==' },
  keyVersion: 1,
  check: { iv: 'aXY=', ct: 'Y2s=' },
  sessions: { s1: { iv: 'aXY=', ct: 'Y3Q=', updatedAt: 5 } },
};

/** Fake backend: records calls; `down` makes every request fail like a closed port. */
function fakeFetch() {
  const calls: { method: string; path: string; body?: unknown; auth?: string }[] = [];
  const state = { down: false };
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (state.down) throw new TypeError('Failed to fetch');
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.authorization });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, state, impl };
}

describe('backend sync', () => {
  it('only accepts loopback http URLs', () => {
    expect(normalizeBackendUrl('http://127.0.0.1:3004/')).toBe('http://127.0.0.1:3004');
    expect(normalizeBackendUrl('http://localhost:3004')).toBe('http://localhost:3004');
    expect(() => normalizeBackendUrl('https://127.0.0.1:3004')).toThrow();
    expect(() => normalizeBackendUrl('http://192.168.1.10:3004')).toThrow();
    expect(() => normalizeBackendUrl('http://example.com')).toThrow();
    expect(() => normalizeBackendUrl('http://127.0.0.1:3004/x')).toThrow();
  });

  it('requires a long secret to enable, and never exposes it in the summary', async () => {
    const b = new BackendSync(area(), fakeFetch().impl);
    await b.load();
    await expect(b.configure({ enabled: true })).rejects.toThrow('secret first');
    await expect(b.configure({ secret: 'short' })).rejects.toThrow('at least 32');
    await b.configure({ secret: SECRET, enabled: true });
    expect(JSON.stringify(b.summary())).not.toContain(SECRET);
    expect(b.summary()).toMatchObject({ enabled: true, hasSecret: true, state: 'unknown' });
  });

  it('pushes header, sessions, metadata and deletes with the bearer secret', async () => {
    const f = fakeFetch();
    const b = new BackendSync(area(), f.impl);
    await b.load();
    await b.configure({ secret: SECRET, enabled: true });
    expect(await b.pushAll(record, [])).toBe(true);
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['PUT /v1/vault/header', 'PUT /v1/vault/sessions/s1', 'PUT /v1/sessions']);
    expect(f.calls.every((c) => c.auth === `Bearer ${SECRET}`)).toBe(true);
    expect(f.calls[1]?.body).toEqual({ iv: 'aXY=', ct: 'Y3Q=', keyVersion: 1, updatedAt: 5 });
    expect(b.summary()).toMatchObject({ state: 'connected', pending: 0 });

    await b.queue(['gone']);
    await b.flush(record, []);
    expect(f.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/vault/sessions/gone' });
  });

  it('reduced mode: offline keeps changes (durably) and sends them when the backend is back', async () => {
    const f = fakeFetch();
    const local = area();
    const b = new BackendSync(local, f.impl);
    await b.load();
    await b.configure({ secret: SECRET, enabled: true });
    f.state.down = true;
    expect(await b.pushAll(record, [])).toBe(false);
    expect(b.summary()).toMatchObject({ state: 'offline', error: 'Backend is not reachable', pending: 3 });

    // Survives a worker restart.
    const again = new BackendSync(local, f.impl);
    await again.load();
    expect(again.summary().pending).toBe(3);
    f.state.down = false;
    expect(await again.flush(record, [])).toBe(true);
    expect(again.summary()).toMatchObject({ state: 'connected', pending: 0 });
  });

  it("never overwrites another device's vault implicitly; an explicit replace wipes first", async () => {
    const f = fakeFetch();
    const b = new BackendSync(area(), f.impl);
    await b.load();
    await b.configure({ secret: SECRET, enabled: true });
    const foreign = { header: { kdf: { ...record.kdf, salt: 'b3RoZXI=' }, check: record.check, keyVersion: 1 }, sessions: {}, meta: [] };
    expect(b.differs(foreign, null)).toBe(true); // new device, backend already has a vault
    expect(b.differs(foreign, record)).toBe(true); // different passphrase/salt
    expect(b.differs({ ...foreign, header: { ...foreign.header, kdf: record.kdf } }, record)).toBe(false); // same vault
    expect(b.differs({ header: null, sessions: {}, meta: [] }, null)).toBe(false); // empty backend

    b.setRemoteDiffers(true);
    expect(await b.pushAll(record, [])).toBe(false);
    expect(f.calls).toEqual([]); // nothing sent
    expect(b.summary()).toMatchObject({ remoteDiffers: true, pending: 3 });

    expect(await b.replaceRemote(record, [])).toBe(true);
    expect(f.calls.map((c) => `${c.method} ${c.path}`)[0]).toBe('DELETE /v1/vault');
    expect(b.summary()).toMatchObject({ remoteDiffers: false, pending: 0 });
    // After pushing its own header, a later passphrase change here is not "foreign".
    expect(b.differs({ header: { kdf: record.kdf, check: record.check, keyVersion: 1 }, sessions: {}, meta: [] }, { ...record, kdf: { ...record.kdf, salt: 'bmV3' } })).toBe(false);
  });

  it('a wipe replaces earlier pending work', async () => {
    const f = fakeFetch();
    const b = new BackendSync(area(), f.impl);
    await b.load();
    await b.configure({ secret: SECRET, enabled: true });
    f.state.down = true;
    await b.pushAll(record, []);
    await b.queue(['wipe']);
    expect(b.summary().pending).toBe(1);
    f.state.down = false;
    await b.flush(null, []);
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /v1/vault']);
  });
});

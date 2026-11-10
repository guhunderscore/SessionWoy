import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDb, type Db } from '../src/db.js';

const SECRET = 'x'.repeat(64);
const HOST = '127.0.0.1:3004';
const EXT = 'chrome-extension://abcdefghijklmnop';
const auth = { host: HOST, authorization: `Bearer ${SECRET}`, origin: EXT };

const header = {
  kdf: { alg: 'PBKDF2-SHA-256', iterations: 600_000, salt: 'c2FsdHNhbHRzYWx0c2FsdA==' },
  check: { iv: 'aXZpdml2aXZpdml2', ct: 'Y2hlY2s=' },
  keyVersion: 1,
};
const payload = { iv: 'aXZpdml2aXZpdml2', ct: 'ZW5jcnlwdGVk', keyVersion: 1, updatedAt: 123 };

let db: Db;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  db = openDb(':memory:');
  app = buildApp({ db, secret: SECRET, allowedHosts: [HOST, 'localhost:3004'] });
});
afterEach(async () => {
  await app.close();
  db.close();
});

describe('backend security', () => {
  it('health needs no secret but still checks Host and Origin', async () => {
    expect((await app.inject({ url: '/health', headers: { host: HOST } })).json()).toMatchObject({ ok: true, hasVault: false });
    expect((await app.inject({ url: '/health', headers: { host: '192.168.1.5:3004' } })).statusCode).toBe(421);
    expect((await app.inject({ url: '/health', headers: { host: HOST, origin: 'https://evil.example' } })).statusCode).toBe(403);
  });

  it('rejects missing or wrong secrets and website origins on /v1', async () => {
    expect((await app.inject({ url: '/v1/vault', headers: { host: HOST } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/vault', headers: { ...auth, authorization: 'Bearer nope' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/vault', headers: { ...auth, origin: 'http://localhost:3000' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/v1/vault', headers: auth })).statusCode).toBe(200);
  });

  it('can pin the exact extension origin', async () => {
    const pinned = buildApp({ db, secret: SECRET, allowedHosts: [HOST], allowedOrigins: [EXT] });
    expect((await pinned.inject({ url: '/v1/vault', headers: { ...auth, origin: 'chrome-extension://other' } })).statusCode).toBe(403);
    expect((await pinned.inject({ url: '/v1/vault', headers: auth })).statusCode).toBe(200);
    await pinned.close();
  });

  it('refuses a short secret at startup', () => {
    expect(() => buildApp({ db, secret: 'short', allowedHosts: [HOST] })).toThrow('at least 32');
  });
});

describe('backend vault API', () => {
  it('stores and returns ciphertext only; validates bodies', async () => {
    expect((await app.inject({ method: 'PUT', url: '/v1/vault/sessions/s1', headers: auth, payload })).statusCode).toBe(409); // no header yet
    expect((await app.inject({ method: 'PUT', url: '/v1/vault/header', headers: auth, payload: { ...header, kdf: { ...header.kdf, iterations: 10 } } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/v1/vault/header', headers: auth, payload: header })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/v1/vault/sessions/s1', headers: auth, payload })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/v1/vault/sessions/s1', headers: auth, payload: { ...payload, plaintext: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/v1/vault/sessions/bad%20id', headers: auth, payload })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/v1/vault/sessions/s2', headers: auth, payload: { ...payload, keyVersion: 7 } })).statusCode).toBe(409);

    const vault = (await app.inject({ url: '/v1/vault', headers: auth })).json();
    expect(vault.header).toMatchObject({ keyVersion: 1, kdf: header.kdf, check: header.check });
    expect(vault.sessions).toEqual({ s1: { iv: payload.iv, ct: payload.ct, keyVersion: 1, updatedAt: 123 } });
    expect((await app.inject({ url: '/health', headers: { host: HOST } })).json().hasVault).toBe(true);
  });

  it('a new key version drops payloads under the old key; delete and wipe work', async () => {
    await app.inject({ method: 'PUT', url: '/v1/vault/header', headers: auth, payload: header });
    await app.inject({ method: 'PUT', url: '/v1/vault/sessions/s1', headers: auth, payload });
    await app.inject({ method: 'PUT', url: '/v1/vault/sessions/s2', headers: auth, payload });
    await app.inject({ method: 'DELETE', url: '/v1/vault/sessions/s2', headers: auth });
    expect(Object.keys((await app.inject({ url: '/v1/vault', headers: auth })).json().sessions)).toEqual(['s1']);
    await app.inject({ method: 'PUT', url: '/v1/vault/header', headers: auth, payload: { ...header, keyVersion: 2 } });
    expect((await app.inject({ url: '/v1/vault', headers: auth })).json().sessions).toEqual({});
    await app.inject({ method: 'DELETE', url: '/v1/vault', headers: auth });
    expect((await app.inject({ url: '/v1/vault', headers: auth })).json().header).toBeNull();
  });

  it('mirrors session metadata', async () => {
    const sessions = [{ id: 's1', name: 'Customer', color: 'blue', status: 'active', createdAt: 1, updatedAt: 2 }];
    expect((await app.inject({ method: 'PUT', url: '/v1/sessions', headers: auth, payload: { sessions } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/v1/sessions', headers: auth, payload: { sessions: [{ ...sessions[0], color: 'magenta' }] } })).statusCode).toBe(400);
    expect((await app.inject({ url: '/v1/vault', headers: auth })).json().meta).toEqual(sessions);
  });

  it('migrations are applied once', () => {
    const rows = db.prepare('SELECT name FROM schema_migrations').all();
    expect(rows).toEqual([{ name: '001_init.sql' }]);
  });
});

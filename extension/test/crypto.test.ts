import { describe, expect, it } from 'vitest';
import {
  KDF_ITERATIONS,
  fromB64,
  importKey,
  isKdfParams,
  isSealed,
  makeCheck,
  newKdfParams,
  open,
  seal,
  toB64,
  unlockKey,
  validatePassphrase,
  verifyCheck,
} from '../src/shared/crypto.js';

// Low iteration count keeps unit tests fast; production uses KDF_ITERATIONS.
const FAST = 1_000;

describe('crypto', () => {
  it('uses strong defaults', () => {
    expect(KDF_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    const kdf = newKdfParams();
    expect(kdf).toMatchObject({ alg: 'PBKDF2-SHA-256', iterations: KDF_ITERATIONS });
    expect(fromB64(kdf.salt)).toHaveLength(16);
    expect(newKdfParams().salt).not.toBe(kdf.salt);
    expect(isKdfParams(kdf)).toBe(true);
    expect(isKdfParams({ alg: 'md5' })).toBe(false);
  });

  it('base64 round-trips binary data', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 256);
    expect(fromB64(toB64(bytes))).toEqual(bytes);
  });

  it('validates passphrases', () => {
    expect(validatePassphrase('short').ok).toBe(false);
    expect(validatePassphrase(12345678).ok).toBe(false);
    expect(validatePassphrase('long enough').ok).toBe(true);
  });

  it('seals and opens data; IVs are unique; ciphertext does not contain the plaintext', async () => {
    const kdf = newKdfParams(FAST);
    const { key } = (await unlockKey('correct horse', kdf))!;
    const data = [{ name: 'sid', value: 'SECRET-VALUE-123' }];
    const a = await seal(key, data);
    const b = await seal(key, data);
    expect(isSealed(a)).toBe(true);
    expect(a.iv).not.toBe(b.iv);
    expect(fromB64(a.iv)).toHaveLength(12);
    expect(atob(a.ct)).not.toContain('SECRET-VALUE-123');
    expect(await open(key, a)).toEqual(data);
  });

  it('rejects a wrong passphrase via the check value', async () => {
    const kdf = newKdfParams(FAST);
    const { key } = (await unlockKey('correct horse', kdf))!;
    const check = await makeCheck(key);
    expect(await verifyCheck(key, check)).toBe(true);
    expect(await unlockKey('wrong horse!', kdf, check)).toBeNull();
    expect(await unlockKey('correct horse', kdf, check)).not.toBeNull();
  });

  it('detects tampering and wrong keys when opening', async () => {
    const kdf = newKdfParams(FAST);
    const { key } = (await unlockKey('correct horse', kdf))!;
    const sealed = await seal(key, { a: 1 });
    const ct = fromB64(sealed.ct);
    ct[0]! ^= 0xff;
    await expect(open(key, { iv: sealed.iv, ct: toB64(ct) })).rejects.toThrow();
    const other = await importKey(crypto.getRandomValues(new Uint8Array(new ArrayBuffer(32))));
    await expect(open(other, sealed)).rejects.toThrow();
  });

  it('derives the same key from the same passphrase and salt', async () => {
    const kdf = newKdfParams(FAST);
    const a = (await unlockKey('same pass', kdf))!;
    const b = (await unlockKey('same pass', kdf))!;
    expect(a.raw).toEqual(b.raw);
    const c = (await unlockKey('same pass', newKdfParams(FAST)))!;
    expect(c.raw).not.toEqual(a.raw);
  });
});

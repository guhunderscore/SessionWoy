/**
 * Encryption at rest (PRD §13, ADR 0004). Pure Web Crypto, usable in the service worker, the UI and
 * Node 22 (unit tests).
 *
 * - Key derivation: PBKDF2-SHA-256 with a random 16-byte salt and 600,000 iterations (OWASP 2023).
 * - Cipher: AES-256-GCM with a random 12-byte IV per encryption; the GCM tag rejects tampering
 *   and wrong keys.
 * - A "check" value (a sealed constant) lets us tell a wrong passphrase apart without decrypting data.
 *
 * Nothing here logs, and callers must never log passphrases, keys or decrypted payloads.
 */

export const KDF_ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 8;
const CHECK_TEXT = 'sessionwoy-vault-check-v1';

export interface KdfParams {
  alg: 'PBKDF2-SHA-256';
  iterations: number;
  /** base64, 16 bytes */
  salt: string;
}

export interface Sealed {
  /** base64, 12 bytes */
  iv: string;
  /** base64 ciphertext + GCM tag */
  ct: string;
}

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));
}

export function validatePassphrase(p: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof p !== 'string' || p.length < MIN_PASSPHRASE) {
    return { ok: false, error: `Passphrase must be at least ${MIN_PASSPHRASE} characters` };
  }
  if (p.length > 1024) return { ok: false, error: 'Passphrase is too long' };
  return { ok: true };
}

export function newKdfParams(iterations = KDF_ITERATIONS): KdfParams {
  return { alg: 'PBKDF2-SHA-256', iterations, salt: toB64(randomBytes(16)) };
}

export function isKdfParams(v: unknown): v is KdfParams {
  const k = v as Partial<KdfParams> | null;
  return (
    !!k &&
    k.alg === 'PBKDF2-SHA-256' &&
    typeof k.iterations === 'number' &&
    k.iterations >= 1 &&
    typeof k.salt === 'string' &&
    k.salt.length > 0
  );
}

export function isSealed(v: unknown): v is Sealed {
  const s = v as Partial<Sealed> | null;
  return !!s && typeof s.iv === 'string' && typeof s.ct === 'string' && s.iv.length > 0 && s.ct.length > 0;
}

/** Derives the raw 256-bit key. Raw bytes are only kept in memory (see background/vault.ts). */
export async function deriveKeyBytes(passphrase: string, kdf: KdfParams): Promise<Uint8Array<ArrayBuffer>> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(kdf.salt), iterations: kdf.iterations },
    base,
    256,
  );
  return new Uint8Array(bits);
}

/** Imports raw key bytes as a non-extractable AES-GCM key. */
export function importKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function seal(key: CryptoKey, data: unknown): Promise<Sealed> {
  const iv = randomBytes(12);
  const plain = new TextEncoder().encode(JSON.stringify(data));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return { iv: toB64(iv), ct: toB64(ct) };
}

/** Decrypts and parses; throws on a wrong key or tampered data. */
export async function open<T>(key: CryptoKey, sealed: Sealed): Promise<T> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(sealed.iv) }, key, fromB64(sealed.ct));
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

export function makeCheck(key: CryptoKey): Promise<Sealed> {
  return seal(key, CHECK_TEXT);
}

/** True when `key` was derived from the same passphrase as the check value. */
export async function verifyCheck(key: CryptoKey, check: Sealed): Promise<boolean> {
  try {
    return (await open<string>(key, check)) === CHECK_TEXT;
  } catch {
    return false;
  }
}

/** Convenience: passphrase → key, verified against `check` when given. Returns null if wrong. */
export async function unlockKey(
  passphrase: string,
  kdf: KdfParams,
  check?: Sealed,
): Promise<{ key: CryptoKey; raw: Uint8Array<ArrayBuffer> } | null> {
  const raw = await deriveKeyBytes(passphrase, kdf);
  const key = await importKey(raw);
  if (check && !(await verifyCheck(key, check))) return null;
  return { key, raw };
}

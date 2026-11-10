/**
 * Encrypted cookie vault (FR-15, PRD §13, ADR 0004).
 *
 * Durable record in chrome.storage.local (`sessionwoy:vault:v1`):
 *   { v, kdf, keyVersion, check, sessions: { [sessionId]: { iv, ct, updatedAt } } }
 * Each session's whole cookie jar is one AES-256-GCM ciphertext. No plaintext cookie, passphrase or
 * key is ever written there.
 *
 * Key lifetime: after unlock, the raw key bytes live in chrome.storage.session (memory only, cleared
 * on browser restart and extension reload, unreadable by content scripts), so a suspended service
 * worker resumes unlocked (FR-16). Lock / restart drops the key.
 *
 * Storage is injected (`VaultStorage`) so the lifecycle is unit-testable without Chrome.
 */
import type { StoredCookie } from '../shared/cookieJar.js';
import {
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
  type KdfParams,
  type Sealed,
} from '../shared/crypto.js';

import type { VaultSummary } from '../shared/messages.js';

export type VaultState = VaultSummary['state'];
export type { VaultSummary };

export interface SealedSession extends Sealed {
  updatedAt: number;
}

export interface VaultRecord {
  v: 1;
  kdf: KdfParams;
  keyVersion: number;
  check: Sealed;
  sessions: Record<string, SealedSession>;
}

export interface KeyValueArea {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface VaultStorage {
  /** Durable (chrome.storage.local). */
  local: KeyValueArea;
  /** Memory only (chrome.storage.session). */
  memory: KeyValueArea;
}

export const VAULT_KEY = 'sessionwoy:vault:v1';
const MEMORY_KEY = 'sessionwoy:vault-key:v1';

export function chromeArea(area: chrome.storage.StorageArea): KeyValueArea {
  return {
    get: async (key) => (await area.get(key))[key],
    set: (key, value) => area.set({ [key]: value }),
    remove: (key) => area.remove(key),
  };
}

export function chromeVaultStorage(): VaultStorage {
  return { local: chromeArea(chrome.storage.local), memory: chromeArea(chrome.storage.session) };
}

export function isVaultRecord(v: unknown): v is VaultRecord {
  const r = v as Partial<VaultRecord> | null;
  return (
    !!r &&
    r.v === 1 &&
    isKdfParams(r.kdf) &&
    typeof r.keyVersion === 'number' &&
    isSealed(r.check) &&
    !!r.sessions &&
    typeof r.sessions === 'object' &&
    Object.values(r.sessions).every((s) => isSealed(s) && typeof (s as SealedSession).updatedAt === 'number')
  );
}

export class Vault {
  private record: VaultRecord | null = null;
  private key: CryptoKey | null = null;
  private dirty = new Set<string>();
  lastSavedAt: number | null = null;

  constructor(
    private readonly storage: VaultStorage,
    private readonly iterations?: number,
  ) {}

  get state(): VaultState {
    return !this.record ? 'none' : this.key ? 'unlocked' : 'locked';
  }

  summary(): VaultSummary {
    return { state: this.state, savedSessions: this.record ? Object.keys(this.record.sessions).length : 0, lastSavedAt: this.lastSavedAt };
  }

  /** Current record (ciphertext only), e.g. for the backend. */
  snapshot(): VaultRecord | null {
    return this.record ? structuredClone(this.record) : null;
  }

  /** Reads the durable record and, if this browser session already unlocked it, the key. */
  async load(): Promise<void> {
    const raw = await this.storage.local.get(VAULT_KEY);
    this.record = isVaultRecord(raw) ? raw : null;
    this.key = null;
    if (!this.record) return;
    const keyB64 = await this.storage.memory.get(MEMORY_KEY);
    if (typeof keyB64 !== 'string') return;
    const key = await importKey(fromB64(keyB64));
    if (await verifyCheck(key, this.record.check)) this.key = key;
    else await this.storage.memory.remove(MEMORY_KEY);
  }

  private async persist(): Promise<void> {
    if (this.record) await this.storage.local.set(VAULT_KEY, this.record);
    else await this.storage.local.remove(VAULT_KEY);
  }

  private async holdKey(key: CryptoKey, raw: Uint8Array): Promise<void> {
    this.key = key;
    await this.storage.memory.set(MEMORY_KEY, toB64(raw));
  }

  /** First-time setup. All sessions passed in are written immediately. */
  async setup(passphrase: string, sessions: Record<string, StoredCookie[]>): Promise<void> {
    if (this.record) throw new Error('A passphrase is already set');
    const v = validatePassphrase(passphrase);
    if (!v.ok) throw new Error(v.error);
    const kdf = newKdfParams(this.iterations);
    const { key, raw } = (await unlockKey(passphrase, kdf))!;
    this.record = { v: 1, kdf, keyVersion: 1, check: await makeCheck(key), sessions: {} };
    await this.holdKey(key, raw);
    for (const [id, cookies] of Object.entries(sessions)) await this.write(id, cookies);
    await this.persist();
    this.lastSavedAt = Date.now();
  }

  /** Verifies the passphrase and returns every saved session's cookies. Throws on a wrong passphrase. */
  async unlock(passphrase: string): Promise<Record<string, StoredCookie[]>> {
    if (!this.record) throw new Error('No passphrase is set yet');
    const res = await unlockKey(passphrase, this.record.kdf, this.record.check);
    if (!res) throw new Error('Wrong passphrase');
    await this.holdKey(res.key, res.raw);
    return this.decryptAll();
  }

  async decryptAll(): Promise<Record<string, StoredCookie[]>> {
    if (!this.record || !this.key) throw new Error('Vault is locked');
    const out: Record<string, StoredCookie[]> = {};
    for (const [id, sealed] of Object.entries(this.record.sessions)) {
      try {
        out[id] = await open<StoredCookie[]>(this.key, sealed);
      } catch {
        // A damaged entry must not block the others; it is dropped on the next save.
        delete this.record.sessions[id];
      }
    }
    return out;
  }

  async lock(): Promise<void> {
    this.key = null;
    await this.storage.memory.remove(MEMORY_KEY);
  }

  markDirty(sessionId: string): void {
    this.dirty.add(sessionId);
  }

  hasDirty(): boolean {
    return this.dirty.size > 0;
  }

  private async write(sessionId: string, cookies: StoredCookie[] | undefined): Promise<void> {
    if (!this.record || !this.key) return;
    if (!cookies || cookies.length === 0) delete this.record.sessions[sessionId];
    else this.record.sessions[sessionId] = { ...(await seal(this.key, cookies)), updatedAt: Date.now() };
  }

  /**
   * Encrypts and saves dirty sessions. `getCookies` returns a session's current cookies, or
   * undefined when the session no longer exists. Returns the ids written (empty while locked).
   */
  async flush(getCookies: (sessionId: string) => StoredCookie[] | undefined): Promise<string[]> {
    if (!this.record || !this.key || this.dirty.size === 0) return [];
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) await this.write(id, getCookies(id));
    await this.persist();
    this.lastSavedAt = Date.now();
    return ids;
  }

  /** Deletes a session's saved cookies. Works while locked (no key needed to delete ciphertext). */
  async remove(sessionId: string): Promise<void> {
    this.dirty.delete(sessionId);
    if (!this.record || !(sessionId in this.record.sessions)) return;
    delete this.record.sessions[sessionId];
    await this.persist();
  }

  async changePassphrase(current: string, next: string): Promise<void> {
    if (!this.record) throw new Error('No passphrase is set yet');
    const v = validatePassphrase(next);
    if (!v.ok) throw new Error(v.error);
    const old = await unlockKey(current, this.record.kdf, this.record.check);
    if (!old) throw new Error('Current passphrase is wrong');
    this.key = old.key;
    const plain = await this.decryptAll();
    const kdf = newKdfParams(this.iterations);
    const { key, raw } = (await unlockKey(next, kdf))!;
    this.record = { v: 1, kdf, keyVersion: this.record.keyVersion + 1, check: await makeCheck(key), sessions: {} };
    await this.holdKey(key, raw);
    for (const [id, cookies] of Object.entries(plain)) await this.write(id, cookies);
    await this.persist();
    this.lastSavedAt = Date.now();
  }

  /** "Forget saved logins": wipes the vault (e.g. lost passphrase). In-memory cookies are untouched. */
  async reset(): Promise<void> {
    this.record = null;
    this.dirty.clear();
    this.lastSavedAt = null;
    await this.lock();
    await this.persist();
  }

  /** Replaces the durable record (restore from backend / import); requires the matching passphrase. */
  async adopt(record: VaultRecord, passphrase: string): Promise<Record<string, StoredCookie[]>> {
    if (!isVaultRecord(record)) throw new Error('Invalid vault data');
    const res = await unlockKey(passphrase, record.kdf, record.check);
    if (!res) throw new Error('Wrong passphrase for this data');
    this.record = structuredClone(record);
    await this.holdKey(res.key, res.raw);
    const plain = await this.decryptAll();
    await this.persist();
    return plain;
  }
}

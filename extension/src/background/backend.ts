/**
 * Sync with the optional local backend (FR-18, FR-20, FR-21, ADR 0004).
 *
 * Only ciphertext leaves the extension: the vault header (KDF salt/iterations + sealed check value),
 * one sealed payload per session, and the session list (names/colors, not secret).
 *
 * Reduced mode (FR-20): if the backend is unreachable, nothing is blocked. The encrypted vault in
 * the extension keeps working; pending changes are remembered (durably) and retried every minute;
 * the status shows "offline".
 *
 * The bearer secret is stored in chrome.storage.local (it protects a loopback-only API from
 * websites; it is not a cookie). It is never sent to the UI, logs or diagnostics.
 */
import type { SessionMeta } from '../shared/sessions.js';
import type { BackendSummary } from '../shared/messages.js';
import type { KeyValueArea, VaultRecord } from './vault.js';

export type { BackendSummary };

export interface BackendSettings {
  enabled: boolean;
  url: string;
  secret: string;
  /** KDF salt of the vault header this device last pushed (ownership check, not secret). */
  lastPushedSalt?: string;
}

export interface RemoteVault {
  header: { kdf: VaultRecord['kdf']; check: VaultRecord['check']; keyVersion: number } | null;
  sessions: Record<string, { iv: string; ct: string; keyVersion: number; updatedAt: number }>;
  meta: SessionMeta[];
}

const SETTINGS_KEY = 'sessionwoy:backend:v1';
const PENDING_KEY = 'sessionwoy:backend-pending:v1';
export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:3004';
const TIMEOUT_MS = 5000;

/** Pending work: `header`, `meta`, `wipe`, or a session id. */
type PendingItem = string;

/** Only loopback http URLs are allowed: the backend must never be reachable from the network. */
export function normalizeBackendUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Backend URL is required');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('Backend URL is not valid');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/' || url.search) {
    throw new Error('Backend URL must be http://127.0.0.1:<port> or http://localhost:<port>');
  }
  return url.origin;
}

export class BackendSync {
  settings: BackendSettings = { enabled: false, url: DEFAULT_BACKEND_URL, secret: '' };
  private pending = new Set<PendingItem>();
  private state: BackendSummary['state'] = 'disabled';
  private error: string | null = null;
  private lastSyncAt: number | null = null;
  private checkedAt: number | null = null;
  /**
   * The backend holds a different vault (another device or passphrase). Pushing would overwrite it,
   * so nothing is sent until the user restores from it or explicitly replaces it.
   */
  private remoteDiffers = false;

  constructor(
    private readonly local: KeyValueArea,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  async load(): Promise<void> {
    const s = (await this.local.get(SETTINGS_KEY)) as Partial<BackendSettings> | undefined;
    this.settings = {
      enabled: s?.enabled === true,
      url: typeof s?.url === 'string' ? s.url : DEFAULT_BACKEND_URL,
      secret: typeof s?.secret === 'string' ? s.secret : '',
      ...(typeof s?.lastPushedSalt === 'string' ? { lastPushedSalt: s.lastPushedSalt } : {}),
    };
    const p = await this.local.get(PENDING_KEY);
    this.pending = new Set(Array.isArray(p) ? (p as string[]) : []);
    this.state = this.settings.enabled ? 'unknown' : 'disabled';
  }

  summary(): BackendSummary {
    return {
      enabled: this.settings.enabled,
      url: this.settings.url,
      hasSecret: this.settings.secret.length > 0,
      state: this.state,
      error: this.error,
      lastSyncAt: this.lastSyncAt,
      checkedAt: this.checkedAt,
      pending: this.pending.size,
      remoteDiffers: this.remoteDiffers,
    };
  }

  setRemoteDiffers(v: boolean): void {
    this.remoteDiffers = v;
  }

  /**
   * True when the backend holds a vault this device did not write: its KDF salt matches neither the
   * local vault nor the header this device last pushed (so a passphrase change here is not "foreign").
   */
  differs(remote: RemoteVault, local: VaultRecord | null): boolean {
    if (!remote.header) return false;
    const salt = remote.header.kdf.salt;
    return salt !== local?.kdf.salt && salt !== this.settings.lastPushedSalt;
  }

  async configure(patch: { enabled?: unknown; url?: unknown; secret?: unknown }): Promise<void> {
    if (patch.url !== undefined) this.settings.url = normalizeBackendUrl(patch.url);
    if (patch.secret !== undefined) {
      if (typeof patch.secret !== 'string' || patch.secret.trim().length < 32) {
        throw new Error('The backend secret must be at least 32 characters (API_SECRET in .env)');
      }
      this.settings.secret = patch.secret.trim();
    }
    if (patch.enabled !== undefined) {
      if (patch.enabled === true && !this.settings.secret) throw new Error('Enter the backend secret first');
      this.settings.enabled = patch.enabled === true;
    }
    this.state = this.settings.enabled ? 'unknown' : 'disabled';
    this.error = null;
    if (!this.settings.enabled) this.pending.clear();
    this.remoteDiffers = false; // re-checked against the backend before the next push
    await this.local.set(SETTINGS_KEY, this.settings);
    await this.savePending();
  }

  private async savePending(): Promise<void> {
    await this.local.set(PENDING_KEY, [...this.pending]);
  }

  async queue(items: PendingItem[]): Promise<void> {
    if (!this.settings.enabled || items.length === 0) return;
    // A wipe supersedes everything queued before it.
    if (items.includes('wipe')) this.pending.clear();
    for (const i of items) this.pending.add(i);
    await this.savePending();
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(this.settings.url + path, {
      method,
      headers: {
        authorization: `Bearer ${this.settings.secret}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg += `: ${j.error}`;
      } catch {
        /* no JSON body */
      }
      throw new Error(res.status === 401 ? 'Wrong backend secret' : msg);
    }
    return res.json();
  }

  private ok(now = Date.now()): void {
    this.state = 'connected';
    this.error = null;
    this.checkedAt = now;
  }

  private fail(e: unknown, now = Date.now()): void {
    this.state = 'offline';
    this.error = e instanceof Error ? (e.name === 'TimeoutError' ? 'Backend did not answer' : e.message) : String(e);
    if (/fetch|network|Failed/i.test(this.error)) this.error = 'Backend is not reachable';
    this.checkedAt = now;
  }

  /** FR-21: health check (no secret needed). */
  async checkHealth(): Promise<boolean> {
    if (!this.settings.enabled) return false;
    try {
      await this.request('GET', '/health');
      this.ok();
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  /**
   * Pushes pending changes. `record` is the local vault (ciphertext only, or null without a
   * passphrase); `meta` is the session list. Keeps pending items on failure (reduced mode).
   */
  async flush(record: VaultRecord | null, meta: SessionMeta[]): Promise<boolean> {
    if (!this.settings.enabled || this.pending.size === 0) return true;
    // Never overwrite another device's vault implicitly; only an explicit replace (wipe) proceeds.
    if (this.remoteDiffers && !this.pending.has('wipe')) return false;
    const todo = [...this.pending];
    try {
      if (todo.includes('wipe')) await this.request('DELETE', '/v1/vault');
      if (record && (todo.includes('header') || todo.includes('wipe'))) {
        await this.request('PUT', '/v1/vault/header', { kdf: record.kdf, check: record.check, keyVersion: record.keyVersion });
        this.settings.lastPushedSalt = record.kdf.salt;
        await this.local.set(SETTINGS_KEY, this.settings);
      }
      for (const id of todo) {
        if (id === 'header' || id === 'meta' || id === 'wipe') continue;
        const s = record?.sessions[id];
        if (s && record) {
          await this.request('PUT', `/v1/vault/sessions/${encodeURIComponent(id)}`, {
            iv: s.iv,
            ct: s.ct,
            keyVersion: record.keyVersion,
            updatedAt: s.updatedAt,
          });
        } else {
          await this.request('DELETE', `/v1/vault/sessions/${encodeURIComponent(id)}`);
        }
      }
      if (todo.includes('meta')) await this.request('PUT', '/v1/sessions', { sessions: meta });
      for (const i of todo) this.pending.delete(i);
      await this.savePending();
      if (todo.includes('wipe')) this.remoteDiffers = false;
      this.ok();
      this.lastSyncAt = Date.now();
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  /** Everything: header, every saved session, the session list. */
  async pushAll(record: VaultRecord | null, meta: SessionMeta[]): Promise<boolean> {
    await this.queue(['header', 'meta', ...Object.keys(record?.sessions ?? {})]);
    return this.flush(record, meta);
  }

  /** Explicit "replace the backend with this device": wipe first, then push everything. */
  async replaceRemote(record: VaultRecord | null, meta: SessionMeta[]): Promise<boolean> {
    await this.queue(['wipe']);
    await this.queue(['header', 'meta', ...Object.keys(record?.sessions ?? {})]);
    return this.flush(record, meta);
  }

  async pull(): Promise<RemoteVault> {
    try {
      const v = (await this.request('GET', '/v1/vault')) as RemoteVault;
      this.ok();
      return v;
    } catch (e) {
      this.fail(e);
      throw e;
    }
  }
}

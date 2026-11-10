/**
 * Encrypted backup file (FR-19, ADR 0004).
 *
 * File: `{ format: 'sessionwoy-backup', v: 1, exportedAt, kdf, iv, ct }`. Everything that matters
 * (session metadata and cookie jars) is inside the AES-256-GCM ciphertext, encrypted with a
 * passphrase chosen at export time (PBKDF2-SHA-256, own random salt). Without that passphrase the file
 * reveals nothing but its creation time. Settings are not part of a backup.
 */
import type { StoredCookie } from './cookieJar.js';
import { isKdfParams, isSealed, newKdfParams, open, seal, unlockKey, validatePassphrase, type KdfParams } from './crypto.js';
import { normalizeMeta, type SessionMeta } from './sessions.js';

export const BACKUP_FORMAT = 'sessionwoy-backup';

export interface BackupContent {
  sessions: SessionMeta[];
  cookies: Record<string, StoredCookie[]>;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  v: 1;
  exportedAt: string;
  kdf: KdfParams;
  iv: string;
  ct: string;
}

export function backupFileName(date = new Date()): string {
  return `sessionwoy-backup-${date.toISOString().slice(0, 10)}.json`;
}

export async function createBackup(content: BackupContent, passphrase: string, iterations?: number): Promise<BackupFile> {
  const v = validatePassphrase(passphrase);
  if (!v.ok) throw new Error(v.error);
  const kdf = newKdfParams(iterations);
  const { key } = (await unlockKey(passphrase, kdf))!;
  const sealed = await seal(key, { v: 1, ...content });
  return { format: BACKUP_FORMAT, v: 1, exportedAt: new Date().toISOString(), kdf, ...sealed };
}

function isStoredCookie(c: unknown): c is StoredCookie {
  const x = c as Partial<StoredCookie> | null;
  return (
    !!x &&
    typeof x.name === 'string' &&
    typeof x.value === 'string' &&
    typeof x.domain === 'string' &&
    typeof x.path === 'string' &&
    typeof x.hostOnly === 'boolean' &&
    typeof x.secure === 'boolean' &&
    typeof x.httpOnly === 'boolean' &&
    (x.sameSite === 'lax' || x.sameSite === 'strict' || x.sameSite === 'none') &&
    (x.expires === null || typeof x.expires === 'number') &&
    typeof x.created === 'number'
  );
}

/** Parses and decrypts a backup. Throws a user-readable error for a wrong file or passphrase. */
export async function readBackup(raw: unknown, passphrase: string): Promise<BackupContent> {
  let file: unknown = raw;
  if (typeof raw === 'string') {
    try {
      file = JSON.parse(raw);
    } catch {
      throw new Error('This is not a SessionWoy backup file');
    }
  }
  const f = file as Partial<BackupFile> | null;
  if (!f || f.format !== BACKUP_FORMAT) throw new Error('This is not a SessionWoy backup file');
  const kdf = f.kdf;
  const sealed = { iv: f.iv, ct: f.ct };
  if (f.v !== 1 || !isKdfParams(kdf) || !isSealed(sealed)) throw new Error('Unsupported or damaged backup file');
  const { key } = (await unlockKey(passphrase, kdf))!;
  let content: Partial<BackupContent> & { v?: number };
  try {
    content = await open(key, sealed);
  } catch {
    throw new Error('Wrong passphrase for this backup (or the file was changed)');
  }
  const sessions = (Array.isArray(content.sessions) ? content.sessions : [])
    .map(normalizeMeta)
    .filter((m): m is SessionMeta => m !== null);
  const ids = new Set(sessions.map((s) => s.id));
  const cookies: Record<string, StoredCookie[]> = {};
  for (const [id, list] of Object.entries(content.cookies ?? {})) {
    if (ids.has(id) && Array.isArray(list)) cookies[id] = list.filter(isStoredCookie);
  }
  return { sessions, cookies };
}

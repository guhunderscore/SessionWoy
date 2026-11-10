/**
 * SessionWoy local backend (Phase 4d, FR-18/FR-21, ADR 0004).
 *
 * Stores what the extension already encrypted (AES-256-GCM, key derived from the user's passphrase in
 * the extension): it never sees a plaintext cookie, passphrase or key. Protection (PRD §13):
 *  - loopback only (Docker publishes 127.0.0.1:3004; `Host` must be an allowed loopback host),
 *  - per-installation bearer secret (constant-time compare),
 *  - requests carrying a website `Origin` are refused (only `chrome-extension://` may call it),
 *  - every body validated with Zod, small body limit, no secrets in logs.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Db } from './db.js';

export const VERSION = '0.1.0';

export interface AppOptions {
  db: Db;
  /** Bearer secret shared with the extension (`API_SECRET`). */
  secret: string;
  /** Allowed `Host` header values, e.g. `127.0.0.1:3004`. */
  allowedHosts: string[];
  /** If set, only these exact `Origin`s may call /v1 (e.g. `chrome-extension://<id>`). */
  allowedOrigins?: string[];
  logger?: boolean;
}

const b64 = z.string().min(1).max(8_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const sealed = z.object({ iv: b64.max(32), ct: b64 });
const kdf = z.object({ alg: z.literal('PBKDF2-SHA-256'), iterations: z.number().int().min(100_000).max(10_000_000), salt: b64.max(64) });
const sessionId = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);

export const headerBody = z.object({ kdf, check: sealed, keyVersion: z.number().int().min(1) }).strict();
export const sessionBody = sealed.extend({ keyVersion: z.number().int().min(1), updatedAt: z.number().int().min(0) }).strict();
export const metaBody = z
  .object({
    sessions: z
      .array(
        z.object({
          id: sessionId,
          name: z.string().min(1).max(40),
          color: z.enum(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']),
          status: z.enum(['active', 'archived']),
          createdAt: z.number().int(),
          updatedAt: z.number().int(),
        }),
      )
      .max(1000),
  })
  .strict();

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

/** Constant-time comparison (hashing first makes lengths equal). */
function secretMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

export function buildApp(opts: AppOptions): FastifyInstance {
  if (opts.secret.length < 32) throw new Error('API_SECRET must be at least 32 characters');
  const { db } = opts;
  const hosts = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  const origins = opts.allowedOrigins?.length ? new Set(opts.allowedOrigins) : null;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024 });

  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!hosts.has(host)) return reply.code(421).send({ error: 'Host not allowed' });
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const ok = origins ? origins.has(origin) : origin.startsWith('chrome-extension://');
      if (!ok) return reply.code(403).send({ error: 'Origin not allowed' });
    }
    if (req.url === '/health') return;
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !secretMatches(token, opts.secret)) return reply.code(401).send({ error: 'Unauthorized' });
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode ?? 500;
    // Never echo internals (or anything from the body) on server errors.
    reply.code(status).send({ error: status >= 500 ? 'Internal error' : err.message });
  });

  const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body);
    if (!r.success) throw Object.assign(new Error('Invalid request body'), { statusCode: 400 });
    return r.data;
  };

  const currentKeyVersion = () =>
    (db.prepare('SELECT key_version FROM vault_header WHERE id = 1').get() as { key_version: number } | undefined)?.key_version ?? null;

  app.get('/health', async () => ({ ok: true, version: VERSION, hasVault: currentKeyVersion() !== null }));

  app.get('/v1/vault', async () => {
    const h = db.prepare('SELECT * FROM vault_header WHERE id = 1').get() as
      | { kdf_json: string; check_iv: string; check_ct: string; key_version: number; updated_at: number }
      | undefined;
    const rows = db.prepare('SELECT session_id, payload_ciphertext, nonce, key_version, updated_at FROM session_vault').all() as {
      session_id: string;
      payload_ciphertext: string;
      nonce: string;
      key_version: number;
      updated_at: number;
    }[];
    const meta = db.prepare('SELECT * FROM sessions ORDER BY created_at').all() as {
      id: string;
      name: string;
      color: string;
      status: string;
      created_at: number;
      updated_at: number;
    }[];
    return {
      header: h
        ? { kdf: JSON.parse(h.kdf_json), check: { iv: h.check_iv, ct: h.check_ct }, keyVersion: h.key_version, updatedAt: h.updated_at }
        : null,
      sessions: Object.fromEntries(
        rows.map((r) => [r.session_id, { iv: r.nonce, ct: r.payload_ciphertext, keyVersion: r.key_version, updatedAt: r.updated_at }]),
      ),
      meta: meta.map((m) => ({ id: m.id, name: m.name, color: m.color, status: m.status, createdAt: m.created_at, updatedAt: m.updated_at })),
    };
  });

  app.put('/v1/vault/header', async (req) => {
    const body = parse(headerBody, req.body);
    db.transaction(() => {
      db.prepare(
        `INSERT INTO vault_header (id, kdf_json, check_iv, check_ct, key_version, updated_at) VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kdf_json = excluded.kdf_json, check_iv = excluded.check_iv,
           check_ct = excluded.check_ct, key_version = excluded.key_version, updated_at = excluded.updated_at`,
      ).run(JSON.stringify(body.kdf), body.check.iv, body.check.ct, body.keyVersion, Date.now());
      // Payloads under an older key can no longer be decrypted with the new passphrase.
      db.prepare('DELETE FROM session_vault WHERE key_version <> ?').run(body.keyVersion);
    })();
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>('/v1/vault/sessions/:id', async (req, reply) => {
    const id = parse(sessionId, req.params.id);
    const body = parse(sessionBody, req.body);
    const kv = currentKeyVersion();
    if (kv === null) return reply.code(409).send({ error: 'Send the vault header first' });
    if (body.keyVersion !== kv) return reply.code(409).send({ error: 'Key version mismatch' });
    db.prepare(
      `INSERT INTO session_vault (session_id, origin, payload_ciphertext, nonce, key_version, updated_at) VALUES (?, '*', ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET payload_ciphertext = excluded.payload_ciphertext, nonce = excluded.nonce,
         key_version = excluded.key_version, updated_at = excluded.updated_at`,
    ).run(id, body.ct, body.iv, body.keyVersion, body.updatedAt);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/v1/vault/sessions/:id', async (req) => {
    const id = parse(sessionId, req.params.id);
    db.prepare('DELETE FROM session_vault WHERE session_id = ?').run(id);
    return { ok: true };
  });

  /** Forget everything (the user chose "Forget saved logins"). */
  app.delete('/v1/vault', async () => {
    db.transaction(() => {
      db.prepare('DELETE FROM session_vault').run();
      db.prepare('DELETE FROM vault_header').run();
    })();
    return { ok: true };
  });

  app.put('/v1/sessions', async (req) => {
    const body = parse(metaBody, req.body);
    db.transaction(() => {
      db.prepare('DELETE FROM sessions').run();
      const ins = db.prepare('INSERT INTO sessions (id, name, color, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const s of body.sessions) ins.run(s.id, s.name, s.color, s.status, s.createdAt, s.updatedAt);
    })();
    return { ok: true };
  });

  return app;
}

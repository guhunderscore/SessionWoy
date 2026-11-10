import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

/**
 * Deterministic test server for the SessionWoy POC.
 *
 * Every endpoint reports the identity carried by the `sid` cookie it received,
 * so any cross-session leak is directly visible to a test.
 */

export const SESSION_COOKIE = 'sid';
const USER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COOKIE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COOKIE_VALUE_RE = /^[A-Za-z0-9_.:-]{0,256}$/;

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && !(name in out)) out[name] = value;
  }
  return out;
}

function cookiesOf(req: FastifyRequest): Record<string, string> {
  return parseCookieHeader(req.headers.cookie);
}

function identityOf(req: FastifyRequest): string {
  return cookiesOf(req)[SESSION_COOKIE] ?? 'anonymous';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>SessionWoy test server</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:24px;max-width:760px}code,pre{background:#f3f3f3;padding:2px 4px}</style>
</head>
<body>
<h1>SessionWoy test server</h1>
<p>Identity (from <code>/whoami</code>): <strong id="identity">…</strong></p>
<ul>
  <li><a href="/login?user=customer">Login as customer</a> ·
      <a href="/login?user=provider">Login as provider</a> ·
      <a href="/login?user=admin">Login as admin</a> ·
      <a href="/logout">Logout</a></li>
  <li><a href="/whoami">/whoami</a> · <a href="/redirect?hops=3">/redirect?hops=3</a></li>
  <li><a id="new-tab-link" href="/whoami" target="_blank">Open /whoami in a new tab</a></li>
  <li><a href="/set-cookie?name=pref&value=dark">Set response cookie pref=dark</a></li>
</ul>
<p><button id="js-cookie">document.cookie = "jsval=fromjs"</button></p>
<pre id="cookie-view"></pre>
<script>
async function refresh() {
  const r = await fetch('/whoami', { cache: 'no-store' });
  const j = await r.json();
  document.getElementById('identity').textContent = j.identity;
  document.getElementById('cookie-view').textContent =
    'server saw: ' + JSON.stringify(j.cookies) + '\\ndocument.cookie: ' + document.cookie;
}
document.getElementById('js-cookie').onclick = () => { document.cookie = 'jsval=fromjs; path=/'; refresh(); };
refresh();
</script>
</body>
</html>`;

export function buildApp(opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(INDEX_HTML));

  app.get('/health', async () => ({ ok: true }));

  app.get<{ Querystring: { user?: string; next?: string } }>('/login', async (req, reply) => {
    const user = req.query.user ?? '';
    if (!USER_RE.test(user)) return reply.code(400).send({ error: 'invalid user' });
    reply.header(
      'Set-Cookie',
      `${SESSION_COOKIE}=${user}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
    );
    const next = req.query.next === 'none' ? null : '/whoami';
    if (!next) return { loggedIn: user };
    return reply.redirect(next, 302);
  });

  app.get('/logout', async (_req, reply) => {
    reply.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { loggedOut: true };
  });

  app.get<{ Querystring: { trail?: string } }>('/whoami', async (req) => {
    const identity = identityOf(req);
    const trail = req.query.trail ? req.query.trail.split(',') : undefined;
    return { identity, cookies: cookiesOf(req), ...(trail ? { trail: [...trail, identity] } : {}) };
  });

  app.get<{
    Querystring: { name?: string; value?: string; maxAge?: string; path?: string; httpOnly?: string };
  }>('/set-cookie', async (req, reply) => {
    const { name = '', value = '', maxAge, path = '/', httpOnly } = req.query;
    if (!COOKIE_NAME_RE.test(name) || !COOKIE_VALUE_RE.test(value) || !path.startsWith('/')) {
      return reply.code(400).send({ error: 'invalid cookie' });
    }
    const attrs = [`${name}=${value}`, `Path=${path}`, 'SameSite=Lax'];
    if (maxAge !== undefined && /^-?\d+$/.test(maxAge)) attrs.push(`Max-Age=${maxAge}`);
    if (httpOnly === '1') attrs.push('HttpOnly');
    reply.header('Set-Cookie', attrs.join('; '));
    return { set: { name, value, path, maxAge: maxAge ?? null }, identity: identityOf(req) };
  });

  // Each hop appends the identity it observed to `trail`, so a test can check every hop.
  app.get<{ Querystring: { hops?: string; trail?: string } }>('/redirect', async (req, reply) => {
    const hops = Math.min(Math.max(Number.parseInt(req.query.hops ?? '3', 10) || 0, 0), 20);
    const trail = [...(req.query.trail ? req.query.trail.split(',') : []), identityOf(req)];
    const t = encodeURIComponent(trail.join(','));
    const next = hops > 1 ? `/redirect?hops=${hops - 1}&trail=${t}` : `/whoami?trail=${t}`;
    return reply.redirect(next, 302);
  });

  app.get<{ Querystring: { delay?: string; id?: string } }>('/parallel', async (req) => {
    const delay = Math.min(Math.max(Number.parseInt(req.query.delay ?? '0', 10) || 0, 0), 5000);
    const before = identityOf(req);
    if (delay) await sleep(delay);
    return { id: req.query.id ?? null, identity: before };
  });

  return app;
}

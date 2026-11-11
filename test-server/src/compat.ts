/**
 * Phase 5 compatibility pages (ADR 0005). Deterministic stand-ins for things real sites do:
 *   /sw/          page whose Service Worker proxies fetches (requests then have no tab id)
 *   /frame        page on localhost:3003 framing the other site 127.0.0.1:3003 (cross-site iframe)
 *   /oauth/*      popup "OAuth" flow between the two sites (provider = 127.0.0.1:3003)
 *   /download     attachment whose body is the identity the request carried
 * localhost:3003 and 127.0.0.1:3003 are different *sites*, so they behave like an app and a provider.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE, parseCookieHeader } from './app.js';

const PROVIDER_COOKIE = 'psid';
const USER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const APP_ORIGIN = 'http://localhost:3003';
const PROVIDER_ORIGIN = 'http://127.0.0.1:3003';

const identity = (req: FastifyRequest, name = SESSION_COOKIE) =>
  parseCookieHeader(req.headers.cookie)[name] ?? 'anonymous';
const html = (reply: FastifyReply, body: string) =>
  reply.type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8">${body}`);

const SW_JS = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
// Pass-through: every request in scope is re-issued by the worker itself (no tab id for the extension).
self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));
`;

export function compatRoutes(app: FastifyInstance): void {
  // --- Service Worker (scope /sw/)
  app.get('/sw/', async (_req, reply) =>
    html(
      reply,
      `<title>SW page</title><h1>Service Worker page</h1><p id="state">…</p>
<script>
window.swReady = (async () => {
  try {
    await navigator.serviceWorker.register('/sw/sw.js', { scope: '/sw/' });
    await navigator.serviceWorker.ready;
    document.getElementById('state').textContent = navigator.serviceWorker.controller ? 'controlled' : 'registered';
    return 'registered';
  } catch (e) {
    document.getElementById('state').textContent = 'blocked: ' + e.message;
    return 'blocked: ' + e.message;
  }
})();
</script>`,
    ),
  );
  app.get('/sw/sw.js', async (_req, reply) =>
    reply.type('text/javascript').header('Service-Worker-Allowed', '/sw/').send(SW_JS),
  );
  app.get('/sw/whoami', async (req) => ({ identity: identity(req), via: 'sw-scope' }));

  // --- Cross-site iframe: app page frames the provider site.
  app.get('/frame', async (_req, reply) =>
    html(
      reply,
      `<title>Frame host</title><h1>Frame host</h1><iframe id="f" src="${PROVIDER_ORIGIN}/frame/inner" width="400" height="120"></iframe>`,
    ),
  );
  app.get('/frame/inner', async (req, reply) =>
    html(reply, `<title>Inner</title><p id="who">${identity(req)}</p>`),
  );
  // Third-party login cookie: SameSite=None; Secure (allowed over http on 127.0.0.1, a trustworthy origin).
  app.get<{ Querystring: { user?: string } }>('/frame/login', async (req, reply) => {
    const user = req.query.user ?? '';
    if (!USER_RE.test(user)) return reply.code(400).send({ error: 'invalid user' });
    reply.header(
      'Set-Cookie',
      `${SESSION_COOKIE}=${user}; Path=/; HttpOnly; SameSite=None; Secure`,
    );
    return reply.redirect('/frame/inner', 302);
  });

  // --- OAuth-style popup flow
  app.get('/oauth/start', async (_req, reply) =>
    html(
      reply,
      `<title>OAuth start</title><h1>App</h1><p id="result">not logged in</p>
<script>
window.addEventListener('message', (e) => {
  if (e.origin === location.origin && e.data && e.data.login) document.getElementById('result').textContent = 'logged in as ' + e.data.login;
});
window.startLogin = (user) =>
  window.open('${PROVIDER_ORIGIN}/oauth/authorize?user=' + encodeURIComponent(user) +
    '&redirect=' + encodeURIComponent('${APP_ORIGIN}/oauth/callback'), 'oauth', 'width=420,height=360');
</script>`,
    ),
  );
  app.get<{ Querystring: { user?: string; redirect?: string } }>(
    '/oauth/authorize',
    async (req, reply) => {
      const user = req.query.user ?? '';
      if (!USER_RE.test(user) || req.query.redirect !== `${APP_ORIGIN}/oauth/callback`)
        return reply.code(400).send({ error: 'bad request' });
      // The provider remembers who logged in (its own cookie on its own site), then sends a code back.
      reply.header('Set-Cookie', `${PROVIDER_COOKIE}=${user}; Path=/; HttpOnly; SameSite=Lax`);
      return reply.redirect(`${req.query.redirect}?code=${encodeURIComponent(user)}`, 302);
    },
  );
  app.get<{ Querystring: { code?: string } }>('/oauth/callback', async (req, reply) => {
    const code = req.query.code ?? '';
    if (!USER_RE.test(code)) return reply.code(400).send({ error: 'bad code' });
    reply.header('Set-Cookie', `${SESSION_COOKIE}=${code}; Path=/; HttpOnly; SameSite=Lax`);
    return html(
      reply,
      `<title>OAuth callback</title><p>done</p><script>
if (window.opener) { window.opener.postMessage({ login: ${JSON.stringify(code)} }, '${APP_ORIGIN}'); window.close(); }
</script>`,
    );
  });
  app.get('/oauth/provider-whoami', async (req) => ({ provider: identity(req, PROVIDER_COOKIE) }));

  // --- Download: attachment body = identity carried by the request
  app.get('/download', async (req, reply) =>
    reply
      .header('Content-Disposition', 'attachment; filename="identity.txt"')
      .type('text/plain')
      .send(identity(req)),
  );
}

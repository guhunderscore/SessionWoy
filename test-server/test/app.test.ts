import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, parseCookieHeader } from '../src/app.js';

const app = buildApp();
afterAll(() => app.close());

describe('parseCookieHeader', () => {
  it('parses multiple cookies and keeps the first duplicate', () => {
    expect(parseCookieHeader('a=1; b=2; a=3')).toEqual({ a: '1', b: '2' });
    expect(parseCookieHeader(undefined)).toEqual({});
  });
});

describe('test server', () => {
  it('/login sets an HttpOnly sid cookie and redirects to /whoami', async () => {
    const res = await app.inject({ url: '/login?user=customer' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/whoami');
    expect(String(res.headers['set-cookie'])).toMatch(/^sid=customer; Path=\/; HttpOnly/);
  });

  it('/login rejects invalid users', async () => {
    const res = await app.inject({ url: '/login?user=' + encodeURIComponent('a;b') });
    expect(res.statusCode).toBe(400);
  });

  it('/whoami reports the identity of the received cookie', async () => {
    const anon = await app.inject({ url: '/whoami' });
    expect(anon.json().identity).toBe('anonymous');
    const res = await app.inject({ url: '/whoami', headers: { cookie: 'sid=provider; x=1' } });
    expect(res.json()).toEqual({ identity: 'provider', cookies: { sid: 'provider', x: '1' } });
  });

  it('/set-cookie sets the requested cookie', async () => {
    const res = await app.inject({ url: '/set-cookie?name=pref&value=dark&maxAge=60' });
    expect(res.headers['set-cookie']).toBe('pref=dark; Path=/; SameSite=Lax; Max-Age=60');
  });

  it('/redirect records the identity at each hop', async () => {
    const headers = { cookie: 'sid=admin' };
    let res = await app.inject({ url: '/redirect?hops=2', headers });
    expect(res.statusCode).toBe(302);
    res = await app.inject({ url: res.headers.location as string, headers });
    expect(res.statusCode).toBe(302);
    res = await app.inject({ url: res.headers.location as string, headers });
    expect(res.json().trail).toEqual(['admin', 'admin', 'admin']);
  });

  it('/parallel echoes id and identity after the delay', async () => {
    const res = await app.inject({ url: '/parallel?delay=5&id=7', headers: { cookie: 'sid=x' } });
    expect(res.json()).toEqual({ id: '7', identity: 'x' });
  });

  it('/logout expires sid', async () => {
    const res = await app.inject({ url: '/logout' });
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
  });

  it('serves a same-origin SVG favicon referenced by the index page', async () => {
    const icon = await app.inject({ url: '/favicon.svg' });
    expect(icon.headers['content-type']).toContain('image/svg+xml');
    expect(icon.body).toContain('<svg');
    expect((await app.inject({ url: '/' })).body).toContain('href="/favicon.svg"');
  });
});

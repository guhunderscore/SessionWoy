import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const app = buildApp();
afterAll(() => app.close());

describe('compatibility pages', () => {
  it('serves a scoped pass-through Service Worker', async () => {
    const sw = await app.inject({ url: '/sw/sw.js' });
    expect(sw.headers['content-type']).toContain('javascript');
    expect(sw.body).toContain('respondWith(fetch(e.request))');
    expect((await app.inject({ url: '/sw/' })).body).toContain("register('/sw/sw.js'");
    expect((await app.inject({ url: '/sw/whoami', headers: { cookie: 'sid=a' } })).json()).toEqual({
      identity: 'a',
      via: 'sw-scope',
    });
  });

  it('frames the other site and sets a SameSite=None login there', async () => {
    expect((await app.inject({ url: '/frame' })).body).toContain(
      'http://127.0.0.1:3003/frame/inner',
    );
    const login = await app.inject({ url: '/frame/login?user=fu' });
    expect(String(login.headers['set-cookie'])).toContain('SameSite=None; Secure');
    expect(
      (await app.inject({ url: '/frame/inner', headers: { cookie: 'sid=fu' } })).body,
    ).toContain('>fu<');
  });

  it('runs an OAuth-style popup flow between the two sites', async () => {
    const auth = await app.inject({
      url:
        '/oauth/authorize?user=ou&redirect=' +
        encodeURIComponent('http://localhost:3003/oauth/callback'),
    });
    expect(auth.statusCode).toBe(302);
    expect(auth.headers.location).toBe('http://localhost:3003/oauth/callback?code=ou');
    expect(String(auth.headers['set-cookie'])).toContain('psid=ou');
    expect(
      (await app.inject({ url: '/oauth/authorize?user=ou&redirect=https://evil.example' }))
        .statusCode,
    ).toBe(400);
    const cb = await app.inject({ url: '/oauth/callback?code=ou' });
    expect(String(cb.headers['set-cookie'])).toContain('sid=ou');
    expect(cb.body).toContain('postMessage');
  });

  it('download body is the identity the request carried', async () => {
    const res = await app.inject({ url: '/download', headers: { cookie: 'sid=dl' } });
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body).toBe('dl');
  });
});

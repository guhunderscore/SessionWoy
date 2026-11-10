import { describe, expect, it } from 'vitest';
import { CookieJar, defaultPath, domainMatch, parseSetCookie, pathMatch } from '../src/shared/cookieJar.js';

const NOW = 1_700_000_000_000;
const u = (s: string) => new URL(s);

describe('matching helpers', () => {
  it('domainMatch', () => {
    expect(domainMatch('a.example.com', 'example.com')).toBe(true);
    expect(domainMatch('example.com', 'example.com')).toBe(true);
    expect(domainMatch('badexample.com', 'example.com')).toBe(false);
    expect(domainMatch('1.2.3.4', '2.3.4')).toBe(false);
  });
  it('pathMatch', () => {
    expect(pathMatch('/a', '/a')).toBe(true);
    expect(pathMatch('/a/b', '/a')).toBe(true);
    expect(pathMatch('/ab', '/a')).toBe(false);
    expect(pathMatch('/a/b', '/a/')).toBe(true);
    expect(pathMatch('/anything', '/')).toBe(true);
  });
  it('defaultPath', () => {
    expect(defaultPath('/')).toBe('/');
    expect(defaultPath('/a')).toBe('/');
    expect(defaultPath('/a/b/c')).toBe('/a/b');
  });
});

describe('parseSetCookie', () => {
  it('parses attributes', () => {
    const r = parseSetCookie('sid=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=60', u('http://localhost:3003/login'), NOW);
    expect(r.ok && r.cookie).toMatchObject({
      name: 'sid',
      value: 'abc',
      domain: 'localhost',
      hostOnly: true,
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      expires: NOW + 60_000,
    });
  });
  it('defaults SameSite to lax and path to default-path', () => {
    const r = parseSetCookie('a=1', u('https://x.example.com/p/q'), NOW);
    expect(r.ok && r.cookie).toMatchObject({ sameSite: 'lax', path: '/p', hostOnly: true });
  });
  it('accepts Domain for a parent domain and rejects foreign domains', () => {
    const ok = parseSetCookie('a=1; Domain=.example.com', u('https://x.example.com/'), NOW);
    expect(ok.ok && ok.cookie).toMatchObject({ domain: 'example.com', hostOnly: false });
    expect(parseSetCookie('a=1; Domain=other.com', u('https://x.example.com/'), NOW).ok).toBe(false);
    expect(parseSetCookie('a=1; Domain=com', u('https://x.example.com/'), NOW).ok).toBe(false);
  });
  it('enforces Secure, SameSite=None and prefixes', () => {
    expect(parseSetCookie('a=1; Secure', u('http://example.com/'), NOW).ok).toBe(false);
    expect(parseSetCookie('a=1; Secure', u('http://localhost/'), NOW).ok).toBe(true);
    expect(parseSetCookie('a=1; SameSite=None', u('https://example.com/'), NOW).ok).toBe(false);
    expect(parseSetCookie('__Host-a=1; Secure; Path=/', u('https://example.com/'), NOW).ok).toBe(true);
    expect(parseSetCookie('__Host-a=1; Secure; Path=/; Domain=example.com', u('https://example.com/'), NOW).ok).toBe(false);
  });
  it('rejects HttpOnly from script', () => {
    expect(parseSetCookie('a=1; HttpOnly', u('http://localhost/'), NOW, { fromScript: true }).ok).toBe(false);
  });
});

describe('CookieJar', () => {
  it('builds a Cookie header with RFC ordering and path rules', () => {
    const jar = new CookieJar();
    const url = u('http://localhost:3003/');
    jar.setFromHeader('a=1; Path=/', url, NOW);
    jar.setFromHeader('b=2; Path=/deep', url, NOW + 1);
    expect(jar.cookieHeaderFor(u('http://localhost:3003/deep/x'), NOW)).toBe('b=2; a=1');
    expect(jar.cookieHeaderFor(u('http://localhost:3003/other'), NOW)).toBe('a=1');
  });
  it('replaces and deletes by name/domain/path', () => {
    const jar = new CookieJar();
    const url = u('http://localhost:3003/');
    jar.setFromHeader('sid=one; Path=/', url, NOW);
    expect(jar.setFromHeader('sid=two; Path=/', url, NOW).changed).toBe(true);
    expect(jar.cookieHeaderFor(url, NOW)).toBe('sid=two');
    jar.setFromHeader('sid=; Path=/; Max-Age=0', url, NOW);
    expect(jar.size).toBe(0);
  });
  it('script cannot overwrite an HttpOnly cookie', () => {
    const jar = new CookieJar();
    const url = u('http://localhost/');
    jar.setFromHeader('sid=srv; Path=/; HttpOnly', url, NOW);
    jar.setFromHeader('sid=js; Path=/', url, NOW, { fromScript: true });
    expect(jar.cookieHeaderFor(url, NOW)).toBe('sid=srv');
    expect(jar.documentCookieFor(url, NOW)).toBe('');
  });
  it('honours expiry', () => {
    const jar = new CookieJar();
    const url = u('http://localhost/');
    jar.setFromHeader('t=1; Max-Age=2', url, NOW);
    expect(jar.cookieHeaderFor(url, NOW + 1000)).toBe('t=1');
    expect(jar.cookieHeaderFor(url, NOW + 2000)).toBe('');
    expect(jar.nextExpiry(NOW)).toBe(NOW + 2000);
    expect(jar.purgeExpired(NOW + 2000)).toBe(true);
  });
  it('host-only vs domain cookies', () => {
    const jar = new CookieJar();
    jar.setFromHeader('h=1', u('https://example.com/'), NOW);
    jar.setFromHeader('d=1; Domain=example.com', u('https://example.com/'), NOW);
    expect(jar.cookieHeaderFor(u('https://sub.example.com/'), NOW)).toBe('d=1');
    expect(jar.cookieHeaderFor(u('https://example.com/'), NOW)).toBe('h=1; d=1');
  });
  it('cross-site context only carries SameSite=None', () => {
    const jar = new CookieJar();
    const url = u('https://example.com/');
    jar.setFromHeader('lax=1', url, NOW);
    jar.setFromHeader('none=1; SameSite=None; Secure', url, NOW);
    expect(jar.cookieHeaderFor(url, NOW, 'cross-site')).toBe('none=1');
  });
});

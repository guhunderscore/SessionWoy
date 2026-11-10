import { describe, expect, it } from 'vitest';
import { CookieJar } from '../src/shared/cookieJar.js';
import {
  COLOR_HEX,
  DEFAULT_SETTINGS,
  SESSION_COLORS,
  badgeText,
  isGroupingMode,
  isSessionColor,
  nextColor,
  normalizeMeta,
  normalizeSettings,
  summarizeCookies,
  validateName,
} from '../src/shared/sessions.js';

const NOW = 1_700_000_000_000;

describe('session helpers', () => {
  it('palette matches the Chrome tab-group colors and has a hex for each', () => {
    expect([...SESSION_COLORS].sort()).toEqual(['blue', 'cyan', 'green', 'grey', 'orange', 'pink', 'purple', 'red', 'yellow']);
    for (const c of SESSION_COLORS) expect(COLOR_HEX[c]).toMatch(/^#[0-9a-f]{6}$/);
    expect(isSessionColor('blue')).toBe(true);
    expect(isSessionColor('#123456')).toBe(false);
  });

  it('validates names', () => {
    expect(validateName('  Customer   QA ')).toEqual({ ok: true, name: 'Customer QA' });
    expect(validateName('   ').ok).toBe(false);
    expect(validateName(undefined).ok).toBe(false);
    expect(validateName('x'.repeat(41)).ok).toBe(false);
    expect(validateName('x'.repeat(40)).ok).toBe(true);
  });

  it('picks the first unused color among active sessions', () => {
    expect(nextColor([])).toBe('blue');
    expect(nextColor([{ color: 'blue', status: 'active' }])).toBe('red');
    expect(nextColor([{ color: 'blue', status: 'archived' }])).toBe('blue');
  });

  it('badge text is at most 4 characters', () => {
    expect(badgeText('Customer')).toBe('Cust');
    expect(badgeText(' QA ')).toBe('QA');
  });

  it('normalizes stored metadata', () => {
    expect(normalizeMeta({ id: 'x', name: ' A ', color: 'nope', status: 'weird' })).toMatchObject({
      id: 'x',
      name: 'A',
      color: 'grey',
      status: 'active',
    });
    expect(normalizeMeta({ id: '', name: 'A' })).toBeNull();
    expect(normalizeMeta(null)).toBeNull();
  });

  it('settings default to per-tab mode and ignore the legacy useTabGroups flag', () => {
    expect(DEFAULT_SETTINGS).toEqual({ inheritOnOpen: true, grouping: 'tab' });
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ useTabGroups: true })).toEqual({ inheritOnOpen: true, grouping: 'tab' });
    expect(normalizeSettings({ grouping: 'group', inheritOnOpen: false })).toEqual({ inheritOnOpen: false, grouping: 'group' });
    expect(normalizeSettings({ grouping: 'window' }).grouping).toBe('tab');
    expect(isGroupingMode('group')).toBe(true);
    expect(isGroupingMode('groups')).toBe(false);
  });

  it('summarizes cookies by domain without values and skips expired ones', () => {
    const jar = new CookieJar();
    jar.setFromHeader('sid=SECRET; Path=/; HttpOnly', new URL('http://localhost:3000/'), NOW);
    jar.setFromHeader('d=1; Domain=example.com; Secure', new URL('https://www.example.com/'), NOW);
    jar.setFromHeader('old=1; Max-Age=1', new URL('http://localhost:3000/'), NOW);
    const summary = summarizeCookies(jar.all(), NOW + 5000);
    expect(summary.map((s) => s.domain)).toEqual(['.example.com', 'localhost']);
    expect(summary[1]!.cookies).toEqual([
      { name: 'sid', path: '/', httpOnly: true, secure: false, sameSite: 'lax', expires: null },
    ]);
    expect(JSON.stringify(summary)).not.toContain('SECRET');
  });
});

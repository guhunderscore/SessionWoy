import { describe, expect, it } from 'vitest';
import { CookieJar } from '../src/shared/cookieJar.js';
import { buildSessionRules, pathRegex, type RuleSpec } from '../src/shared/rules.js';

const NOW = 1_700_000_000_000;

/** Emulates DNR: among matching rules, the highest priority `cookie` modification wins. */
function effectiveCookie(rules: RuleSpec[], tabId: number, url: string, thirdParty = false, resourceType = 'xmlhttprequest'): string | null {
  const matching = rules.filter((r) => {
    if (!r.condition.tabIds.includes(tabId)) return false;
    if (r.condition.regexFilter && !new RegExp(r.condition.regexFilter).test(url)) return false;
    if (r.condition.domainType === 'thirdParty' && !thirdParty) return false;
    if (r.condition.domainType === 'firstParty' && thirdParty) return false;
    if (r.condition.excludedResourceTypes?.includes(resourceType as never)) return false;
    // Real DNR default: no resourceTypes/excludedResourceTypes => everything except main_frame.
    if (r.condition.resourceTypes) return r.condition.resourceTypes.includes(resourceType as never);
    if (!r.condition.excludedResourceTypes && resourceType === 'main_frame') return false;
    return true;
  });
  if (matching.length === 0) return 'UNMODIFIED';
  const top = matching.sort((a, b) => b.priority - a.priority)[0]!;
  const op = top.action.requestHeaders?.find((h) => h.header === 'cookie');
  return op?.operation === 'set' ? op.value! : null;
}

describe('pathRegex', () => {
  it('builds prefix-safe path patterns', () => {
    expect(new RegExp('^' + pathRegex('/a')).test('/a')).toBe(true);
    expect(new RegExp('^' + pathRegex('/a')).test('/a/b')).toBe(true);
    expect(new RegExp('^' + pathRegex('/a')).test('/a?x')).toBe(true);
    expect(new RegExp('^' + pathRegex('/a')).test('/ab')).toBe(false);
  });
});

describe('buildSessionRules', () => {
  it('returns nothing for a session without tabs', () => {
    expect(buildSessionRules([], [], NOW)).toEqual([]);
  });

  it('always installs a catch-all that strips shared-jar cookies', () => {
    const rules = buildSessionRules([], [7], NOW);
    expect(rules).toHaveLength(1);
    expect(effectiveCookie(rules, 7, 'https://anything.test/')).toBeNull();
    expect(effectiveCookie(rules, 7, 'https://anything.test/', false, 'main_frame')).toBeNull();
    expect(effectiveCookie(rules, 8, 'https://anything.test/')).toBe('UNMODIFIED');
  });

  it('selects the right cookie set per host, path, and party', () => {
    const jar = new CookieJar();
    const base = new URL('http://localhost:3003/');
    jar.setFromHeader('sid=customer; Path=/; HttpOnly', base, NOW);
    jar.setFromHeader('deep=1; Path=/api', base, NOW + 1);
    const ex = new URL('https://example.com/');
    jar.setFromHeader('h=1', ex, NOW);
    jar.setFromHeader('d=1; Domain=example.com', ex, NOW);
    jar.setFromHeader('n=1; SameSite=None; Secure', ex, NOW);

    const rules = buildSessionRules(jar.all(), [1, 2], NOW);
    for (const r of rules) expect(() => new RegExp(r.condition.regexFilter ?? '')).not.toThrow();

    expect(effectiveCookie(rules, 1, 'http://localhost:3003/whoami')).toBe('sid=customer');
    expect(effectiveCookie(rules, 1, 'http://localhost:3003/whoami', false, 'main_frame')).toBe('sid=customer');
    expect(effectiveCookie(rules, 2, 'http://localhost:3003/api/x')).toBe('deep=1; sid=customer');
    expect(effectiveCookie(rules, 1, 'http://localhost:3003/apix')).toBe('sid=customer');
    expect(effectiveCookie(rules, 1, 'https://example.com/')).toBe('h=1; d=1; n=1');
    expect(effectiveCookie(rules, 1, 'https://sub.example.com/')).toBe('d=1');
    expect(effectiveCookie(rules, 1, 'http://example.com/')).toBe('h=1; d=1');
    expect(effectiveCookie(rules, 1, 'https://example.com/', true)).toBe('n=1');
    expect(effectiveCookie(rules, 1, 'https://example.com/', true, 'main_frame')).toBe('h=1; d=1; n=1');
    expect(effectiveCookie(rules, 1, 'https://notexample.com/')).toBeNull();
    expect(effectiveCookie(rules, 3, 'http://localhost:3003/whoami')).toBe('UNMODIFIED');
  });

  it('drops expired cookies', () => {
    const jar = new CookieJar();
    jar.setFromHeader('t=1; Max-Age=1', new URL('http://localhost/'), NOW);
    const rules = buildSessionRules(jar.all(), [1], NOW + 5000);
    expect(effectiveCookie(rules, 1, 'http://localhost/')).toBeNull();
  });
});

/**
 * Pure translation of a session's cookie jar into declarativeNetRequest
 * session rules scoped to that session's tabs.
 *
 * Rule layout for one session (all rules carry `tabIds: <session tabs>`):
 *
 *  - priority 1 catch-all: remove `Cookie` from every request and `Set-Cookie`
 *    from every response, so the shared Chrome jar is neither read nor written.
 *  - per (host pattern, cookie path, scheme): `set Cookie: <session cookies>`
 *    using a regexFilter. More specific host / longer path => higher priority,
 *    so the highest-priority matching rule carries exactly the RFC 6265 cookie set.
 *  - optional third-party override (domainType thirdParty, non main_frame)
 *    that carries only SameSite=None cookies.
 *
 * DNR applies the highest-priority `set`/`remove` for a given header and
 * ignores lower-priority conflicting modifications of the same header.
 */
import { domainMatch, isExpired, isIpAddress, serialize, cookieApplies, type StoredCookie } from './cookieJar.js';

/**
 * Every chrome.declarativeNetRequest.ResourceType. Must be listed explicitly:
 * a rule without resourceTypes/excludedResourceTypes matches everything EXCEPT
 * main_frame, which would let navigations use (and write) the shared jar.
 */
export const ALL_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
] as const;
export type ResourceType = (typeof ALL_RESOURCE_TYPES)[number];

/** Minimal structural copy of chrome.declarativeNetRequest.Rule without `id`. */
export interface RuleSpec {
  priority: number;
  condition: {
    tabIds: number[];
    regexFilter?: string;
    domainType?: 'firstParty' | 'thirdParty';
    resourceTypes?: ResourceType[];
    excludedResourceTypes?: ResourceType[];
  };
  action: {
    type: 'modifyHeaders';
    requestHeaders?: { header: string; operation: 'set' | 'remove'; value?: string }[];
    responseHeaders?: { header: string; operation: 'remove' }[];
  };
}

const REMOVE_SET_COOKIE = [{ header: 'set-cookie', operation: 'remove' as const }];

/** Placeholder subdomain used to evaluate which cookies a subdomain would receive. */
export const SUBDOMAIN_PROBE = 'sessionwoy-sub-probe';

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export function pathRegex(path: string): string {
  if (path === '/' || path === '') return '/';
  const escaped = escapeRegex(path);
  return path.endsWith('/') ? escaped : `${escaped}(?:[/?#]|$)`;
}

export function priorityFor(hostLen: number, exact: boolean, pathLen: number, thirdParty: boolean): number {
  return 10 + hostLen * 10_000 + (exact ? 5_000 : 0) + Math.min(pathLen, 2_000) * 2 + (thirdParty ? 1 : 0);
}

function cookieAction(header: string): RuleSpec['action'] {
  return {
    type: 'modifyHeaders',
    requestHeaders: [
      header ? { header: 'cookie', operation: 'set', value: header } : { header: 'cookie', operation: 'remove' },
    ],
    responseHeaders: REMOVE_SET_COOKIE,
  };
}

function headerFor(cookies: StoredCookie[], scheme: 'http' | 'https', host: string, path: string, now: number, cross: boolean): string {
  const url = new URL(`${scheme}://${host}${path}`);
  return serialize(cookies.filter((c) => cookieApplies(c, url, now, { context: cross ? 'cross-site' : 'same-site' })));
}

function pathsFor(cookies: StoredCookie[], host: string): string[] {
  const paths = new Set<string>(['/']);
  for (const c of cookies) if (domainMatch(host, c.domain)) paths.add(c.path);
  return [...paths];
}

function emit(
  out: RuleSpec[],
  cookies: StoredCookie[],
  tabIds: number[],
  hostRegex: string,
  sampleHost: string,
  hostLen: number,
  exact: boolean,
  now: number,
): void {
  for (const path of pathsFor(cookies, sampleHost)) {
    const pr = pathRegex(path);
    const h = {
      http: headerFor(cookies, 'http', sampleHost, path, now, false),
      https: headerFor(cookies, 'https', sampleHost, path, now, false),
      httpX: headerFor(cookies, 'http', sampleHost, path, now, true),
      httpsX: headerFor(cookies, 'https', sampleHost, path, now, true),
    };
    const schemes: { re: string; first: string; third: string }[] =
      h.http === h.https && h.httpX === h.httpsX
        ? [{ re: 'https?', first: h.https, third: h.httpsX }]
        : [
            { re: 'http', first: h.http, third: h.httpX },
            { re: 'https', first: h.https, third: h.httpsX },
          ];
    for (const s of schemes) {
      const regexFilter = `^${s.re}://${hostRegex}(?::[0-9]+)?${pr}`;
      out.push({
        priority: priorityFor(hostLen, exact, path.length, false),
        condition: { tabIds, regexFilter, resourceTypes: [...ALL_RESOURCE_TYPES] },
        action: cookieAction(s.first),
      });
      if (s.third !== s.first) {
        out.push({
          priority: priorityFor(hostLen, exact, path.length, true),
          condition: { tabIds, regexFilter, domainType: 'thirdParty', excludedResourceTypes: ['main_frame'] },
          action: cookieAction(s.third),
        });
      }
    }
  }
}

export function buildSessionRules(cookies: StoredCookie[], tabIds: number[], now: number): RuleSpec[] {
  if (tabIds.length === 0) return [];
  const live = cookies.filter((c) => !isExpired(c, now));
  const tabs = [...tabIds].sort((a, b) => a - b);
  const out: RuleSpec[] = [
    {
      priority: 1,
      condition: { tabIds: tabs, resourceTypes: [...ALL_RESOURCE_TYPES] },
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'cookie', operation: 'remove' }],
        responseHeaders: REMOVE_SET_COOKIE,
      },
    },
  ];

  const domains = [...new Set(live.map((c) => c.domain))].sort();
  for (const d of domains) {
    const ed = escapeRegex(d);
    emit(out, live, tabs, ed, d, d.length, true, now);
    const hasDomainCookie = live.some((c) => !c.hostOnly && c.domain === d);
    if (hasDomainCookie && !isIpAddress(d)) {
      emit(out, live, tabs, `(?:[^/?#:@]+\\.)${ed}`, `${SUBDOMAIN_PROBE}.${d}`, d.length, false, now);
    }
  }
  return out;
}

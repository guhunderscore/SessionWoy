/**
 * Pure, dependency-free cookie jar implementing the parts of RFC 6265 / 6265bis
 * that SessionWoy needs: Set-Cookie parsing, domain/path matching, expiry,
 * Secure, HttpOnly, SameSite and cookie-header serialization.
 *
 * Used by the service worker (authoritative store) and bundled into the
 * MAIN-world content script (read-only snapshot for document.cookie).
 *
 * Known gaps (documented in ADR 0002): no Public Suffix List (only a
 * single-label heuristic), no nameless cookies, no cookie partitioning (CHIPS).
 */

export type SameSite = 'strict' | 'lax' | 'none';

export interface StoredCookie {
  name: string;
  value: string;
  /** Lower-case, no leading dot. */
  domain: string;
  /** True when the Set-Cookie had no Domain attribute (exact host only). */
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  /** Epoch ms; null = session cookie. */
  expires: number | null;
  created: number;
}

export type SameSiteContext = 'same-site' | 'cross-site';

export type ParseResult = { ok: true; cookie: StoredCookie } | { ok: false; reason: string };

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export function isIpAddress(host: string): boolean {
  return IPV4_RE.test(host) || host.startsWith('[') || host.includes(':');
}

/** Chrome treats localhost-ish hosts as potentially trustworthy, so Secure cookies work there over http. */
export function isSecureContextUrl(url: URL): boolean {
  if (url.protocol === 'https:' || url.protocol === 'wss:') return true;
  const h = url.hostname;
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]';
}

export function domainMatch(host: string, domain: string): boolean {
  if (host === domain) return true;
  return !isIpAddress(host) && host.endsWith('.' + domain);
}

export function defaultPath(urlPath: string): string {
  if (!urlPath.startsWith('/')) return '/';
  const idx = urlPath.lastIndexOf('/');
  return idx <= 0 ? '/' : urlPath.slice(0, idx);
}

export function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

export function isExpired(c: StoredCookie, now: number): boolean {
  return c.expires !== null && c.expires <= now;
}

export function parseSetCookie(
  header: string,
  requestUrl: URL,
  now: number,
  opts: { fromScript?: boolean } = {},
): ParseResult {
  const parts = header.split(';');
  const first = (parts.shift() ?? '').trim();
  const eq = first.indexOf('=');
  if (eq <= 0) return { ok: false, reason: 'missing name' };
  const name = first.slice(0, eq).trim();
  let value = first.slice(eq + 1).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (!name || /[\s;,=]/.test(name)) return { ok: false, reason: 'invalid name' };
  if (name.length + value.length > 4096) return { ok: false, reason: 'too large' };

  const host = requestUrl.hostname.toLowerCase();
  let domainAttr: string | null = null;
  let path: string | null = null;
  let secure = false;
  let httpOnly = false;
  let sameSite: SameSite = 'lax'; // Chrome "Lax by default"
  let maxAge: number | null = null;
  let expiresAttr: number | null = null;

  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    const i = p.indexOf('=');
    const key = (i === -1 ? p : p.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? '' : p.slice(i + 1).trim();
    switch (key) {
      case 'domain': {
        const d = val.replace(/^\./, '').toLowerCase();
        if (d) domainAttr = d;
        break;
      }
      case 'path':
        path = val.startsWith('/') ? val : null;
        break;
      case 'secure':
        secure = true;
        break;
      case 'httponly':
        httpOnly = true;
        break;
      case 'samesite': {
        const v = val.toLowerCase();
        sameSite = v === 'strict' ? 'strict' : v === 'none' ? 'none' : 'lax';
        break;
      }
      case 'max-age':
        if (/^-?\d+$/.test(val)) maxAge = Number.parseInt(val, 10);
        break;
      case 'expires': {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) expiresAttr = t;
        break;
      }
      default:
        break; // Partitioned, Priority, etc. are ignored in the POC
    }
  }

  if (opts.fromScript && httpOnly) return { ok: false, reason: 'httponly from script' };

  let domain = host;
  let hostOnly = true;
  if (domainAttr !== null) {
    if (!domainMatch(host, domainAttr)) return { ok: false, reason: 'domain mismatch' };
    if (!domainAttr.includes('.') && domainAttr !== host) {
      return { ok: false, reason: 'public suffix' };
    }
    if (isIpAddress(domainAttr) && domainAttr !== host) return { ok: false, reason: 'ip domain' };
    domain = domainAttr;
    // An IP address has no subdomains, so Domain=<ip> behaves as host-only.
    hostOnly = isIpAddress(host);
  }

  const secureCtx = isSecureContextUrl(requestUrl);
  if (secure && !secureCtx) return { ok: false, reason: 'secure from insecure origin' };
  if (sameSite === 'none' && !secure) return { ok: false, reason: 'samesite=none requires secure' };
  if (name.startsWith('__Secure-') && !secure) return { ok: false, reason: '__Secure- prefix' };
  if (name.startsWith('__Host-') && (!secure || !hostOnly || (path ?? '') !== '/')) {
    return { ok: false, reason: '__Host- prefix' };
  }

  let expires: number | null = null;
  if (maxAge !== null) expires = maxAge <= 0 ? 0 : now + maxAge * 1000;
  else if (expiresAttr !== null) expires = expiresAttr;

  return {
    ok: true,
    cookie: {
      name,
      value,
      domain,
      hostOnly,
      path: path ?? defaultPath(requestUrl.pathname),
      secure,
      httpOnly,
      sameSite,
      expires,
      created: now,
    },
  };
}

function sameKey(a: StoredCookie, b: StoredCookie): boolean {
  return a.name === b.name && a.domain === b.domain && a.path === b.path;
}

/** Does `c` apply to a request for `url`? */
export function cookieApplies(
  c: StoredCookie,
  url: URL,
  now: number,
  opts: { includeHttpOnly?: boolean; context?: SameSiteContext; checkPath?: boolean } = {},
): boolean {
  if (isExpired(c, now)) return false;
  const host = url.hostname.toLowerCase();
  if (c.hostOnly ? host !== c.domain : !domainMatch(host, c.domain)) return false;
  if ((opts.checkPath ?? true) && !pathMatch(url.pathname || '/', c.path)) return false;
  if (c.secure && !isSecureContextUrl(url)) return false;
  if (opts.includeHttpOnly === false && c.httpOnly) return false;
  if (opts.context === 'cross-site' && c.sameSite !== 'none') return false;
  return true;
}

/** RFC 6265 §5.4 ordering: longer paths first, then earlier creation. */
export function sortForHeader(cookies: StoredCookie[]): StoredCookie[] {
  return [...cookies].sort((a, b) => b.path.length - a.path.length || a.created - b.created);
}

export function serialize(cookies: StoredCookie[]): string {
  return sortForHeader(cookies)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

export class CookieJar {
  private cookies: StoredCookie[];

  constructor(cookies: StoredCookie[] = []) {
    this.cookies = [...cookies];
  }

  all(): StoredCookie[] {
    return [...this.cookies];
  }

  get size(): number {
    return this.cookies.length;
  }

  /** Stores a parsed cookie. Returns true when the jar changed. */
  store(cookie: StoredCookie, now: number, opts: { fromScript?: boolean; secureCtx?: boolean } = {}): boolean {
    const idx = this.cookies.findIndex((c) => sameKey(c, cookie));
    const existing = idx >= 0 ? this.cookies[idx] : undefined;
    if (existing && existing.httpOnly && opts.fromScript) return false;
    // 6265bis: an insecure origin may not overwrite a Secure cookie.
    if (existing && existing.secure && !cookie.secure && opts.secureCtx === false) return false;

    if (isExpired(cookie, now)) {
      if (idx >= 0) {
        this.cookies.splice(idx, 1);
        return true;
      }
      return false;
    }
    if (existing) {
      this.cookies[idx] = { ...cookie, created: existing.created };
      return (
        existing.value !== cookie.value ||
        existing.expires !== cookie.expires ||
        existing.httpOnly !== cookie.httpOnly ||
        existing.secure !== cookie.secure ||
        existing.sameSite !== cookie.sameSite ||
        existing.hostOnly !== cookie.hostOnly
      );
    }
    this.cookies.push(cookie);
    return true;
  }

  /** Parses and stores a Set-Cookie header value (or a document.cookie assignment). */
  setFromHeader(header: string, url: URL, now: number, opts: { fromScript?: boolean } = {}): ParseResult & { changed?: boolean } {
    const r = parseSetCookie(header, url, now, opts);
    if (!r.ok) return r;
    const changed = this.store(r.cookie, now, { ...opts, secureCtx: isSecureContextUrl(url) });
    return { ...r, changed };
  }

  /** Removes expired cookies. Returns true when something was removed. */
  purgeExpired(now: number): boolean {
    const before = this.cookies.length;
    this.cookies = this.cookies.filter((c) => !isExpired(c, now));
    return this.cookies.length !== before;
  }

  /** Earliest future expiry, for scheduling a purge. */
  nextExpiry(now: number): number | null {
    let next: number | null = null;
    for (const c of this.cookies) {
      if (c.expires !== null && c.expires > now && (next === null || c.expires < next)) next = c.expires;
    }
    return next;
  }

  matching(url: URL, now: number, opts: Parameters<typeof cookieApplies>[3] = {}): StoredCookie[] {
    return this.cookies.filter((c) => cookieApplies(c, url, now, opts));
  }

  cookieHeaderFor(url: URL, now: number, context: SameSiteContext = 'same-site'): string {
    return serialize(this.matching(url, now, { context }));
  }

  /** What `document.cookie` should return for a document at `url`. */
  documentCookieFor(url: URL, now: number): string {
    return serialize(this.matching(url, now, { includeHttpOnly: false }));
  }

  /** Non-HttpOnly cookies for a host (all paths) — safe to hand to page-world code. */
  scriptVisibleForHost(url: URL, now: number): StoredCookie[] {
    return this.matching(url, now, { includeHttpOnly: false, checkPath: false });
  }

  clear(): void {
    this.cookies = [];
  }
}

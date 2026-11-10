/**
 * Pure session-model helpers shared by the service worker and the UI.
 * No chrome.* calls here, so everything is unit-testable.
 */
import { isExpired, type StoredCookie } from './cookieJar.js';

/**
 * Session colors are exactly the Chrome tab-group colors: tab groups accept only these
 * names, so one palette keeps the badge, the UI and the tab group consistent (ADR 0003).
 */
export const SESSION_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'] as const;
export type SessionColor = (typeof SESSION_COLORS)[number];

/** Hex approximations of Chrome's tab-group colors, for the badge and the UI. */
export const COLOR_HEX: Record<SessionColor, string> = {
  grey: '#5f6368',
  blue: '#1a73e8',
  red: '#d93025',
  yellow: '#f9ab00',
  green: '#188038',
  pink: '#d01884',
  purple: '#a142f4',
  cyan: '#007b83',
  orange: '#fa903e',
};

export interface SessionMeta {
  id: string;
  name: string;
  color: SessionColor;
  status: 'active' | 'archived';
  createdAt: number;
  updatedAt: number;
}

/**
 * How sessions are shown in the tab strip (ADR 0003, D4). The session is always chosen per tab;
 * this only changes the marker:
 * - `tab`:   badge on the toolbar icon only, tabs stay ungrouped (default).
 * - `group`: additionally put each session's tabs into a Chrome tab group.
 */
export const GROUPING_MODES = ['tab', 'group'] as const;
export type GroupingMode = (typeof GROUPING_MODES)[number];

export function isGroupingMode(v: unknown): v is GroupingMode {
  return typeof v === 'string' && (GROUPING_MODES as readonly string[]).includes(v);
}

export interface Settings {
  /** FR-7: links opened from a managed tab inherit its session. */
  inheritOnOpen: boolean;
  /** FR-6: session marker mode. */
  grouping: GroupingMode;
}

export const DEFAULT_SETTINGS: Settings = { inheritOnOpen: true, grouping: 'tab' };

/** Reads stored settings, falling back to defaults for missing or invalid values. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    inheritOnOpen: typeof r.inheritOnOpen === 'boolean' ? r.inheritOnOpen : DEFAULT_SETTINGS.inheritOnOpen,
    // The pre-0.2.1 boolean `useTabGroups` is deliberately ignored: the default is now per tab.
    grouping: isGroupingMode(r.grouping) ? r.grouping : DEFAULT_SETTINGS.grouping,
  };
}

export const NAME_MAX = 40;

export function isSessionColor(v: unknown): v is SessionColor {
  return typeof v === 'string' && (SESSION_COLORS as readonly string[]).includes(v);
}

/** Returns the cleaned name, or an error message. */
export function validateName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'Name is required' };
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, error: 'Name is required' };
  if (name.length > NAME_MAX) return { ok: false, error: `Name must be at most ${NAME_MAX} characters` };
  return { ok: true, name };
}

/** Picks the first palette color not used by an active session (cycles when all are used). */
export function nextColor(sessions: Pick<SessionMeta, 'color' | 'status'>[]): SessionColor {
  const used = new Set(sessions.filter((s) => s.status === 'active').map((s) => s.color));
  return SESSION_COLORS.find((c) => !used.has(c)) ?? SESSION_COLORS[sessions.length % SESSION_COLORS.length]!;
}

/** Short badge text for the toolbar icon (Chrome shows ~4 characters). */
export function badgeText(name: string): string {
  return Array.from(name.trim()).slice(0, 4).join('');
}

/** Coerces stored data (possibly from an older version) into valid metadata, or null. */
export function normalizeMeta(raw: unknown): SessionMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = validateName(r.name);
  if (typeof r.id !== 'string' || !r.id || !name.ok) return null;
  const now = Date.now();
  return {
    id: r.id,
    name: name.name,
    color: isSessionColor(r.color) ? r.color : 'grey',
    status: r.status === 'archived' ? 'archived' : 'active',
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : now,
  };
}

export interface CookieSummaryEntry {
  name: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: StoredCookie['sameSite'];
  /** Epoch ms, or null for a session cookie. */
  expires: number | null;
}

export interface CookieSummary {
  domain: string;
  cookies: CookieSummaryEntry[];
}

/**
 * Groups a session's live cookies by domain for display. Cookie **values are never included**:
 * the UI shows what is stored, not the secrets themselves.
 */
export function summarizeCookies(cookies: StoredCookie[], now: number): CookieSummary[] {
  const byDomain = new Map<string, CookieSummaryEntry[]>();
  for (const c of cookies) {
    if (isExpired(c, now)) continue;
    const domain = c.hostOnly ? c.domain : `.${c.domain}`;
    const list = byDomain.get(domain) ?? [];
    list.push({ name: c.name, path: c.path, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, expires: c.expires });
    byDomain.set(domain, list);
  }
  return [...byDomain.entries()]
    .sort(([a], [b]) => a.replace(/^\./, '').localeCompare(b.replace(/^\./, '')))
    .map(([domain, list]) => ({ domain, cookies: list.sort((x, y) => x.name.localeCompare(y.name)) }));
}

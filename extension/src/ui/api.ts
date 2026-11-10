/** Typed client for the service worker's `ui:*` messages, shared by the popup and the side panel. */
import { UI_CHANGED, type UiCookies, type UiMessage, type UiResult, type UiState } from '../shared/messages.js';
import type { SessionColor, SessionMeta, Settings } from '../shared/sessions.js';

async function call<T>(msg: UiMessage): Promise<T> {
  const r = (await chrome.runtime.sendMessage(msg)) as UiResult<T> | undefined;
  if (!r) throw new Error('SessionWoy did not respond. Try reloading the extension.');
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export const api = {
  state: (tabId?: number) => call<UiState>({ type: 'ui:state', ...(tabId !== undefined ? { tabId } : {}) }),
  create: (name: string, color?: SessionColor, assignTabId?: number) =>
    call<SessionMeta>({ type: 'ui:create', name, ...(color ? { color } : {}), ...(assignTabId !== undefined ? { assignTabId } : {}) }),
  update: (id: string, patch: { name?: string; color?: SessionColor }) => call<SessionMeta>({ type: 'ui:update', id, ...patch }),
  archive: (id: string) => call<null>({ type: 'ui:archive', id }),
  restore: (id: string) => call<null>({ type: 'ui:restore', id }),
  remove: (id: string) => call<null>({ type: 'ui:delete', id }),
  reset: (id: string) => call<null>({ type: 'ui:reset', id }),
  assign: (tabId: number, sessionId: string | null) => call<null>({ type: 'ui:assign', tabId, sessionId }),
  openTab: (sessionId: string, url: string) => call<{ tabId: number }>({ type: 'ui:openTab', sessionId, url }),
  cookies: (id: string) => call<UiCookies>({ type: 'ui:cookies', id }),
  settings: (patch: Partial<Settings>) => call<Settings>({ type: 'ui:settings', patch }),
  permissionsChanged: () => call<null>({ type: 'ui:permissionsChanged' }),
};

/** Calls `fn` whenever the service worker reports a state change. Returns an unsubscribe function. */
export function onChanged(fn: () => void): () => void {
  const listener = (msg: unknown) => {
    if ((msg as { type?: string } | null)?.type === UI_CHANGED) fn();
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

export function isWebUrl(url: string | undefined): url is string {
  return !!url && /^https?:\/\//.test(url);
}

/** Origin match pattern for host-permission checks, e.g. `https://example.com/*`. */
export function originPattern(url: string): string {
  return `${new URL(url).origin}/*`;
}

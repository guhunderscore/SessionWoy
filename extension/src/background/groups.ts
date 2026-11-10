/**
 * FR-6: Chrome tab groups as a visual session marker (ADR 0003).
 *
 * One group per (session, window). The store keeps `${sessionId}:${windowId}` -> groupId in
 * chrome.storage.session. All functions are best-effort: tab-group calls can fail when a tab
 * is closing or a window is being dragged, and a failure must never break cookie isolation.
 * If the user drags a managed tab out of its group, we leave it there (we do not fight the user).
 */
import type { Store } from './state.js';

const key = (sessionId: string, windowId: number) => `${sessionId}:${windowId}`;

async function groupExists(groupId: number): Promise<boolean> {
  try {
    await chrome.tabGroups.get(groupId);
    return true;
  } catch {
    return false;
  }
}

/** Puts the tab into its session's group for the tab's window, creating the group if needed. */
export async function addToSessionGroup(store: Store, tabId: number, sessionId: string): Promise<void> {
  const meta = store.sessions.get(sessionId);
  if (!meta || store.settings.grouping !== 'group') return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId === undefined || tab.pinned) return; // pinned tabs cannot be grouped
    const k = key(sessionId, tab.windowId);
    let groupId = store.groups.get(k);
    if (groupId !== undefined && !(await groupExists(groupId))) {
      store.groups.delete(k);
      groupId = undefined;
    }
    if (groupId !== undefined && tab.groupId === groupId) return;
    groupId = await chrome.tabs.group(groupId !== undefined ? { tabIds: [tabId], groupId } : { tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    store.groups.set(k, groupId);
    await chrome.tabGroups.update(groupId, { title: meta.name, color: meta.color });
  } catch (e) {
    console.warn('[sessionwoy] could not group tab', e);
  }
}

/** Removes the tab from a group if (and only if) it is in one of the session's groups. */
export async function removeFromSessionGroup(store: Store, tabId: number, sessionId: string): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const ours = [...store.groups].some(([k, g]) => k.startsWith(`${sessionId}:`) && g === tab.groupId);
    if (ours) await chrome.tabs.ungroup(tabId);
  } catch {
    /* tab gone */
  }
}

/** Applies the session's current name and color to all of its groups (rename / recolor). */
export async function refreshSessionGroups(store: Store, sessionId: string): Promise<void> {
  const meta = store.sessions.get(sessionId);
  if (!meta) return;
  for (const [k, groupId] of [...store.groups]) {
    if (!k.startsWith(`${sessionId}:`)) continue;
    try {
      await chrome.tabGroups.update(groupId, { title: meta.name, color: meta.color });
    } catch {
      store.groups.delete(k);
    }
  }
}

/** Forgets all groups of a session (after delete / archive; tabs are ungrouped by the caller). */
export function forgetSessionGroups(store: Store, sessionId: string): void {
  for (const k of [...store.groups.keys()]) if (k.startsWith(`${sessionId}:`)) store.groups.delete(k);
}

/** Groups every managed tab (used when the setting is switched on). */
export async function groupAllTabs(store: Store): Promise<void> {
  for (const [tabId, sid] of [...store.tabs]) await addToSessionGroup(store, tabId, sid);
}

/** Ungroups every managed tab from our groups (used when the setting is switched off). */
export async function ungroupAllTabs(store: Store): Promise<void> {
  const ourGroups = new Set(store.groups.values());
  for (const tabId of [...store.tabs.keys()]) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (ourGroups.has(tab.groupId ?? -1)) await chrome.tabs.ungroup(tabId);
    } catch {
      /* tab gone */
    }
  }
  store.groups.clear();
}

/** A group was closed or removed by the user: forget it. */
export function onGroupRemoved(store: Store, groupId: number): boolean {
  let changed = false;
  for (const [k, g] of [...store.groups]) {
    if (g === groupId) {
      store.groups.delete(k);
      changed = true;
    }
  }
  return changed;
}

/**
 * ISOLATED-world relay (document_start, all frames). Bridges the MAIN-world
 * cookie hook and the service worker. The service worker derives the frame URL
 * from `sender.url`, so page-supplied data can only affect the page's own origin.
 *
 * Orphaned relays: when the extension is reloaded or updated, Chrome leaves this
 * script running in already-open pages, but its extension context is gone. Then
 * `chrome.runtime.sendMessage` *throws synchronously* ("Extension context
 * invalidated") instead of returning a rejected promise. The relay detects that,
 * stops listening, and tells the MAIN-world hook to fall back to native
 * `document.cookie` (the new extension instance has no session for this tab
 * anyway, and its DNR rules are gone), so the page behaves like normal Chrome
 * until it is reloaded. See ADR 0003, F7.
 */
import { TAB_MARKER_KEY, TO_MAIN, TO_RELAY, type ContentMessage, type MainToRelay, type Snapshot } from '../shared/messages.js';
import { clearSessionFavicon, setSessionFavicon } from './favicon.js';

let alive = true;

function contextValid(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function toMain(snap: Snapshot): void {
  document.dispatchEvent(new CustomEvent(TO_MAIN, { detail: JSON.stringify(snap) }));
}

/** Detaches this relay and returns the page to native cookie behavior. */
function shutdown(): void {
  if (!alive) return;
  alive = false;
  document.removeEventListener(TO_RELAY, onRelay);
  toMain({ managed: false });
  clearSessionFavicon();
}

async function send(msg: ContentMessage): Promise<unknown> {
  if (!alive) return undefined;
  if (!contextValid()) {
    shutdown();
    return undefined;
  }
  try {
    // Wrapped in try/await: an invalidated context throws synchronously, a missing
    // receiver rejects asynchronously; both end up here.
    return await chrome.runtime.sendMessage(msg);
  } catch {
    if (!contextValid()) shutdown();
    return undefined;
  }
}

const isTopFrame = (() => {
  try {
    return window.top === window;
  } catch {
    return false;
  }
})();

function readMarker(): string | null {
  try {
    return sessionStorage.getItem(TAB_MARKER_KEY);
  } catch {
    return null; // storage disabled / sandboxed frame
  }
}

function writeMarker(marker: string | null): void {
  try {
    if (marker) sessionStorage.setItem(TAB_MARKER_KEY, marker);
    else sessionStorage.removeItem(TAB_MARKER_KEY);
  } catch {
    /* ignore */
  }
}

async function refresh(): Promise<void> {
  const snap = (await send({ type: 'snapshot:get' })) as Snapshot | undefined;
  if (!snap || !alive) return;
  toMain(snap);
  // Favicon dot in the session color (top frame only; see favicon.ts).
  if (snap.managed && snap.color) setSessionFavicon(snap.color);
  else clearSessionFavicon();

  // FR-17 tab marker (top frame only): keep it while in a session; when the tab has no session,
  // a remembered marker may let a restored tab rejoin its session (worker decides, once).
  if (!isTopFrame) return;
  if (snap.managed) {
    if (snap.marker) writeMarker(snap.marker);
    return;
  }
  const marker = readMarker();
  if (!marker) return;
  const r = (await send({ type: 'tab:restore', marker })) as { restored?: boolean } | undefined;
  // Not restored (window closed, unknown marker, tab left its session on purpose): never retry.
  if (!r?.restored) writeMarker(null);
}

function onRelay(e: Event): void {
  const detail = (e as CustomEvent<unknown>).detail;
  if (typeof detail !== 'string') return;
  let msg: MainToRelay;
  try {
    msg = JSON.parse(detail) as MainToRelay;
  } catch {
    return;
  }
  if (msg.type === 'set' && typeof msg.value === 'string') void send({ type: 'cookie:set', value: msg.value });
  else if (msg.type === 'import' && Array.isArray(msg.values)) void send({ type: 'cookie:import', values: msg.values });
}

document.addEventListener(TO_RELAY, onRelay);

chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === 'session:changed') void refresh();
  return false;
});

void refresh();

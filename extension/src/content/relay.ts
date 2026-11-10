/**
 * ISOLATED-world relay (document_start, all frames). Bridges the MAIN-world
 * cookie hook and the service worker. The service worker derives the frame URL
 * from `sender.url`, so page-supplied data can only affect the page's own origin.
 */
import { TO_MAIN, TO_RELAY, type ContentMessage, type MainToRelay, type Snapshot } from '../shared/messages.js';

const send = (msg: ContentMessage): Promise<unknown> => chrome.runtime.sendMessage(msg).catch(() => undefined);

async function refresh(): Promise<void> {
  const snap = (await send({ type: 'snapshot:get' })) as Snapshot | undefined;
  if (!snap) return;
  document.dispatchEvent(new CustomEvent(TO_MAIN, { detail: JSON.stringify(snap) }));
}

document.addEventListener(TO_RELAY, (e) => {
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
});

chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === 'session:changed') void refresh();
  return false;
});

void refresh();

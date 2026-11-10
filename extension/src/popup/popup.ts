/** Minimal POC control surface (not the Phase 3 session manager UI). */
import type { PopupMessage } from '../shared/messages.js';

interface PopupState {
  sessionId: string | null;
  presets: Record<string, { name: string; color: string }>;
  sessions: { id: string; name: string; tabs: number; cookies: number }[];
  diag: unknown;
}

const $ = (id: string) => document.getElementById(id)!;
const send = <T>(msg: PopupMessage) => chrome.runtime.sendMessage(msg) as Promise<T>;

function button(label: string, color: string | null, onClick: () => void, pressed = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (color) {
    b.className = 'session';
    b.style.background = color;
  }
  b.setAttribute('aria-pressed', String(pressed));
  b.onclick = onClick;
  return b;
}

async function render(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  const tabId = tab.id;
  const st = await send<PopupState>({ type: 'popup:state', tabId });
  const current = st.sessionId ? (st.presets[st.sessionId]?.name ?? st.sessionId) : 'unmanaged';
  $('current').textContent = current;

  const origin = tab.url && /^https?:/.test(tab.url) ? new URL(tab.url).origin + '/*' : null;
  const hasPerm = origin ? await chrome.permissions.contains({ origins: [origin] }) : true;
  $('perm-warning').hidden = hasPerm;
  ($('grant') as HTMLButtonElement).onclick = async () => {
    if (!origin) return;
    if (await chrome.permissions.request({ origins: [origin] })) {
      await send({ type: 'popup:permissionsChanged' });
      await render();
    }
  };

  const assignRow = $('assign');
  const openRow = $('open');
  const resetRow = $('reset');
  assignRow.replaceChildren();
  openRow.replaceChildren();
  resetRow.replaceChildren();
  for (const [id, p] of Object.entries(st.presets)) {
    assignRow.append(
      button(p.name, p.color, async () => {
        await send({ type: 'popup:assign', tabId, sessionId: id });
        await chrome.tabs.reload(tabId);
        await render();
      }, st.sessionId === id),
    );
    openRow.append(
      button(p.name, p.color, () => void send({ type: 'popup:open', sessionId: id, url: tab.url && /^https?:/.test(tab.url) ? tab.url : 'about:blank' })),
    );
    resetRow.append(button(p.name, null, async () => {
      await send({ type: 'popup:reset', sessionId: id });
      await render();
    }));
  }
  assignRow.append(
    button('Unassign', null, async () => {
      await send({ type: 'popup:assign', tabId, sessionId: null });
      await chrome.tabs.reload(tabId);
      await render();
    }, st.sessionId === null),
  );
  $('diag').textContent = JSON.stringify({ sessions: st.sessions, diag: st.diag }, null, 2);
}

void render();

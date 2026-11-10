/**
 * F7 (ADR 0003): after an extension reload, Chrome leaves the old content scripts running in open
 * pages. Their `chrome.runtime.sendMessage` then THROWS synchronously ("Extension context
 * invalidated") instead of rejecting. This drives the real relay module with a fake `chrome` and
 * `document`, because Playwright cannot reload an extension loaded with --load-extension.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TO_MAIN, TO_RELAY } from '../src/shared/messages.js';

interface FakeChrome {
  valid: boolean;
  sent: unknown[];
  chrome: unknown;
}

function installFakes(): FakeChrome {
  const state: FakeChrome = { valid: true, sent: [], chrome: undefined };
  state.chrome = {
    runtime: {
      get id() {
        return state.valid ? 'ext-id' : undefined;
      },
      sendMessage(msg: unknown) {
        if (!state.valid) throw new Error('Extension context invalidated.');
        state.sent.push(msg);
        return Promise.resolve({ managed: true, sessionId: 's1', cookies: [] });
      },
      onMessage: { addListener: () => undefined },
    },
  };
  vi.stubGlobal('chrome', state.chrome);
  vi.stubGlobal('document', new EventTarget());
  return state;
}

function fromMain(): unknown[] {
  const seen: unknown[] = [];
  document.addEventListener(TO_MAIN, (e) => seen.push(JSON.parse((e as CustomEvent<string>).detail)));
  return seen;
}

const toRelay = (msg: unknown) => document.dispatchEvent(new CustomEvent(TO_RELAY, { detail: JSON.stringify(msg) }));
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('content relay', () => {
  it('forwards cookie writes while the extension context is valid', async () => {
    const fake = installFakes();
    const main = fromMain();
    await import('../src/content/relay.js');
    await flush();
    expect(main).toEqual([{ managed: true, sessionId: 's1', cookies: [] }]); // initial snapshot
    toRelay({ type: 'set', value: 'a=1' });
    await flush();
    expect(fake.sent).toContainEqual({ type: 'cookie:set', value: 'a=1' });
  });

  it('shuts down cleanly when the context is invalidated (no uncaught error)', async () => {
    const fake = installFakes();
    const main = fromMain();
    await import('../src/content/relay.js');
    await flush();
    const sentBefore = fake.sent.length;

    fake.valid = false; // extension reloaded
    expect(() => toRelay({ type: 'set', value: 'b=1' })).not.toThrow();
    await flush();
    // The MAIN-world hook is told to fall back to native document.cookie.
    expect(main.at(-1)).toEqual({ managed: false });
    // The relay detached: later writes are ignored without touching chrome.runtime.
    toRelay({ type: 'set', value: 'c=1' });
    await flush();
    expect(fake.sent.length).toBe(sentBefore);
    expect(main.filter((m) => (m as { managed: boolean }).managed === false)).toHaveLength(1);
  });

  it('also handles a sendMessage that throws synchronously while id is still present', async () => {
    const fake = installFakes();
    const main = fromMain();
    await import('../src/content/relay.js');
    await flush();
    // Some Chrome versions still expose runtime.id for a moment but throw on sendMessage.
    (fake.chrome as { runtime: { sendMessage: () => never } }).runtime.sendMessage = () => {
      fake.valid = false;
      throw new Error('Extension context invalidated.');
    };
    expect(() => toRelay({ type: 'set', value: 'd=1' })).not.toThrow();
    await flush();
    expect(main.at(-1)).toEqual({ managed: false });
  });
});

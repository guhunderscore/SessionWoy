import { describe, expect, it } from 'vitest';
import { TabMarkers } from '../src/background/restore.js';
import type { KeyValueArea } from '../src/background/vault.js';

function area(): KeyValueArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (k) => structuredClone(data.get(k)),
    set: async (k, v) => void data.set(k, structuredClone(v)),
    remove: async (k) => void data.delete(k),
  };
}

const ORIGIN = 'http://localhost:3000';

describe('TabMarkers (FR-17)', () => {
  it('restores a tab after a browser restart when marker and origin match, inside the window', async () => {
    const local = area();
    let memory = area();
    const run1 = new TabMarkers(local, memory);
    await run1.load();
    const marker = await run1.track(11, 'S1', ORIGIN, 1000);
    expect(await run1.track(11, 'S1', ORIGIN, 2000)).toBe(marker); // stable per tab
    await run1.detach(11); // window closing at browser shutdown

    memory = area(); // browser restart: session memory is gone
    const run2 = new TabMarkers(local, memory);
    await run2.load();
    expect(await run2.claim(marker, ORIGIN, 99, 5000)).toBeNull(); // no window yet
    await run2.openWindow(10_000, 1000);
    expect(run2.status(10_500)).toEqual({ active: true, unrestored: 0 });
    expect(await run2.claim(marker, 'http://evil.example', 99, 10_100)).toBeNull(); // wrong origin
    expect(await run2.claim(marker, ORIGIN, 99, 10_200)).toBe('S1');
    expect(await run2.claim(marker, ORIGIN, 100, 10_300)).toBeNull(); // only once
    expect(await run2.claim(marker, ORIGIN, 99, 11_000)).toBeNull(); // window closed (time)
    expect(await run2.closeWindow()).toBe(0);
    expect(run2.status(12_000)).toEqual({ active: false, unrestored: 0 });
  });

  it('counts and drops entries nobody claimed; dismiss clears the count', async () => {
    const local = area();
    const m = new TabMarkers(local, area());
    await m.load();
    await m.track(1, 'S1', ORIGIN, 0);
    const kept = await m.track(2, 'S2', ORIGIN, 0);
    await m.openWindow(100, 1000);
    expect(await m.claim(kept, ORIGIN, 22, 200)).toBe('S2');
    expect(await m.closeWindow()).toBe(1);
    expect(m.status(5000).unrestored).toBe(1);
    await m.dismiss();
    expect(m.status(5000).unrestored).toBe(0);
    expect(Object.keys(local.data.get('sessionwoy:tab-markers:v1') as object)).toEqual([kept]);
  });

  it('forget (tab closed or left its session) and forgetSession remove entries for good', async () => {
    const m = new TabMarkers(area(), area());
    await m.load();
    const a = await m.track(1, 'S1', ORIGIN, 0);
    const b = await m.track(2, 'S2', ORIGIN, 0);
    await m.forget(1);
    await m.forgetSession('S2');
    await m.openWindow(0, 1000);
    expect(await m.claim(a, ORIGIN, 10, 1)).toBeNull();
    expect(await m.claim(b, ORIGIN, 11, 1)).toBeNull();
  });
});

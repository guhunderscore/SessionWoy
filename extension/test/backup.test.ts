import { describe, expect, it } from 'vitest';
import { BACKUP_FORMAT, backupFileName, createBackup, readBackup } from '../src/shared/backup.js';
import { CookieJar } from '../src/shared/cookieJar.js';

const FAST = 1_000;
const meta = { id: 's1', name: 'Customer', color: 'blue' as const, status: 'active' as const, createdAt: 1, updatedAt: 2 };

function cookies() {
  const jar = new CookieJar();
  jar.setFromHeader('sid=SECRET-VALUE; Path=/; HttpOnly', new URL('http://localhost:3000/'), Date.now());
  return jar.all();
}

describe('backup', () => {
  it('names files by date', () => {
    expect(backupFileName(new Date('2026-11-10T12:00:00Z'))).toBe('sessionwoy-backup-2026-11-10.json');
  });

  it('round-trips with the right passphrase and hides everything without it', async () => {
    const file = await createBackup({ sessions: [meta], cookies: { s1: cookies() } }, 'backup passphrase', FAST);
    expect(file.format).toBe(BACKUP_FORMAT);
    const text = JSON.stringify(file);
    expect(text).not.toContain('SECRET-VALUE');
    expect(text).not.toContain('Customer'); // metadata is encrypted too
    const back = await readBackup(text, 'backup passphrase');
    expect(back.sessions).toEqual([meta]);
    expect(back.cookies.s1?.[0]).toMatchObject({ name: 'sid', value: 'SECRET-VALUE', httpOnly: true });
  });

  it('rejects a wrong passphrase, a foreign file and a weak export passphrase', async () => {
    const file = await createBackup({ sessions: [meta], cookies: {} }, 'backup passphrase', FAST);
    await expect(readBackup(file, 'wrong passphrase')).rejects.toThrow('Wrong passphrase');
    await expect(readBackup('{"hello":1}', 'backup passphrase')).rejects.toThrow('not a SessionWoy backup');
    await expect(readBackup('not json', 'backup passphrase')).rejects.toThrow('not a SessionWoy backup');
    await expect(createBackup({ sessions: [], cookies: {} }, 'short')).rejects.toThrow('at least 8');
  });

  it('drops invalid sessions and cookies of unknown sessions', async () => {
    const file = await createBackup(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { sessions: [meta, { id: '', name: '' } as any], cookies: { s1: [...cookies(), { bogus: true } as any], ghost: cookies() } },
      'backup passphrase',
      FAST,
    );
    const back = await readBackup(file, 'backup passphrase');
    expect(back.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(back.cookies.s1).toHaveLength(1);
    expect(back.cookies.ghost).toBeUndefined();
  });
});

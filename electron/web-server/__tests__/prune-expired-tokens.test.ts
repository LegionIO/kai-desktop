/**
 * Tests for pruneExpiredTokens in web-server.ts — the expiry sweep that stops
 * the in-memory login-token map from growing without bound. loginTokens is
 * otherwise only cleaned when a QR token is consumed/presented, so an
 * abandoned-but-never-scanned token would linger forever; createLoginToken now
 * sweeps expired entries on each issue via this helper.
 *
 * `electron` (pulled in transitively) is mocked and HOME is repointed so the
 * module can load in a plain Node test (mirrors session-invalidation.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn(), emit: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => tmpdir(), on: vi.fn(), whenReady: () => Promise.resolve() },
}));

process.env.HOME = mkdtempSync(join(tmpdir(), 'kai-logintoken-'));

const { pruneExpiredTokens } = await import('../web-server.js');

describe('pruneExpiredTokens', () => {
  it('deletes entries whose expiry is strictly before now, keeps the rest', () => {
    const now = 1_000_000;
    const m = new Map<string, number>([
      ['expired-1', now - 1],
      ['expired-2', now - 100_000],
      ['exactly-now', now], // not < now → kept
      ['future', now + 5000],
    ]);
    pruneExpiredTokens(m, now);
    expect([...m.keys()].sort()).toEqual(['exactly-now', 'future']);
  });

  it('is a no-op on an empty map', () => {
    const m = new Map<string, number>();
    pruneExpiredTokens(m, Date.now());
    expect(m.size).toBe(0);
  });

  it('removes everything when all entries are expired', () => {
    const now = 2_000_000;
    const m = new Map<string, number>([
      ['a', now - 1],
      ['b', now - 2],
      ['c', 0],
    ]);
    pruneExpiredTokens(m, now);
    expect(m.size).toBe(0);
  });

  it('keeps everything when nothing is expired', () => {
    const now = 5000;
    const m = new Map<string, number>([
      ['a', now + 1],
      ['b', now + 1000],
    ]);
    pruneExpiredTokens(m, now);
    expect(m.size).toBe(2);
  });
});

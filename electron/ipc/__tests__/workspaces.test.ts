/**
 * Tests for workspaces IPC input validation + state integrity (create name/dir
 * checks, canonical dedup, and set-active rejecting an unknown id so
 * activeWorkspaceId can't dangle). electron + fs/promises are mocked; handlers
 * are captured off a fake ipcMain.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, args: unknown) => Promise<unknown>>();
const fakeIpc = { handle: (ch: string, fn: (e: unknown, a: unknown) => Promise<unknown>) => handlers.set(ch, fn) };

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
}));

// Controllable fs: which paths are dirs + how realpath resolves.
const dirs = new Set<string>();
const realMap = new Map<string, string>();
vi.mock('fs/promises', () => ({
  stat: async (p: string) => {
    if (dirs.has(p)) return { isDirectory: () => true };
    throw new Error('ENOENT');
  },
  realpath: async (p: string) => realMap.get(p) ?? p,
}));

vi.mock('../../config/workspaces.js', () => ({ nextWorkspaceColor: () => '#123456' }));

import { registerWorkspaceHandlers } from '../workspaces.js';
import type { AppConfig } from '../../config/schema.js';

let config: { ui: { workspaces: unknown[]; activeWorkspaceId: string | null } };
const sets: Array<[string, unknown]> = [];
const getConfig = () => config as unknown as AppConfig;
const setConfig = (path: string, value: unknown) => {
  sets.push([path, value]);
  if (path === 'ui.workspaces') config.ui.workspaces = value as unknown[];
  if (path === 'ui.activeWorkspaceId') config.ui.activeWorkspaceId = value as string | null;
};

beforeEach(() => {
  handlers.clear();
  dirs.clear();
  realMap.clear();
  sets.length = 0;
  config = { ui: { workspaces: [], activeWorkspaceId: null } };
  registerWorkspaceHandlers(fakeIpc as never, '/home', getConfig, setConfig);
});

const create = (args: { name: string; directory: string }) => handlers.get('workspaces:create')!(null, args);
const setActive = (id: string | null) => handlers.get('workspaces:set-active')!(null, { id });

describe('workspaces:create validation', () => {
  it('rejects an empty name', async () => {
    dirs.add('/work/p');
    await expect(create({ name: '   ', directory: '/work/p' })).rejects.toThrow(/name is required/i);
  });

  it('rejects a non-absolute directory', async () => {
    await expect(create({ name: 'ok', directory: 'relative/dir' })).rejects.toThrow(/absolute path/i);
  });

  it('rejects a directory that does not exist', async () => {
    await expect(create({ name: 'ok', directory: '/nope' })).rejects.toThrow(/does not exist/i);
  });

  it('stores the CANONICAL directory + dedupes by canonical path (symlink alias)', async () => {
    dirs.add('/work/real');
    dirs.add('/work/link'); // a symlink dir that realpaths to /work/real
    realMap.set('/work/link', '/work/real');
    const w1 = (await create({ name: 'first', directory: '/work/real' })) as { directory: string };
    expect(w1.directory).toBe('/work/real');
    // creating via the alias must be caught as a duplicate of the canonical dir
    await expect(create({ name: 'second', directory: '/work/link' })).rejects.toThrow(/already exists/i);
  });
});

describe('workspaces:set-active integrity', () => {
  it('rejects an unknown id (no dangling activeWorkspaceId)', async () => {
    await expect(setActive('does-not-exist')).rejects.toThrow(/not found/i);
    // activeWorkspaceId must NOT have been persisted to the bogus id
    expect(config.ui.activeWorkspaceId).toBeNull();
  });

  it('accepts null (clear active) and a real id', async () => {
    dirs.add('/work/a');
    const w = (await create({ name: 'a', directory: '/work/a' })) as { id: string };
    await expect(setActive(null)).resolves.toBeUndefined();
    expect(config.ui.activeWorkspaceId).toBeNull();
    await setActive(w.id);
    expect(config.ui.activeWorkspaceId).toBe(w.id);
  });
});

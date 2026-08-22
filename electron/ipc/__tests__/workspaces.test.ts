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

const create = (args: { name: string; directory: string; mutationToken?: string }) =>
  handlers.get('workspaces:create')!(null, args);
const deleteWorkspace = (id: string, mutationToken?: string) =>
  handlers.get('workspaces:delete')!(null, { id, mutationToken });
const setActive = (id: string | null, expectedCurrentId?: string | null, mutationToken?: string) =>
  handlers.get('workspaces:set-active')!(null, { id, expectedCurrentId, mutationToken });
const saveLastConversation = (
  workspaceId: string,
  conversationId: string | null,
  expectedCurrentConversationId?: string | null,
) =>
  handlers.get('workspaces:save-last-conversation')!(null, {
    workspaceId,
    conversationId,
    expectedCurrentConversationId,
  });

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
    await expect(setActive(null)).resolves.toEqual({ ok: true, activeWorkspaceId: null });
    expect(config.ui.activeWorkspaceId).toBeNull();
    await expect(setActive(w.id)).resolves.toEqual({ ok: true, activeWorkspaceId: w.id });
    expect(config.ui.activeWorkspaceId).toBe(w.id);
  });

  it('does not replace a newer active workspace when the expected workspace is stale', async () => {
    dirs.add('/work/a');
    dirs.add('/work/b');
    const first = (await create({ name: 'a', directory: '/work/a' })) as { id: string };
    const second = (await create({ name: 'b', directory: '/work/b' })) as { id: string };
    await saveLastConversation(second.id, 'chat-b');

    await expect(setActive(first.id, null)).resolves.toEqual({
      ok: false,
      error: 'active-workspace-changed',
      activeWorkspaceId: second.id,
      activeWorkspaceLastConversationId: 'chat-b',
    });
    expect(config.ui.activeWorkspaceId).toBe(second.id);
  });

  it('reports mutation provenance only while that exact workspace remains active', async () => {
    dirs.add('/work/a');
    dirs.add('/work/b');
    const first = (await create({ name: 'a', directory: '/work/a' })) as { id: string };
    const second = (await create({ name: 'b', directory: '/work/b' })) as { id: string };

    await expect(setActive(first.id, second.id, 'browser_request-1')).resolves.toEqual({
      ok: true,
      activeWorkspaceId: first.id,
      activeWorkspaceMutationToken: 'browser_request-1',
    });
    await expect(setActive(second.id, second.id)).resolves.toEqual({
      ok: false,
      error: 'active-workspace-changed',
      activeWorkspaceId: first.id,
      activeWorkspaceLastConversationId: null,
      activeWorkspaceMutationToken: 'browser_request-1',
    });

    await expect(setActive(second.id, first.id)).resolves.toEqual({ ok: true, activeWorkspaceId: second.id });
    await expect(setActive(first.id, first.id)).resolves.toEqual({
      ok: false,
      error: 'active-workspace-changed',
      activeWorkspaceId: second.id,
      activeWorkspaceLastConversationId: null,
    });
  });

  it('preserves local mutation provenance when create or active delete selects a workspace', async () => {
    dirs.add('/work/a');
    dirs.add('/work/b');
    const first = (await create({
      name: 'a',
      directory: '/work/a',
      mutationToken: 'local-create-request',
    })) as { id: string };

    await expect(setActive(null, null)).resolves.toEqual({
      ok: false,
      error: 'active-workspace-changed',
      activeWorkspaceId: first.id,
      activeWorkspaceLastConversationId: null,
      activeWorkspaceMutationToken: 'local-create-request',
    });

    const second = (await create({ name: 'b', directory: '/work/b' })) as { id: string };
    await deleteWorkspace(second.id, 'local-delete-request');

    await expect(setActive(null, second.id)).resolves.toEqual({
      ok: false,
      error: 'active-workspace-changed',
      activeWorkspaceId: first.id,
      activeWorkspaceLastConversationId: null,
      activeWorkspaceMutationToken: 'local-delete-request',
    });
  });
});

describe('workspaces:save-last-conversation integrity', () => {
  it('returns the previous value so a canceled navigation can restore it', async () => {
    dirs.add('/work/a');
    const workspace = (await create({ name: 'a', directory: '/work/a' })) as { id: string };

    await expect(saveLastConversation(workspace.id, 'chat-a')).resolves.toEqual({
      ok: true,
      previousConversationId: null,
      lastActiveConversationId: 'chat-a',
    });
    await expect(saveLastConversation(workspace.id, 'chat-b', 'chat-a')).resolves.toEqual({
      ok: true,
      previousConversationId: 'chat-a',
      lastActiveConversationId: 'chat-b',
    });
    expect(config.ui.workspaces).toEqual([
      expect.objectContaining({ id: workspace.id, lastActiveConversationId: 'chat-b' }),
    ]);
  });

  it('rejects a stale compare-and-set without overwriting newer metadata', async () => {
    dirs.add('/work/a');
    const workspace = (await create({ name: 'a', directory: '/work/a' })) as { id: string };
    await saveLastConversation(workspace.id, 'chat-newer');
    sets.length = 0;

    await expect(saveLastConversation(workspace.id, 'chat-previous', 'chat-canceled')).resolves.toEqual({
      ok: false,
      error: 'last-conversation-changed',
      lastActiveConversationId: 'chat-newer',
    });
    expect(sets).toEqual([]);
    expect(config.ui.workspaces).toEqual([
      expect.objectContaining({ id: workspace.id, lastActiveConversationId: 'chat-newer' }),
    ]);
  });

  it('reports a missing workspace without mutating configuration', async () => {
    await expect(saveLastConversation('missing', 'chat-a')).resolves.toEqual({
      ok: false,
      error: 'workspace-not-found',
    });
    expect(sets).toEqual([]);
  });
});

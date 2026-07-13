/**
 * Tests for file-changes.ts — the three MODEL-facing tools (list_file_changes,
 * get_file_change, revert_file_changes) that let the agent inspect/undo its own
 * edits. The model is UNTRUSTED, so the security-relevant invariants are:
 *   - every tool requires a conversationId (context scoping — no cross-chat access);
 *   - every path is re-checked against the CURRENT file-access policy at call
 *     time (a path tracked while allowed may since have been denied), on list,
 *     get, revert-single, AND revert-all;
 *   - toOpIndex is forwarded to revertToOp only alongside a single path.
 * The actual revert WRITE safety (symlink refusal, O_NOFOLLOW) lives in
 * diff-tracker.ts and is covered there; here we mock the tracker and assert the
 * gating/scoping this file is responsible for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/kai', getName: () => 'Kai' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

const listDiffsForConversation = vi.fn();
const getDiffText = vi.fn();
const revertDiff = vi.fn();
const revertToOp = vi.fn();
vi.mock('../diff-tracker.js', () => ({
  listDiffsForConversation: (...a: unknown[]) => listDiffsForConversation(...a),
  getDiffText: (...a: unknown[]) => getDiffText(...a),
  revertDiff: (...a: unknown[]) => revertDiff(...a),
  revertToOp: (...a: unknown[]) => revertToOp(...a),
}));

const isPathAllowed = vi.fn();
vi.mock('../file-access.js', () => ({
  isPathAllowed: (...a: unknown[]) => isPathAllowed(...a),
}));

import { createFileChangesTools } from '../file-changes.js';
import type { AppConfig } from '../../config/schema.js';
import type { ToolDefinition, ToolExecutionContext } from '../types.js';

const cfg = {} as AppConfig;
const ctx = (conversationId?: string): ToolExecutionContext =>
  ({ toolCallId: 't1', conversationId }) as ToolExecutionContext;

function tools(): { list: ToolDefinition; get: ToolDefinition; revert: ToolDefinition } {
  const [list, get, revert] = createFileChangesTools(() => cfg);
  return { list, get, revert };
}

const diff = (path: string) => ({
  path,
  additions: 1,
  deletions: 0,
  created: false,
  deleted: false,
  revertable: true,
  ops: [{ toolName: 'file_edit', additions: 1, deletions: 0, at: 0, snapshotAvailable: true }],
  unifiedDiff: `--- ${path}\n+++ ${path}\n`,
});

beforeEach(() => {
  vi.clearAllMocks();
  isPathAllowed.mockReturnValue({ allowed: true });
});

describe('file-changes tools require conversation scope', () => {
  it('every tool fails without a conversationId (no cross-chat / global access)', async () => {
    const { list, get, revert } = tools();
    expect(await list.execute({}, ctx(undefined))).toMatchObject({ ok: false });
    expect(await get.execute({ path: '/a' }, ctx(undefined))).toMatchObject({ ok: false });
    expect(await revert.execute({}, ctx(undefined))).toMatchObject({ ok: false });
    // The tracker must never be queried when scope is missing.
    expect(listDiffsForConversation).not.toHaveBeenCalled();
    expect(getDiffText).not.toHaveBeenCalled();
  });

  it('scopes tracker reads to the caller conversation id', async () => {
    listDiffsForConversation.mockReturnValue([diff('/w/a.ts')]);
    const { list } = tools();
    await list.execute({}, ctx('conv-42'));
    expect(listDiffsForConversation).toHaveBeenCalledWith('conv-42');
  });
});

describe('file-access policy is re-checked on every path', () => {
  it('list_file_changes filters out paths the policy now denies', async () => {
    listDiffsForConversation.mockReturnValue([diff('/w/allowed.ts'), diff('/w/denied.ts')]);
    isPathAllowed.mockImplementation((p: string) => ({ allowed: p === '/w/allowed.ts' }));
    const { list } = tools();
    const r = (await list.execute({}, ctx('c'))) as { ok: true; fileCount: number; files: { path: string }[] };
    expect(r.fileCount).toBe(1);
    expect(r.files.map((f) => f.path)).toEqual(['/w/allowed.ts']);
  });

  it('get_file_change refuses a now-denied path before reading the diff', async () => {
    isPathAllowed.mockReturnValue({ allowed: false });
    const { get } = tools();
    const r = (await get.execute({ path: '/w/secret.ts' }, ctx('c'))) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not currently allowed/i);
    expect(getDiffText).not.toHaveBeenCalled();
  });

  it('revert (single path) refuses a now-denied path before reverting', async () => {
    isPathAllowed.mockReturnValue({ allowed: false });
    const { revert } = tools();
    const r = (await revert.execute({ path: '/w/secret.ts' }, ctx('c'))) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(revertDiff).not.toHaveBeenCalled();
    expect(revertToOp).not.toHaveBeenCalled();
  });

  it('revert-ALL only reverts paths the policy still permits', async () => {
    listDiffsForConversation.mockReturnValue([diff('/w/ok.ts'), diff('/w/no.ts')]);
    isPathAllowed.mockImplementation((p: string) => ({ allowed: p === '/w/ok.ts' }));
    revertDiff.mockReturnValue({ success: true });
    const { revert } = tools();
    const r = (await revert.execute({}, ctx('c'))) as { ok: boolean; reverted: number };
    expect(r.reverted).toBe(1);
    expect(revertDiff).toHaveBeenCalledTimes(1);
    expect(revertDiff).toHaveBeenCalledWith('c', '/w/ok.ts');
    // The denied path was never handed to the tracker.
    expect(revertDiff).not.toHaveBeenCalledWith('c', '/w/no.ts');
  });
});

describe('revert_file_changes toOpIndex routing', () => {
  it('rejects toOpIndex when no single path is given (cannot target an op across all files)', async () => {
    const { revert } = tools();
    const r = (await revert.execute({ toOpIndex: 0 }, ctx('c'))) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/toOpIndex requires a single path/i);
    expect(revertToOp).not.toHaveBeenCalled();
    expect(revertDiff).not.toHaveBeenCalled();
  });

  it('routes to revertToOp with the path + index when both given (index forwarded verbatim)', async () => {
    revertToOp.mockReturnValue({ success: true });
    const { revert } = tools();
    await revert.execute({ path: '/w/a.ts', toOpIndex: -1 }, ctx('c'));
    expect(revertToOp).toHaveBeenCalledWith('c', '/w/a.ts', -1);
    expect(revertDiff).not.toHaveBeenCalled();
  });

  it('routes to revertDiff (full revert) for a single path without toOpIndex', async () => {
    revertDiff.mockReturnValue({ success: true });
    const { revert } = tools();
    await revert.execute({ path: '/w/a.ts' }, ctx('c'));
    expect(revertDiff).toHaveBeenCalledWith('c', '/w/a.ts');
    expect(revertToOp).not.toHaveBeenCalled();
  });
});

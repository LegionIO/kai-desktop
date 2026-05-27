/**
 * Round-trip tests for sub-agent lifecycle persistence
 * (electron/agent/subagent-status.ts) against the real Mastra `Memory`
 * class backed by an in-memory libsql store.
 *
 * The mock-based suite in `subagent-status.test.ts` proves call shape on
 * every platform. This file proves the *contract* between our helper and
 * Mastra's public `updateThread` API (merge semantics, title preservation,
 * etc.). If a future Mastra minor version changes how `updateThread`
 * handles the `metadata` argument (e.g. replace-vs-merge), one of these
 * will break before it ships.
 *
 * Why this lives in a `.darwin.test.ts` file:
 *
 *   `@mastra/libsql` loads platform-specific native bindings
 *   (`@libsql/darwin-{arm64,x64}`, `@libsql/linux-x64-gnu`, …) at
 *   module-evaluation time. A top-level
 *   `import { LibSQLStore } from '@mastra/libsql'` therefore crashes
 *   Linux CI with `Cannot find module '@libsql/darwin-x64'` *before*
 *   any `describe.skipIf(process.platform !== 'darwin')` guard can
 *   take effect.
 *
 *   `vitest.config.ts` (and its unit slice) excludes
 *   `**\/*.darwin.test.ts` on non-darwin runners. Kai ships macOS-only
 *   per `CLAUDE.md`, so the contract is exercised on every developer
 *   machine and on the `pr-mac-build` CI job.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import type { StorageThreadType } from '@mastra/core/memory';
import { updateSubagentStatus, __internal } from '../subagent-status.js';

describe('updateThread metadata round-trip — real adapter shape', () => {
  let memory: Memory;
  let counter = 0;
  const tid = (label: string) => `roundtrip-${label}-${++counter}`;

  async function seedThread(
    id: string,
    metadata: Record<string, unknown>,
    title = `sub-agent-task-${id}`,
  ): Promise<void> {
    await memory.saveThread({
      thread: {
        id,
        title,
        resourceId: 'test-resource',
        createdAt: new Date('2025-01-01T00:00:00Z'),
        updatedAt: new Date('2025-01-01T00:00:00Z'),
        metadata,
      } as StorageThreadType,
    });
  }

  beforeAll(() => {
    // `file::memory:?cache=shared` gives an in-memory libsql database scoped
    // to this connection — tables are created lazily on first use.
    const storage = new LibSQLStore({
      id: 'subagent-roundtrip-test',
      url: 'file::memory:?cache=shared',
    });
    memory = new Memory({
      storage,
      options: {
        lastMessages: 10,
        semanticRecall: false,
        workingMemory: { enabled: false },
      },
    });
  });

  afterAll(async () => {
    // LibSQL in-memory store is GC'd with the process; nothing to clean.
    // Defensive cast to `unknown` because Memory exposes no public close().
    const maybeCloseable = memory as unknown as { close?: () => Promise<void> };
    if (typeof maybeCloseable.close === 'function') {
      await maybeCloseable.close();
    }
  });

  it('writes subagent metadata that survives a getThreadById round-trip', async () => {
    const id = tid('basic');
    await seedThread(id, {});

    await updateSubagentStatus(memory, id, {
      status: 'running',
      parentThreadId: 'parent-7',
    });

    const fetched = await memory.getThreadById({ threadId: id });
    expect(fetched).not.toBeNull();
    const sub = (fetched!.metadata as Record<string, unknown>)[__internal.METADATA_KEY];
    expect(sub).toEqual({ status: 'running', parentThreadId: 'parent-7' });
  });

  it('merges subagent fields (parentThreadId from pending survives running update)', async () => {
    const id = tid('merge');
    await seedThread(id, {
      [__internal.METADATA_KEY]: { status: 'pending', parentThreadId: 'p1' },
    });

    await updateSubagentStatus(memory, id, { status: 'running' });

    const fetched = await memory.getThreadById({ threadId: id });
    const sub = (fetched!.metadata as Record<string, unknown>)[__internal.METADATA_KEY] as Record<string, unknown>;
    expect(sub.status).toBe('running');
    expect(sub.parentThreadId).toBe('p1');
  });

  it('preserves thread title across an updateSubagentStatus write', async () => {
    const id = tid('title');
    const originalTitle = 'sub-agent-task-analyse-repo';
    await seedThread(id, {}, originalTitle);

    await updateSubagentStatus(memory, id, { status: 'running' });

    const fetched = await memory.getThreadById({ threadId: id });
    expect(fetched!.title).toBe(originalTitle);
  });

  it('preserves non-subagent top-level metadata keys', async () => {
    const id = tid('foreign-meta');
    await seedThread(id, {
      ui: { color: 'red' },
      [__internal.METADATA_KEY]: { status: 'pending' },
    });

    await updateSubagentStatus(memory, id, { status: 'running' });

    const fetched = await memory.getThreadById({ threadId: id });
    const meta = fetched!.metadata as Record<string, unknown>;
    expect(meta.ui).toEqual({ color: 'red' });
    expect((meta[__internal.METADATA_KEY] as Record<string, unknown>).status).toBe('running');
  });

  it('composes multiple status updates (pending -> running -> completed) preserving earlier fields', async () => {
    const id = tid('compose');
    await seedThread(id, {
      [__internal.METADATA_KEY]: { status: 'pending', parentThreadId: 'p9' },
    });

    await updateSubagentStatus(memory, id, { status: 'running' });
    await updateSubagentStatus(memory, id, {
      status: 'completed',
      completedAt: '2025-02-02T12:00:00Z',
      exitReason: 'task_complete',
    });

    const fetched = await memory.getThreadById({ threadId: id });
    const sub = (fetched!.metadata as Record<string, unknown>)[__internal.METADATA_KEY];
    expect(sub).toEqual({
      status: 'completed',
      parentThreadId: 'p9',
      completedAt: '2025-02-02T12:00:00Z',
      exitReason: 'task_complete',
    });
  });

  it('skips write and warns when thread does not exist (no insert side-effect)', async () => {
    // Documents the discovered behavior: `Memory.updateThread` throws
    // "Thread X not found" for unknown ids, so the helper guards via
    // `getThreadById` first and never reaches the write path. Net effect:
    // the missing threadId stays missing — no implicit create.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await updateSubagentStatus(memory, 'roundtrip-never-existed', { status: 'running' });

    const fetched = await memory.getThreadById({ threadId: 'roundtrip-never-existed' });
    expect(fetched).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/thread roundtrip-never-existed not found/);
    warnSpy.mockRestore();
  });
});

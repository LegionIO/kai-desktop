/**
 * Tests for sub-agent lifecycle persistence (electron/agent/subagent-status.ts).
 *
 * Covers:
 *   - `updateSubagentStatus` calls `memory.updateThread` with merged metadata
 *   - FSM rejects illegal transitions (terminal -> running)
 *   - FSM accepts legal transitions (pending -> running -> completed)
 *   - `readSubagentStatus` returns metadata, returns `null` when thread missing
 *   - Non-sub-agent metadata on the thread is preserved across writes
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import type { StorageThreadType } from '@mastra/core/memory';
import { readSubagentStatus, updateSubagentStatus, __internal } from '../subagent-status.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeThread(id: string, metadata: Record<string, unknown> = {}, title = 'sub-agent task'): StorageThreadType {
  return {
    id,
    title,
    resourceId: 'test-resource',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    metadata,
  };
}

/**
 * Build a Memory mock backed by a Map of threads keyed by id. updateThread
 * mutates the map so subsequent getThreadById calls return the new state.
 */
function makeMemoryMock(seed: StorageThreadType[] = []) {
  const store = new Map<string, StorageThreadType>();
  for (const t of seed) store.set(t.id, t);

  const getThreadById = vi.fn(async ({ threadId }: { threadId: string }) => {
    return store.get(threadId) ?? null;
  });
  const updateThread = vi.fn(
    async ({ id, title, metadata }: { id: string; title: string; metadata: Record<string, unknown> }) => {
      const existing = store.get(id);
      if (!existing) throw new Error(`thread ${id} not found in mock`);
      const updated: StorageThreadType = {
        ...existing,
        title,
        metadata,
        updatedAt: new Date(),
      };
      store.set(id, updated);
      return updated;
    },
  );

  const memory = { getThreadById, updateThread } as unknown as Memory;
  return { memory, store, getThreadById, updateThread };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subagent-status helper', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('updateSubagentStatus', () => {
    it('writes merged metadata via memory.updateThread', async () => {
      const { memory, updateThread } = makeMemoryMock([makeThread('sub-1', {}, 'analyse repo')]);

      await updateSubagentStatus(memory, 'sub-1', {
        status: 'running',
        parentThreadId: 'parent-conv-7',
      });

      expect(updateThread).toHaveBeenCalledTimes(1);
      const call = updateThread.mock.calls[0][0];
      expect(call.id).toBe('sub-1');
      expect(call.title).toBe('analyse repo');
      expect(call.metadata).toEqual({
        [__internal.METADATA_KEY]: {
          status: 'running',
          parentThreadId: 'parent-conv-7',
        },
      });
    });

    it('preserves non-sub-agent metadata on the thread', async () => {
      const { memory, updateThread } = makeMemoryMock([
        makeThread('sub-2', { mastra: { internal: 'preserve me' }, anotherKey: 42 }),
      ]);

      await updateSubagentStatus(memory, 'sub-2', { status: 'running' });

      const written = updateThread.mock.calls[0][0].metadata as Record<string, unknown>;
      expect(written.mastra).toEqual({ internal: 'preserve me' });
      expect(written.anotherKey).toBe(42);
      expect(written[__internal.METADATA_KEY]).toEqual({ status: 'running' });
    });

    it('merges sub-agent fields across multiple writes (legal pending -> running -> completed)', async () => {
      const { memory, store } = makeMemoryMock([
        makeThread('sub-3', { [__internal.METADATA_KEY]: { status: 'pending', parentThreadId: 'p1' } }),
      ]);

      await updateSubagentStatus(memory, 'sub-3', { status: 'running' });
      await updateSubagentStatus(memory, 'sub-3', {
        status: 'completed',
        completedAt: '2025-02-02T12:00:00Z',
        exitReason: 'task_complete',
      });

      const finalMeta = store.get('sub-3')!.metadata as Record<string, unknown>;
      expect(finalMeta[__internal.METADATA_KEY]).toEqual({
        status: 'completed',
        parentThreadId: 'p1',
        completedAt: '2025-02-02T12:00:00Z',
        exitReason: 'task_complete',
      });
    });

    it('rejects illegal status transitions (completed -> running)', async () => {
      const { memory, updateThread } = makeMemoryMock([
        makeThread('sub-4', { [__internal.METADATA_KEY]: { status: 'completed' } }),
      ]);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await updateSubagentStatus(memory, 'sub-4', { status: 'running' });

      expect(updateThread).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalled();
      expect(errSpy.mock.calls[0][0]).toMatch(/Illegal status transition/);
    });

    it('rejects illegal status transitions from every terminal state', async () => {
      const terminals = ['completed', 'failed', 'abandoned', 'stopped'] as const;
      for (const start of terminals) {
        const { memory, updateThread } = makeMemoryMock([
          makeThread(`sub-${start}`, { [__internal.METADATA_KEY]: { status: start } }),
        ]);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await updateSubagentStatus(memory, `sub-${start}`, { status: 'running' });
        expect(updateThread, `terminal ${start} should reject`).not.toHaveBeenCalled();
      }
    });

    it('allows updating non-status fields without triggering FSM (running -> running w/ exitReason draft)', async () => {
      const { memory, updateThread } = makeMemoryMock([
        makeThread('sub-5', { [__internal.METADATA_KEY]: { status: 'running' } }),
      ]);

      await updateSubagentStatus(memory, 'sub-5', { parentThreadId: 'p9' });

      expect(updateThread).toHaveBeenCalledTimes(1);
      const meta = updateThread.mock.calls[0][0].metadata as Record<string, unknown>;
      expect(meta[__internal.METADATA_KEY]).toEqual({ status: 'running', parentThreadId: 'p9' });
    });

    it('skips write and warns when thread does not exist', async () => {
      const { memory, updateThread } = makeMemoryMock([]);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await updateSubagentStatus(memory, 'sub-missing', { status: 'running' });

      expect(updateThread).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0][0]).toMatch(/thread sub-missing not found/);
    });

    it('logs and swallows updateThread errors so callers are not blocked', async () => {
      const { memory } = makeMemoryMock([makeThread('sub-6')]);
      (memory.updateThread as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('storage offline'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(updateSubagentStatus(memory, 'sub-6', { status: 'running' })).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalled();
    });
  });

  describe('readSubagentStatus', () => {
    it('returns the sub-agent metadata when present', async () => {
      const { memory } = makeMemoryMock([
        makeThread('sub-7', {
          [__internal.METADATA_KEY]: { status: 'completed', exitReason: 'task_complete' },
        }),
      ]);

      const result = await readSubagentStatus(memory, 'sub-7');
      expect(result).toEqual({ status: 'completed', exitReason: 'task_complete' });
    });

    it('returns an empty object when thread exists but has no sub-agent metadata', async () => {
      const { memory } = makeMemoryMock([makeThread('sub-8', { other: 'data' })]);
      const result = await readSubagentStatus(memory, 'sub-8');
      expect(result).toEqual({});
    });

    it('returns null when the thread does not exist', async () => {
      const { memory } = makeMemoryMock([]);
      const result = await readSubagentStatus(memory, 'sub-nope');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Real-adapter round-trip — exercises the actual Mastra `Memory` class
  // backed by an in-memory libsql store. The mock-based tests above prove
  // call shape; these prove the *contract* between our helper and Mastra's
  // public `updateThread` API (merge semantics, title preservation, etc.).
  // If a future Mastra minor version changes how `updateThread` handles the
  // `metadata` argument (e.g. replace-vs-merge), one of these will break
  // before it ships.
  // -------------------------------------------------------------------------
  // Skipped on non-darwin runners: `@libsql/client` requires platform-specific
  // native bindings (`@libsql/darwin-{arm64,x64}` etc.) that aren't installed
  // on Linux CI runners. Kai is macOS-only per `CLAUDE.md`, so the contract
  // these tests guard against is exercised on every developer's machine
  // anyway. The 10 mock-based tests above cover the FSM, error paths, and
  // call-shape semantics on every platform.
  describe.skipIf(process.platform !== 'darwin')('updateThread metadata round-trip — real adapter shape', () => {
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
      const sub = (fetched!.metadata as Record<string, unknown>)[__internal.METADATA_KEY] as Record<
        string,
        unknown
      >;
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
});

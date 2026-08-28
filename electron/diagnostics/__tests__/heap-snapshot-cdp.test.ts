import { describe, expect, it } from 'vitest';
import { makeCdpHeapSnapshotTake, CdpCaptureUnavailableError } from '../heap-snapshot-cdp';
import type { CdpCaptureTarget, CdpDebugger } from '../heap-snapshot-cdp';

/** In-memory sink capturing written chunks; models the fs.WriteStream slice. */
function makeFakeSink() {
  const chunks: string[] = [];
  let errListener: ((err: Error) => void) | undefined;
  let ended = false;
  let destroyed = false;
  return {
    chunks,
    ended: () => ended,
    destroyed: () => destroyed,
    emitError: (err: Error) => errListener?.(err),
    sink: {
      write(chunk: string) {
        chunks.push(chunk);
      },
      end(cb: () => void) {
        ended = true;
        cb();
      },
      destroy() {
        destroyed = true;
      },
      on(_event: 'error', listener: (err: Error) => void) {
        errListener = listener;
      },
    },
  };
}

/** Fake CDP debugger. `onTakeSnapshot` drives what happens when the capture
 *  command is sent (emit chunks, resolve/reject, hang). */
function makeFakeDebugger(opts: { attached?: boolean; onTake?: (emitChunk: (s: string) => void) => Promise<void> }): {
  dbg: CdpDebugger;
  attachCalls: number;
  detachCalls: number;
} {
  let attached = opts.attached ?? false;
  let msgListener: ((event: unknown, method: string, params: unknown) => void) | undefined;
  const state = { attachCalls: 0, detachCalls: 0 };
  const emitChunk = (s: string) => msgListener?.({}, 'HeapProfiler.addHeapSnapshotChunk', { chunk: s });
  const dbg: CdpDebugger = {
    isAttached: () => attached,
    attach() {
      state.attachCalls += 1;
      attached = true;
    },
    detach() {
      state.detachCalls += 1;
      attached = false;
    },
    async sendCommand(method) {
      if (method === 'HeapProfiler.takeHeapSnapshot') {
        await (opts.onTake ?? (async (emit) => emit('{"snapshot":{}}')))(emitChunk);
      }
      return undefined;
    },
    on(_event, listener) {
      msgListener = listener;
    },
    off() {
      msgListener = undefined;
    },
  };
  return {
    dbg,
    get attachCalls() {
      return state.attachCalls;
    },
    get detachCalls() {
      return state.detachCalls;
    },
  };
}

function makeTarget(dbg: CdpDebugger, destroyed = false): CdpCaptureTarget {
  return { isDestroyed: () => destroyed, debugger: dbg };
}

describe('makeCdpHeapSnapshotTake', () => {
  it('streams chunks to the sink and flushes on success', async () => {
    const fake = makeFakeSink();
    const dbgs = makeFakeDebugger({
      onTake: async (emit) => {
        emit('{"snapshot":');
        emit('{"meta":{}}}');
      },
    });
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg), { createSink: () => fake.sink });

    await take('/tmp/snap.heapsnapshot');

    expect(fake.chunks.join('')).toBe('{"snapshot":{"meta":{}}}');
    expect(fake.ended()).toBe(true);
    expect(dbgs.attachCalls).toBe(1);
    // Always detaches after the capture — this is the un-wedge guard.
    expect(dbgs.detachCalls).toBe(1);
  });

  it('detaches even when the capture command rejects', async () => {
    const fake = makeFakeSink();
    const dbgs = makeFakeDebugger({
      onTake: async () => {
        throw new Error('protocol boom');
      },
    });
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg), { createSink: () => fake.sink });

    await expect(take('/tmp/snap.heapsnapshot')).rejects.toThrow('protocol boom');
    expect(dbgs.detachCalls).toBe(1); // detached in finally
    expect(fake.destroyed()).toBe(true); // partial sink cleaned up
  });

  it('rejects with CdpCaptureUnavailableError when the debugger is already attached', async () => {
    const fake = makeFakeSink();
    const dbgs = makeFakeDebugger({ attached: true });
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg), { createSink: () => fake.sink });

    await expect(take('/tmp/snap.heapsnapshot')).rejects.toBeInstanceOf(CdpCaptureUnavailableError);
    // Never attach/detach a session we didn't own.
    expect(dbgs.attachCalls).toBe(0);
    expect(dbgs.detachCalls).toBe(0);
  });

  it('rejects without attaching when the target is already destroyed', async () => {
    const fake = makeFakeSink();
    const dbgs = makeFakeDebugger({});
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg, true), { createSink: () => fake.sink });

    await expect(take('/tmp/snap.heapsnapshot')).rejects.toBeInstanceOf(CdpCaptureUnavailableError);
    expect(dbgs.attachCalls).toBe(0);
  });

  it('surfaces a stream error rather than reporting success', async () => {
    const fake = makeFakeSink();
    const dbgs = makeFakeDebugger({
      onTake: async (emit) => {
        emit('partial');
      },
    });
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg), { createSink: () => fake.sink });

    // Fire the sink error before the take resolves.
    const p = take('/tmp/snap.heapsnapshot');
    fake.emitError(new Error('ENOSPC disk full'));
    await expect(p).rejects.toThrow(/ENOSPC/);
    expect(dbgs.detachCalls).toBe(1);
  });
});

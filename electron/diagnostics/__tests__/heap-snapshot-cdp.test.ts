import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeCdpHeapSnapshotTake, CdpCaptureUnavailableError } from '../heap-snapshot-cdp';
import type { CdpCaptureTarget, CdpDebugger } from '../heap-snapshot-cdp';

/** In-memory sink modeling the fs.WriteStream slice we depend on. `writeOk`
 *  controls backpressure (false = buffer full); `writableLength` accumulates the
 *  bytes written while backpressured, modeling a real stalled backlog. */
function makeFakeSink(opts: { writeOk?: boolean; endErr?: Error; closeErr?: Error } = {}) {
  const chunks: string[] = [];
  const listeners: Record<string, Array<(err?: Error) => void>> = { error: [], drain: [], close: [] };
  let ended = false;
  let destroyed = false;
  let backlog = 0;
  const emit = (event: string, err?: Error) => listeners[event]?.forEach((l) => l(err));
  return {
    chunks,
    ended: () => ended,
    destroyed: () => destroyed,
    emit,
    sink: {
      write(chunk: string) {
        chunks.push(chunk);
        const ok = opts.writeOk ?? true;
        // A real Writable accumulates unflushed bytes in writableLength while
        // it's above the high-water mark.
        if (!ok) backlog += Buffer.byteLength(chunk, 'utf8');
        return ok;
      },
      get writableLength() {
        return backlog;
      },
      end(cb: (err?: Error | null) => void) {
        ended = true;
        cb(opts.endErr ?? null);
        // fs streams emit 'close' just after end() flushes. A close-time error
        // (e.g. late fsync failure) arrives right before 'close'.
        setTimeout(() => {
          if (opts.closeErr) emit('error', opts.closeErr);
          emit('close');
        }, 0);
      },
      destroy() {
        destroyed = true;
        // fs streams emit 'close' asynchronously after destroy.
        setTimeout(() => emit('close'), 0);
      },
      on(event: 'error' | 'drain' | 'close', listener: (err?: Error) => void) {
        listeners[event]?.push(listener);
      },
      off(event: 'error' | 'drain' | 'close', listener: (err?: Error) => void) {
        listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener);
      },
    },
  };
}

/** Fake CDP debugger. `onTake` drives what happens when the capture command is
 *  sent (emit chunks, resolve/reject, hang). */
function makeFakeDebugger(opts: {
  attached?: boolean;
  onTake?: (emitChunk: (s: string) => void, emitDetach: () => void) => Promise<void>;
  /** Fire the 'detach' listeners synchronously from inside attach() — models a
   *  reentrant external detach (DevTools open / target close) during attach. */
  detachDuringAttach?: boolean;
}): {
  dbg: CdpDebugger;
  attachCalls: () => number;
  detachCalls: () => number;
} {
  let attached = opts.attached ?? false;
  const msgListeners: Array<(...args: unknown[]) => void> = [];
  const detachListeners: Array<(...args: unknown[]) => void> = [];
  const state = { attachCalls: 0, detachCalls: 0 };
  const emitChunk = (s: string) =>
    msgListeners.forEach((l) => l({}, 'HeapProfiler.addHeapSnapshotChunk', { chunk: s }));
  const emitDetach = () => {
    attached = false;
    detachListeners.forEach((l) => l({}, 'target closed'));
  };
  const dbg: CdpDebugger = {
    isAttached: () => attached,
    attach() {
      state.attachCalls += 1;
      attached = true;
      if (opts.detachDuringAttach) emitDetach();
    },
    detach() {
      state.detachCalls += 1;
      attached = false;
    },
    async sendCommand(method) {
      if (method === 'HeapProfiler.takeHeapSnapshot') {
        await (opts.onTake ?? (async (emit) => emit('{"snapshot":{}}')))(emitChunk, emitDetach);
      }
      return undefined;
    },
    on(event, listener) {
      if (event === 'message') msgListeners.push(listener);
      else if (event === 'detach') detachListeners.push(listener);
    },
    off(event, listener) {
      if (event === 'message') {
        const i = msgListeners.indexOf(listener);
        if (i >= 0) msgListeners.splice(i, 1);
      } else if (event === 'detach') {
        const i = detachListeners.indexOf(listener);
        if (i >= 0) detachListeners.splice(i, 1);
      }
    },
  };
  return { dbg, attachCalls: () => state.attachCalls, detachCalls: () => state.detachCalls };
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
    expect(dbgs.attachCalls()).toBe(1);
    // Always detaches after the capture — this is the un-wedge guard.
    expect(dbgs.detachCalls()).toBe(1);
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
    expect(dbgs.detachCalls()).toBe(1); // detached in cleanup
    expect(fake.destroyed()).toBe(true); // partial sink cleaned up
  });

  it('rejects with CdpCaptureUnavailableError when the debugger is already attached', async () => {
    const fake = makeFakeSink();
    const dbgs = makeFakeDebugger({ attached: true });
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg), { createSink: () => fake.sink });

    await expect(take('/tmp/snap.heapsnapshot')).rejects.toBeInstanceOf(CdpCaptureUnavailableError);
    // Never attach/detach a session we didn't own.
    expect(dbgs.attachCalls()).toBe(0);
    expect(dbgs.detachCalls()).toBe(0);
  });

  it('rejects without attaching when the target is already destroyed', async () => {
    const fake = makeFakeSink();
    const dbgs = makeFakeDebugger({});
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg, true), { createSink: () => fake.sink });

    await expect(take('/tmp/snap.heapsnapshot')).rejects.toBeInstanceOf(CdpCaptureUnavailableError);
    expect(dbgs.attachCalls()).toBe(0);
  });

  it('rejects a POST-attach destruction with a PLAIN error (not CdpCaptureUnavailableError)', async () => {
    // The sink is already open by the time we re-check isDestroyed() after
    // attach — so this is a POST-OPEN failure and must NOT be classified as
    // "never created the file" (which would make the caller skip deleting our
    // 0-byte partial). It must be a plain Error, and we must detach (we owned it).
    const fake = makeFakeSink();
    let destroyed = false;
    const dbgs = makeFakeDebugger({});
    // Flip destroyed=true the moment we attach, so the post-attach check trips.
    const target: CdpCaptureTarget = {
      isDestroyed: () => destroyed,
      debugger: {
        ...dbgs.dbg,
        attach: (v?: string) => {
          dbgs.dbg.attach(v);
          destroyed = true;
        },
      },
    };
    const take = makeCdpHeapSnapshotTake(target, { createSink: () => fake.sink });

    const err = await take('/tmp/snap.heapsnapshot').then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CdpCaptureUnavailableError);
    expect(String(err.message)).toMatch(/destroyed during attach/);
    expect(dbgs.detachCalls()).toBe(1); // we owned the session → detached
  });

  it('does NOT re-detach when an external detach fires DURING attach()', async () => {
    // The detach event can arrive synchronously inside attach() (a reentrant
    // DevTools-open / target-close). onDetach clears ownership; the post-attach
    // `owned = true` must NOT re-claim it, or cleanup would detach a session we
    // no longer own.
    const fake = makeFakeSink();
    const dbgs = makeFakeDebugger({ detachDuringAttach: true });
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg), {
      createSink: () => fake.sink,
      nativeSettleGraceMs: 10,
    });

    await expect(take('/tmp/snap.heapsnapshot')).rejects.toThrow(/detached/);
    // The in-attach detach dropped ownership → we must NOT call detach() again.
    expect(dbgs.detachCalls()).toBe(0);
  });

  it('detaches and rejects immediately when the sink errors mid-capture', async () => {
    const fake = makeFakeSink();
    let detachedDuringTake = false;
    const dbgs = makeFakeDebugger({
      onTake: async (emit) => {
        emit('partial');
        fake.emit('error', new Error('ENOSPC disk full'));
        // A well-behaved capture is torn down by the error → by the time the
        // command "would" continue, we should already have detached.
      },
    });
    const target = makeTarget(dbgs.dbg);
    const take = makeCdpHeapSnapshotTake(target, { createSink: () => fake.sink });

    await expect(take('/tmp/snap.heapsnapshot')).rejects.toThrow(/ENOSPC/);
    detachedDuringTake = dbgs.detachCalls() === 1;
    expect(detachedDuringTake).toBe(true);
  });

  it('propagates an error surfaced by the end() callback', async () => {
    const fake = makeFakeSink({ endErr: new Error('EIO final write') });
    const dbgs = makeFakeDebugger({ onTake: async (emit) => emit('{}') });
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg), { createSink: () => fake.sink });

    await expect(take('/tmp/snap.heapsnapshot')).rejects.toThrow(/EIO final write/);
    expect(dbgs.detachCalls()).toBe(1);
  });

  it('aborts (detaches) when the abort signal fires', async () => {
    const fake = makeFakeSink();
    const ac = new AbortController();
    const dbgs = makeFakeDebugger({
      onTake: async (emit) => {
        emit('chunk-1');
        ac.abort(); // simulate the outer timeout aborting mid-capture
        // hang a little so the abort handler runs before we resolve
        await new Promise((r) => setTimeout(r, 5));
      },
    });
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg), { createSink: () => fake.sink });

    await expect(take('/tmp/snap.heapsnapshot', ac.signal)).rejects.toThrow(/aborted/);
    expect(dbgs.detachCalls()).toBe(1);
  });

  it('rejects fast when the signal is already aborted', async () => {
    const fake = makeFakeSink();
    const dbgs = makeFakeDebugger({});
    const ac = new AbortController();
    ac.abort();
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg), { createSink: () => fake.sink });

    await expect(take('/tmp/snap.heapsnapshot', ac.signal)).rejects.toBeInstanceOf(CdpCaptureUnavailableError);
    expect(dbgs.attachCalls()).toBe(0);
  });

  it('aborts when sink backpressure exceeds the cap', async () => {
    // write() always returns false (buffer full) and 'drain' never fires, so
    // pending bytes accumulate past the small cap → capture aborts + detaches.
    const fake = makeFakeSink({ writeOk: false });
    const dbgs = makeFakeDebugger({
      onTake: async (emit) => {
        emit('x'.repeat(200));
        emit('y'.repeat(200));
      },
    });
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg), {
      createSink: () => fake.sink,
      maxPendingBytes: 256,
    });

    await expect(take('/tmp/snap.heapsnapshot')).rejects.toThrow(/backpressure/);
    expect(dbgs.detachCalls()).toBe(1);
  });

  it('does NOT abort a backpressured capture whose real backlog stays under the cap', async () => {
    // write() returns false (above high-water mark) on EVERY chunk, but the
    // stream keeps draining so writableLength stays small. The abort must key on
    // the REAL buffered bytes (writableLength), not a cumulative running total —
    // otherwise a healthy multi-GB capture would falsely trip. Here a sink that
    // always reports writableLength=100 must let many false-write chunks through.
    let closeCount = 0;
    const chunks: string[] = [];
    const listeners: Record<string, Array<(err?: Error) => void>> = { error: [], drain: [], close: [] };
    const emit = (e: string) => listeners[e]?.forEach((l) => l());
    const constBacklogSink = {
      write(c: string) {
        chunks.push(c);
        return false; // always "buffer full"
      },
      get writableLength() {
        return 100; // real backlog is tiny + constant (stream is draining)
      },
      end(cb: (err?: Error | null) => void) {
        cb(null);
        setTimeout(() => {
          closeCount++;
          emit('close');
        }, 0);
      },
      destroy() {
        setTimeout(() => emit('close'), 0);
      },
      on(e: 'error' | 'drain' | 'close', l: (err?: Error) => void) {
        listeners[e]?.push(l);
      },
      off() {},
    };
    const dbgs = makeFakeDebugger({
      onTake: async (emit2) => {
        for (let i = 0; i < 50; i++) emit2('z'.repeat(1000)); // 50 KB cumulative
      },
    });
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg), {
      createSink: () => constBacklogSink as never,
      maxPendingBytes: 256, // far below the 50 KB cumulative, but writableLength=100 < 256
    });

    await take('/tmp/snap.heapsnapshot'); // resolves — no false backpressure abort
    expect(chunks.length).toBe(50);
    expect(closeCount).toBe(1);
    expect(dbgs.detachCalls()).toBe(1);
  });

  it('does not re-detach an externally-detached session', async () => {
    const fake = makeFakeSink();
    const dbgs = makeFakeDebugger({
      onTake: async (emit, emitDetach) => {
        emit('chunk');
        emitDetach(); // DevTools opened / target closed → external detach
        await new Promise((r) => setTimeout(r, 5));
      },
    });
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg), { createSink: () => fake.sink });

    await expect(take('/tmp/snap.heapsnapshot')).rejects.toThrow(/detached/);
    // The external detach already dropped the session; we must NOT call detach()
    // ourselves (which could tear down a newer consumer's session).
    expect(dbgs.detachCalls()).toBe(0);
  });

  it('rejects (does not hang) when the CDP command never settles after abort', async () => {
    // The core R2 fix: if sendCommand never resolves NOR rejects (renderer wedged,
    // detach doesn't settle the pending command), an abort must still unwind take()
    // via the fatal-race — otherwise take() would stay pending forever, leaking the
    // fd and never releasing the monitor's single-flight fence. The native-settle
    // grace (R15) bounds how long we hold before releasing when the command never
    // settles; use a tiny grace here so the test is fast.
    const fake = makeFakeSink();
    const ac = new AbortController();
    const dbgs = makeFakeDebugger({
      onTake: () =>
        new Promise<void>(() => {
          // never settles
        }),
    });
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg), {
      createSink: () => fake.sink,
      nativeSettleGraceMs: 10,
    });

    const p = take('/tmp/snap.heapsnapshot', ac.signal);
    // Abort after the capture command is in flight (and hung).
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toThrow(/aborted/);
    expect(dbgs.detachCalls()).toBe(1); // detached on abort
    expect(fake.destroyed()).toBe(true); // sink torn down
  });

  it('holds until the native command settles before rejecting on abort (fence integrity)', async () => {
    // R15: take() must NOT reject (which frees the caller's single-flight fence)
    // while the native sendCommand is still pending — a retry could then start a
    // 2nd concurrent snapshot. Here the native command settles 50ms AFTER abort;
    // take() must not reject until then (grace is large so the command wins).
    const fake = makeFakeSink();
    const ac = new AbortController();
    let nativeSettled = false;
    const dbgs = makeFakeDebugger({
      onTake: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            nativeSettled = true;
            resolve();
          }, 50);
        }),
    });
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg), {
      createSink: () => fake.sink,
      nativeSettleGraceMs: 2000, // large: the native settle should win, not the grace
    });

    const p = take('/tmp/snap.heapsnapshot', ac.signal);
    setTimeout(() => ac.abort(), 5); // abort well before the native settles
    await expect(p).rejects.toThrow(/aborted/);
    // By the time take() rejected, the native command had actually settled — the
    // fence was held, not released early.
    expect(nativeSettled).toBe(true);
  });

  it('prefers the recorded fatal (ENOSPC) over a raced detach-derived error', async () => {
    // When the sink errors mid-capture, setFatal(ENOSPC) detaches, which may make
    // the abandoned sendCommand reject with a generic "detached" error. take() must
    // throw the ENOSPC (what the caller's disk-space eviction/retry keys on), not
    // the generic one.
    const fake = makeFakeSink();
    const dbgs = makeFakeDebugger({
      onTake: (emit) =>
        new Promise<void>((_resolve, reject) => {
          emit('partial');
          fake.emit('error', new Error('ENOSPC no space left'));
          // Simulate detach making the command reject with a generic error.
          setTimeout(() => reject(new Error('target detached')), 5);
        }),
    });
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg), { createSink: () => fake.sink });

    await expect(take('/tmp/snap.heapsnapshot')).rejects.toThrow(/ENOSPC/);
  });

  it('rejects when a close-time error arrives after end() succeeded', async () => {
    // end()'s callback reports success, but the stream then emits an error just
    // before 'close' (e.g. a late fsync failure). The capture must NOT be
    // reported successful — the post-end close+fatal re-check catches it.
    const fake = makeFakeSink({ closeErr: new Error('EIO close-time flush') });
    const dbgs = makeFakeDebugger({ onTake: async (emit) => emit('{}') });
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg), { createSink: () => fake.sink });

    await expect(take('/tmp/snap.heapsnapshot')).rejects.toThrow(/EIO close-time/);
  });
});

describe('makeCdpHeapSnapshotTake default sink (real fs)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kai-cdp-sink-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the snapshot 0600 via the real O_EXCL|O_NOFOLLOW sink', async () => {
    const dbgs = makeFakeDebugger({ onTake: async (emit) => emit('{"ok":1}') });
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg)); // no injected sink → real fs
    const path = join(dir, 'heap-real.heapsnapshot');

    await take(path);

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('{"ok":1}');
  });

  it('refuses to write through a pre-existing symlink at the target path', async () => {
    // A pre-planted symlink named like the (predictable) snapshot path must NOT
    // be followed + its target truncated. O_EXCL|O_NOFOLLOW makes the open fail.
    const secret = join(dir, 'secret');
    writeFileSync(secret, 'do-not-touch');
    const linkPath = join(dir, 'heap-attack.heapsnapshot');
    symlinkSync(secret, linkPath);
    const dbgs = makeFakeDebugger({ onTake: async (emit) => emit('{}') });
    const take = makeCdpHeapSnapshotTake(makeTarget(dbgs.dbg));

    await expect(take(linkPath)).rejects.toBeTruthy();
    // The symlink's target is untouched — never followed/truncated.
    expect(readFileSync(secret, 'utf8')).toBe('do-not-touch');
    // We never attached a debugger for a capture that couldn't even open its sink.
    expect(dbgs.detachCalls()).toBe(0);
  });
});

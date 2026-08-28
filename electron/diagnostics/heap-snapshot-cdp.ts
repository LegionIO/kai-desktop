/**
 * CDP-streamed renderer heap-snapshot capture.
 *
 * WHY THIS EXISTS (2026-08-28): the previous capture path called
 * `webContents.takeHeapSnapshot(filePath)`, which runs V8's HeapProfiler
 * serializer INSIDE the renderer process and materializes the whole snapshot
 * before writing it out. On a multi-GB live heap that transiently ~doubles the
 * renderer's RSS and blocks its main thread. The observed crash: the heartbeat
 * fired a capture at ~62% heap, `takeHeapSnapshot` never settled within the 30s
 * bound, and the renderer went down with SIGTRAP — i.e. the DIAGNOSTIC crashed
 * the app it was meant to observe, and every `.heapsnapshot` on disk was 0 bytes
 * (it never once succeeded).
 *
 * The Chrome DevTools Protocol `HeapProfiler.takeHeapSnapshot` instead STREAMS
 * the snapshot out incrementally as `HeapProfiler.addHeapSnapshotChunk` events.
 * We append each chunk to a write stream, honoring the stream's backpressure so
 * the main process does not accumulate the whole snapshot in a buffer (which
 * would just move the OOM to main). We attach the debugger, drive the capture,
 * and ALWAYS detach — on success, on error, and on abort/timeout — because
 * detach is what cancels an in-progress serialization and un-wedges the target.
 *
 * IMPORTANT — this is a HARM-REDUCTION, not a guarantee: V8 still builds the
 * snapshot graph inside the target's heap before/while streaming, so a capture
 * on a very large heap is not free and can still add pressure. The trigger floor
 * (window-health) keeps auto-capture rare; this module keeps a capture that DOES
 * run from wedging the process (bounded buffer + abortable + always-detach).
 *
 * This module exposes a `take(filePath, signal?)` seam compatible with
 * {@link captureHeapSnapshot} in heap-snapshot.ts, so all the existing
 * retention / timeout / single-flight-fence policy is reused unchanged. The
 * timeout in captureHeapSnapshot aborts `signal`, which detaches + tears down
 * here rather than merely abandoning the promise.
 */
import { createWriteStream, openSync, constants as fsConstants } from 'fs';

/** Minimal debugger surface we use — kept structural so tests can fake it. */
export interface CdpDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
  on(event: 'message' | 'detach', listener: (...args: unknown[]) => void): void;
  off(event: 'message' | 'detach', listener: (...args: unknown[]) => void): void;
}

/** The slice of WebContents this capturer needs. */
export interface CdpCaptureTarget {
  isDestroyed(): boolean;
  readonly debugger: CdpDebugger;
}

/** Node writable-stream slice we depend on (injectable for tests). */
interface ChunkSink {
  /** Returns false when the internal buffer is full (backpressure). */
  write(chunk: string): boolean;
  end(cb: (err?: Error | null) => void): void;
  /** Destroy the stream; `cb` fires on 'close'. */
  destroy(err?: Error): void;
  on(event: 'error' | 'drain' | 'close', listener: (err?: Error) => void): void;
  off?(event: 'error' | 'drain' | 'close', listener: (err?: Error) => void): void;
  /** Bytes CURRENTLY buffered but not yet flushed (Writable.writableLength).
   *  Used to bound the real backlog, not cumulative traffic. */
  readonly writableLength?: number;
}

export interface CdpCaptureDeps {
  /** Factory for the on-disk sink. Defaults to a 0600 fs.createWriteStream. */
  createSink?: (filePath: string) => ChunkSink;
  /** Max bytes allowed to sit unflushed in the sink before we abort the capture
   *  rather than let the main-process buffer grow unbounded. Default 64 MiB. */
  maxPendingBytes?: number;
}

/**
 * Thrown when the target is unusable BEFORE any debugger work — a destroyed
 * webContents, or a debugger already attached by something else (DevTools open,
 * another capturer). Distinct so the caller can log it as a skipped capture
 * rather than a hard failure; NOT a disk-space error, so the evict-and-retry
 * loop in captureHeapSnapshot correctly skips it.
 */
export class CdpCaptureUnavailableError extends Error {
  constructor(reason: string) {
    super(`heap snapshot capture unavailable: ${reason}`);
    this.name = 'CdpCaptureUnavailableError';
  }
}

const CHUNK_EVENT = 'HeapProfiler.addHeapSnapshotChunk';
const DEFAULT_MAX_PENDING_BYTES = 64 * 1024 * 1024;

/**
 * Build a `take(filePath, signal?)` function that captures the renderer heap via
 * CDP and streams it to `filePath`. The returned function resolves when the full
 * snapshot has been flushed to disk, or rejects on any protocol/stream/abort
 * error. On EVERY exit path it removes its 'message'/'detach' listeners and
 * detaches the debugger (when it still owns the session) — detach cancels an
 * in-progress serialization, which is what makes an aborted/timed-out capture
 * safe.
 */
export function makeCdpHeapSnapshotTake(
  target: CdpCaptureTarget,
  deps: CdpCaptureDeps = {},
): (filePath: string, signal?: AbortSignal) => Promise<void> {
  // Default sink: open the fd ourselves with O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW
  // rather than let createWriteStream use flags:'w' (which FOLLOWS a symlink and
  // TRUNCATES its target). The path is somewhat predictable (timestamp + small
  // random suffix), so a pre-planted symlink there could otherwise redirect our
  // write. O_EXCL fails if the path already exists (symlink or file); O_NOFOLLOW
  // fails if the final component is a symlink. Mode 0600. On the rare same-name
  // collision the capture fails cleanly and the caller re-arms.
  const createSink =
    deps.createSink ??
    ((p: string) => {
      const fd = openSync(
        p,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      return createWriteStream('', { fd, encoding: 'utf8' }) as unknown as ChunkSink;
    });
  const maxPendingBytes = deps.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;

  return async (filePath: string, signal?: AbortSignal): Promise<void> => {
    if (target.isDestroyed()) {
      throw new CdpCaptureUnavailableError('webContents destroyed');
    }
    const dbg = target.debugger;
    // If a debugger is already attached (DevTools, another tool, an earlier
    // capture that didn't detach), do NOT hijack it — attaching would throw and
    // detaching at the end would kill the OTHER consumer's session. Skip.
    if (dbg.isAttached()) {
      throw new CdpCaptureUnavailableError('debugger already attached');
    }
    if (signal?.aborted) {
      throw new CdpCaptureUnavailableError('aborted before start');
    }

    let sink: ChunkSink | null = null;
    // Resolves when the sink emits 'close'. Registered at sink creation so a
    // synchronous close during destroy() is never missed.
    let sinkClosed: Promise<void> | null = null;
    let onMessage: ((...args: unknown[]) => void) | null = null;
    let onDetach: ((...args: unknown[]) => void) | null = null;
    let onAbort: (() => void) | null = null;
    // First fatal condition (stream error, backpressure overflow, abort, or an
    // external detach). Once set, the capture is doomed → reject with it.
    let fatal: Error | null = null;
    // We own the debugger session only between our attach() and our detach().
    // An external `detach` event (DevTools opened, target closed) flips this so
    // cleanup does NOT detach a session we no longer own.
    let owned = false;
    // Rejects the moment a fatal condition is recorded, so the capture flow can
    // race it against `sendCommand` and unwind IMMEDIATELY even when the native
    // command never settles after detach (the hung-capture case the timeout must
    // handle). Without this the flow would sit awaiting a promise that never
    // settles, leaving take() pending forever.
    let rejectFatal: ((err: Error) => void) | null = null;
    const fatalPromise = new Promise<never>((_, reject) => {
      rejectFatal = reject;
    });
    // Never let an unraced fatalPromise surface as an unhandled rejection (when
    // the capture succeeds, nothing awaits it).
    fatalPromise.catch(() => {});

    const setFatal = (err: Error): void => {
      const first = !fatal;
      if (first) fatal = err;
      // Detach IMMEDIATELY on a fatal condition so the renderer stops serializing
      // instead of grinding until the outer timeout.
      if (owned) {
        owned = false;
        try {
          dbg.detach();
        } catch {
          /* best-effort */
        }
      }
      // Reject the race promise so the awaiting capture flow unwinds now.
      if (first && rejectFatal) {
        const rej = rejectFatal;
        rejectFatal = null;
        rej(err);
      }
    };

    const cleanup = (): void => {
      if (onMessage) {
        try {
          dbg.off('message', onMessage);
        } catch {
          /* best-effort */
        }
        onMessage = null;
      }
      if (onDetach) {
        try {
          dbg.off('detach', onDetach);
        } catch {
          /* best-effort */
        }
        onDetach = null;
      }
      if (onAbort && signal) {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          /* best-effort */
        }
        onAbort = null;
      }
      if (owned) {
        owned = false;
        try {
          dbg.detach();
        } catch {
          /* best-effort */
        }
      }
    };

    // Destroy the sink and wait for its 'close' so the caller's post-reject
    // unlink can't race an async file open/flush into a zero-byte orphan. Awaits
    // the close promise registered at sink creation (below) rather than adding a
    // 'close' listener HERE — the stream can emit 'close' synchronously during
    // destroy(), before a late-added listener would see it, so registering the
    // listener up front is the only race-free way to observe it.
    const destroySinkAndClose = (): Promise<void> => {
      const s = sink;
      if (!s || !sinkClosed) return Promise.resolve();
      sink = null;
      try {
        s.destroy();
      } catch {
        /* best-effort */
      }
      // Safety net: never hang forever waiting for 'close'.
      return Promise.race([
        sinkClosed,
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 2000);
          (t as { unref?: () => void }).unref?.();
        }),
      ]);
    };

    try {
      sink = createSink(filePath);
      // Register the close/error completion promise IMMEDIATELY, so a synchronous
      // 'close' during destroy() (or a late close-time error) is always observed.
      sinkClosed = new Promise<void>((resolve) => {
        const done = (): void => resolve();
        sink!.on('close', done);
        // A close-time error still ends in 'close'; also capture it as fatal so a
        // late write/close failure is never mistaken for a successful capture.
        sink!.on('error', (err) => setFatal(err instanceof Error ? err : new Error(String(err))));
      });

      // Abort (timeout from captureHeapSnapshot, or caller cancel) → detach now.
      if (signal) {
        onAbort = () => setFatal(new Error('heap snapshot capture aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        // Close the race between the earlier `signal.aborted` check and adding
        // the listener: if the abort fired in that window, the `{ once: true }`
        // listener never runs, so re-check here and route it through setFatal.
        if (signal.aborted) setFatal(new Error('heap snapshot capture aborted'));
      }

      // External detach (DevTools opened, target closed) — we no longer own the
      // session; do NOT re-detach it in cleanup, and treat the capture as failed.
      onDetach = () => {
        owned = false;
        setFatal(new Error('debugger detached during capture'));
      };
      dbg.on('detach', onDetach);

      // Collect every snapshot chunk into the sink, honoring backpressure.
      onMessage = (...args: unknown[]): void => {
        const method = args[1] as string | undefined;
        const params = args[2];
        if (method !== CHUNK_EVENT || fatal || !sink) return;
        const chunk = (params as { chunk?: unknown } | null | undefined)?.chunk;
        if (typeof chunk !== 'string') return;
        try {
          const ok = sink.write(chunk);
          if (!ok) {
            // Backpressure: the sink is above its high-water mark. Bound the
            // capture on the ACTUAL currently-buffered bytes (writableLength),
            // NOT a cumulative counter — write() keeps returning false while the
            // backlog drains, so a running-total would falsely trip on a healthy
            // multi-GB capture whose real backlog stays small. Abort only when
            // the true unflushed backlog exceeds the cap. If writableLength is
            // unavailable (a fake sink), fall back to the incoming chunk size as
            // a conservative floor rather than an unbounded sum.
            const buffered =
              typeof sink.writableLength === 'number' ? sink.writableLength : Buffer.byteLength(chunk, 'utf8');
            if (buffered > maxPendingBytes) {
              setFatal(new Error(`heap snapshot sink backpressure exceeded ${maxPendingBytes} bytes`));
            }
          }
        } catch (err) {
          setFatal(err instanceof Error ? err : new Error(String(err)));
        }
      };
      dbg.on('message', onMessage);

      if (fatal) throw fatal;
      dbg.attach('1.3');
      owned = true;

      // Re-check after attach: attaching can race a renderer teardown or a
      // late-arriving abort.
      if (target.isDestroyed()) {
        throw new CdpCaptureUnavailableError('webContents destroyed during attach');
      }
      if (fatal) throw fatal;

      // Drive the capture. Resolves once the renderer has emitted all chunks.
      // RACE it against fatalPromise so an abort / stream error / external detach
      // unwinds this function IMMEDIATELY even if the native command never
      // settles after we detach (the hung-capture case). The abandoned
      // sendCommand's own rejection is swallowed so it never surfaces unhandled.
      const capture = dbg.sendCommand('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      capture.catch(() => {});
      await Promise.race([capture, fatalPromise]);

      if (fatal) throw fatal;

      // Flush the sink and wait for the OS write to complete. end()'s callback
      // receives any final-write error (e.g. ENOSPC) — honor it rather than
      // reporting a partial file as success. Race fatalPromise so a late error
      // still unwinds if end() never calls back.
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          const s = sink;
          if (!s) {
            reject(fatal ?? new Error('heap snapshot sink missing'));
            return;
          }
          s.end((err) => {
            if (err) reject(err instanceof Error ? err : new Error(String(err)));
            else if (fatal) reject(fatal);
            else resolve();
          });
        }),
        fatalPromise,
      ]);
      // end()'s callback fired without error, but the stream emits 'close' just
      // after — and a close-time error (registered as fatal above) can still
      // arrive. Await close, then re-check fatal so a late failure is never
      // reported as a successful capture. Race fatalPromise only (NOT a silent
      // success timeout): a silent timeout could resolve success before a
      // late close error surfaced. The outer captureHeapSnapshot timeout aborts
      // the signal — which rejects fatalPromise — if 'close' never arrives, so a
      // wedged stream still can't hang this indefinitely.
      const closed = sinkClosed;
      if (closed) {
        await Promise.race([closed, fatalPromise]);
      }
      if (fatal) throw fatal;
      // Closed cleanly; nothing to destroy below.
      sink = null;
      cleanup();
    } catch (err) {
      cleanup();
      // Wait for the sink to fully close before returning, so the caller's
      // partial-file removal doesn't race a pending open/flush.
      await destroySinkAndClose();
      // Prefer the FIRST recorded fatal error over a raced/derived one: when a
      // sink ENOSPC triggers our detach, the abandoned sendCommand may reject
      // with a generic "target detached" error that would win the race — but the
      // caller's disk-space eviction/retry path keys on the real ENOSPC. Throw
      // the recorded fatal when present.
      const toThrow = fatal ?? (err instanceof Error ? err : new Error(String(err)));
      throw toThrow;
    }
  };
}

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
 * We append each chunk to a write stream, so no giant snapshot string is built
 * on the JS heap and the renderer's RSS does not double — an external
 * watchdog/OS memory monitor never sees a 2x spike to kill on. We attach the
 * debugger, drive the capture, and ALWAYS detach in a finally (detach is itself
 * the guard that un-wedges the renderer if anything goes wrong).
 *
 * The serialization still executes in the target renderer's V8, so it is not
 * free — but it is incremental and interruptible (detach cancels it), which is
 * what makes it safe to run under memory pressure.
 *
 * This module exposes a `take(filePath)` seam compatible with
 * {@link captureHeapSnapshot} in heap-snapshot.ts, so all the existing
 * retention / timeout / single-flight-fence policy is reused unchanged.
 */
import { createWriteStream } from 'fs';

/** Minimal debugger surface we use — kept structural so tests can fake it. */
export interface CdpDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
  on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): void;
  off(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): void;
}

/** The slice of WebContents this capturer needs. */
export interface CdpCaptureTarget {
  isDestroyed(): boolean;
  readonly debugger: CdpDebugger;
}

/** Node writable-stream slice we depend on (injectable for tests). */
interface ChunkSink {
  write(chunk: string): void;
  end(cb: () => void): void;
  destroy(err?: Error): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

export interface CdpCaptureDeps {
  /** Factory for the on-disk sink. Defaults to fs.createWriteStream. */
  createSink?: (filePath: string) => ChunkSink;
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

/**
 * Build a `take(filePath)` function that captures the renderer heap via CDP and
 * streams it to `filePath`. The returned function resolves when the full
 * snapshot has been flushed to disk, or rejects on any protocol/stream error.
 *
 * The debugger is attached for the duration of ONE capture and detached in a
 * finally — including when the outer timeout in captureHeapSnapshot abandons the
 * promise, because that rejection propagates through this promise's own chain
 * only after detach runs. To make abandonment safe, we also detach eagerly the
 * moment the target is seen destroyed.
 */
export function makeCdpHeapSnapshotTake(
  target: CdpCaptureTarget,
  deps: CdpCaptureDeps = {},
): (filePath: string) => Promise<void> {
  const createSink =
    deps.createSink ?? ((p: string) => createWriteStream(p, { encoding: 'utf8' }) as unknown as ChunkSink);

  return async (filePath: string): Promise<void> => {
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

    let sink: ChunkSink | null = null;
    let onMessage: ((event: unknown, method: string, params: unknown) => void) | null = null;
    let streamError: Error | null = null;
    let attached = false;

    const cleanup = (): void => {
      if (onMessage) {
        try {
          dbg.off('message', onMessage);
        } catch {
          /* best-effort */
        }
        onMessage = null;
      }
      if (attached) {
        try {
          // detach cancels an in-progress serialization — this is what makes an
          // abandoned/timed-out capture safe: the renderer stops serializing.
          dbg.detach();
        } catch {
          /* best-effort */
        }
        attached = false;
      }
      if (sink) {
        try {
          sink.destroy();
        } catch {
          /* best-effort */
        }
      }
    };

    try {
      sink = createSink(filePath);
      sink.on('error', (err) => {
        // Capture the first stream error; surfaced after the capture flow so we
        // reject rather than leave a truncated file looking successful.
        if (!streamError) streamError = err instanceof Error ? err : new Error(String(err));
      });

      // Collect every snapshot chunk into the sink. Chunks arrive as
      // { chunk: string } params on the debugger 'message' event.
      onMessage = (_event: unknown, method: string, params: unknown): void => {
        if (method !== CHUNK_EVENT) return;
        const chunk = (params as { chunk?: unknown } | null | undefined)?.chunk;
        if (typeof chunk === 'string' && sink) {
          try {
            sink.write(chunk);
          } catch (err) {
            if (!streamError) streamError = err instanceof Error ? err : new Error(String(err));
          }
        }
      };
      dbg.on('message', onMessage);

      dbg.attach('1.3');
      attached = true;

      // Re-check after attach: attaching can race a renderer teardown.
      if (target.isDestroyed()) {
        throw new CdpCaptureUnavailableError('webContents destroyed during attach');
      }

      // Drive the capture. This resolves once the renderer has emitted all
      // chunks. `reportProgress:false` keeps the protocol chatter minimal;
      // `captureNumericValue`/`exposeInternals` left default (smaller snapshot).
      await dbg.sendCommand('HeapProfiler.takeHeapSnapshot', { reportProgress: false });

      if (streamError) throw streamError;

      // Flush the sink and wait for the OS write to complete before reporting
      // success — otherwise the caller stats a partially-flushed file.
      await new Promise<void>((resolve, reject) => {
        const s = sink;
        if (!s) {
          resolve();
          return;
        }
        s.end(() => {
          if (streamError) reject(streamError);
          else resolve();
        });
      });
      // sink.end() already flushed+closed the file; don't destroy it in cleanup.
      sink = null;
    } finally {
      cleanup();
    }
  };
}

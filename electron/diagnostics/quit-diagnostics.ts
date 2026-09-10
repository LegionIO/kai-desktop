/**
 * Quit diagnostics — opt-in instrumentation that records, on disk, exactly what
 * keeps the Node event loop alive after `app.quit()` on the FIRST quit request.
 *
 * Why this exists: the macOS app has historically required TWO quits to fully
 * exit. Each such bug is one leaked libuv handle (an un-unref'd `fs.watch`, a
 * pending timer, an open socket, an un-reaped child process) that keeps the loop
 * spinning after `app.quit()`, so the process lingers in the dock until a second
 * quit forces it. These only reproduce in the PACKAGED app — `electron-vite dev`
 * parks the process on its own inspector socket, masking the real culprit — so
 * we need the released build itself to name the surviving handle.
 *
 * When enabled (Settings → Diagnostics), a session opened at `before-quit`:
 *   1. writes each cleanup step's start/finish + elapsed ms,
 *   2. snapshots the active handles/requests at quit (T0) and again ~3s later
 *      (T1) via an **unref'd** timer, so the snapshot itself can never be the
 *      thing keeping the loop alive.
 * Any handle still present at T1 is one that FAILED to drain — the real cause.
 *
 * Pure instrumentation: it changes no quit behavior. When disabled it writes
 * nothing and arms no timer.
 */
import { appendBoundedLog } from './main-diagnostics.js';

/** Default cap for quit-diagnostics.log (single-roll → `.1`). A quit snapshot is
 * tiny, so 5 MiB holds many quits; bounded 1–50 MiB by the schema. */
const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Delay before the second (post-drain) handle snapshot. Long enough for the
 * synchronous + fast-async cleanup to settle, short enough to fire before a
 * genuinely-draining process exits on its own. */
const SECOND_SNAPSHOT_DELAY_MS = 3000;

/** Cap the number of handles described in one snapshot so a runaway handle count
 * can't bloat the log or the stringify cost. */
const MAX_HANDLES_DESCRIBED = 100;

type ProcessInternals = {
  _getActiveHandles?: () => unknown[];
  _getActiveRequests?: () => unknown[];
};

/**
 * Describe one active handle/request with its constructor name plus a small,
 * explicitly ALLOW-LISTED set of non-sensitive fields (a watched path, an fd, a
 * timer's interval, a socket's address:port, a child's pid/spawnfile). Every
 * field read is guarded — a handle's getter can throw, and we must never let
 * describing a handle throw during quit. We never dump buffers or arbitrary
 * object contents.
 */
function describeHandle(handle: unknown): string {
  let ctor = 'Unknown';
  try {
    ctor = (handle as { constructor?: { name?: string } })?.constructor?.name || typeof handle;
  } catch {
    ctor = 'Unknown';
  }
  const parts: string[] = [];
  const h = handle as Record<string, unknown>;
  const tryField = (label: string, read: () => unknown): void => {
    try {
      const v = read();
      if (v !== undefined && v !== null && v !== '') parts.push(`${label}=${String(v)}`);
    } catch {
      /* a getter can throw; skip that field */
    }
  };
  // Timers: interval / repeat.
  tryField('msecs', () => h._idleTimeout ?? h.msecs);
  // FSWatcher / FSEvent: the watched path is the single most useful field for
  // diagnosing an un-closed watcher (this was the first leak we fixed).
  tryField('path', () => h.path ?? (h as { _handle?: { path?: unknown } })._handle?.path);
  tryField('filename', () => h.filename);
  // File descriptor (StatWatcher, pipes, some sockets).
  tryField('fd', () => h.fd ?? (h as { _handle?: { fd?: unknown } })._handle?.fd);
  // Sockets / servers: local + remote endpoint (address + port only — no data).
  tryField('localPort', () => h.localPort);
  tryField('remoteAddress', () => h.remoteAddress);
  tryField('remotePort', () => h.remotePort);
  // Server listening address.
  tryField('listening', () => (typeof h.listening === 'boolean' ? h.listening : undefined));
  // ChildProcess: pid + the binary it ran.
  tryField('pid', () => h.pid);
  tryField('spawnfile', () => h.spawnfile);
  tryField('killed', () => (typeof h.killed === 'boolean' ? h.killed : undefined));
  return parts.length ? `${ctor}(${parts.join(' ')})` : ctor;
}

/**
 * Snapshot active handles + requests as an array of human-readable lines. Never
 * throws; if the Node internals are unavailable it returns a single
 * "unavailable" marker so the log still records that we tried.
 */
function snapshotActive(): string[] {
  const proc = process as unknown as ProcessInternals;
  const getHandles = proc._getActiveHandles;
  const getRequests = proc._getActiveRequests;
  if (typeof getHandles !== 'function' && typeof getRequests !== 'function') {
    return ['(process._getActiveHandles/_getActiveRequests unavailable on this Node runtime)'];
  }
  const lines: string[] = [];
  const collect = (label: string, fn?: () => unknown[]): void => {
    if (typeof fn !== 'function') return;
    let items: unknown[] = [];
    try {
      items = fn.call(process) ?? [];
    } catch {
      lines.push(`  ${label}: (enumeration threw)`);
      return;
    }
    lines.push(`  ${label}: ${items.length}`);
    // Group identical descriptions so N copies of the same handle collapse to
    // "Nx Type(...)" — a leaked-handle storm stays legible and bounded.
    const counts = new Map<string, number>();
    for (const item of items.slice(0, MAX_HANDLES_DESCRIBED)) {
      const desc = describeHandle(item);
      counts.set(desc, (counts.get(desc) ?? 0) + 1);
    }
    for (const [desc, n] of counts) {
      lines.push(`    ${n > 1 ? `${n}x ` : ''}${desc}`);
    }
    if (items.length > MAX_HANDLES_DESCRIBED) {
      lines.push(`    …(${items.length - MAX_HANDLES_DESCRIBED} more not shown)`);
    }
  };
  collect('handles', getHandles);
  collect('requests', getRequests);
  return lines;
}

export interface QuitDiagnosticsSession {
  /** Bracket a cleanup step: logs `step-start`, returns a done-fn that logs
   * `step-done` with elapsed ms. The done-fn is idempotent. */
  step(name: string): () => void;
  /** Write one structured event line (e.g. will-quit, quit, passthrough). */
  mark(event: string, kv?: Record<string, unknown>): void;
}

function fmtKv(kv?: Record<string, unknown>): string {
  if (!kv) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(kv)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${String(v)}`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/**
 * Open a quit-diagnostics session if enabled. Returns null when disabled — every
 * caller treats a null session as a no-op (`session?.step(...)`), so the quit
 * path pays nothing when the toggle is off.
 *
 * When enabled, writes the quit header + the T0 (at-quit) snapshot immediately,
 * and arms an unref'd timer to write the T1 (post-drain) snapshot ~3s later. The
 * unref is critical: the diagnostic timer must never itself keep the loop alive.
 */
export function beginQuitDiagnostics(logPath: string, logMaxBytes?: number): QuitDiagnosticsSession {
  const maxBytes = logMaxBytes && logMaxBytes > 0 ? logMaxBytes : DEFAULT_LOG_MAX_BYTES;
  const write = (line: string): void => appendBoundedLog(logPath, line, maxBytes);
  const startedAt = Date.now();

  write(`\n===== QUIT ${new Date().toISOString()} pid=${process.pid} =====\n`);
  write(`[T0 at-quit snapshot]\n${snapshotActive().join('\n')}\n`);

  const timer = setTimeout(() => {
    const elapsed = Date.now() - startedAt;
    write(
      `[T1 +${elapsed}ms post-drain snapshot] handles still present here FAILED to drain and are what keep the app alive:\n${snapshotActive().join('\n')}\n`,
    );
  }, SECOND_SNAPSHOT_DELAY_MS);
  // Never let the diagnostic timer be the reason the loop stays alive.
  timer.unref?.();

  return {
    step(name: string): () => void {
      const t = Date.now();
      write(`[${new Date().toISOString()}] step-start ${name}\n`);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        write(`[${new Date().toISOString()}] step-done ${name} elapsedMs=${Date.now() - t}\n`);
      };
    },
    mark(event: string, kv?: Record<string, unknown>): void {
      write(`[${new Date().toISOString()}] ${event}${fmtKv(kv)}\n`);
    },
  };
}

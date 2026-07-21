/**
 * Main-process diagnostics — shared state + helpers behind the "Diagnostics"
 * settings section and the hardened unhandled-error handler in main.ts.
 *
 * Why this exists: a dead stdout/stderr pipe (parent shell exits, launcher
 * detaches) makes any `console.*` write throw an async EPIPE. That surfaces as
 * `uncaughtException`; if the handler ITSELF writes to the console it throws
 * again → an unbounded self-feeding loop that saturates the event loop (the
 * app goes unresponsive) and balloons main-process.log to hundreds of MB. This
 * module owns the guard state (re-entrancy + EPIPE classification), a bounded
 * append-with-rotation writer, and an in-memory counter the UI reads to
 * attribute error storms to the originating plugin.
 */
import { appendFileSync, mkdirSync, statSync, renameSync, openSync, readSync, closeSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/** Rotate main-process.log once it crosses this size (single roll → `.1`). */
export const MAIN_LOG_MAX_BYTES = 25 * 1024 * 1024;

/** Errors classified as "dead pipe" — never re-logged to the console. */
const DEAD_PIPE_CODES = new Set(['EPIPE', 'EACCES', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);

export type DiagnosticKind = 'uncaughtException' | 'unhandledRejection';

export interface DiagnosticCounter {
  /** Grouping key: `${kind}:${plugin ?? 'core'}`. */
  key: string;
  kind: DiagnosticKind;
  /** Originating plugin name parsed from the stack, or null for core/app code. */
  plugin: string | null;
  count: number;
  /** ISO timestamp of the most recent occurrence. */
  lastTs: string;
  /** First line of the most recent error (truncated), for at-a-glance triage. */
  sample: string;
}

const counters = new Map<string, DiagnosticCounter>();
let bootTs = new Date().toISOString();

/** Re-entrancy guard: a throw inside the error handler must not recurse. */
let inErrorHandler = false;

/**
 * True when `error` is a write failure against a dead/destroyed stdio pipe.
 * These must never be re-logged to the console (that write throws again).
 */
export function isDeadPipeError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && DEAD_PIPE_CODES.has(code)) return true;
  const msg = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /\bEPIPE\b/.test(msg) || /write after end/i.test(msg);
}

/** Parse `/.kai/plugins/<name>/backend.js` frames out of a stack to attribute the error. */
export function extractPluginName(formatted: string): string | null {
  // Defensive: callers should pass a string, but a non-string (e.g. a
  // JSON.stringify(undefined) result) must not throw here inside the
  // unhandled-error path and spawn a secondary error.
  if (typeof formatted !== 'string') return null;
  const m = formatted.match(/[/\\]plugins[/\\]([^/\\]+)[/\\]backend\.js/);
  return m ? m[1] : null;
}

/**
 * Record an unhandled error into the in-memory counter map. Pure w.r.t. the
 * filesystem/console — main.ts owns those side effects. Exposed for testing.
 */
export function recordDiagnostic(kind: DiagnosticKind, formatted: string): DiagnosticCounter {
  const safe = typeof formatted === 'string' ? formatted : String(formatted);
  const plugin = extractPluginName(safe);
  return recordDiagnosticForPlugin(kind, plugin, safe);
}

/** Record an error whose plugin identity came from an isolated process host. */
export function recordDiagnosticForPlugin(
  kind: DiagnosticKind,
  plugin: string | null,
  formatted: string,
): DiagnosticCounter {
  const safe = typeof formatted === 'string' ? formatted : String(formatted);
  const key = `${kind}:${plugin ?? 'core'}`;
  const sample = safe.split('\n', 1)[0].slice(0, 300);
  const existing = counters.get(key);
  if (existing) {
    existing.count += 1;
    existing.lastTs = new Date().toISOString();
    existing.sample = sample;
    return existing;
  }
  const created: DiagnosticCounter = {
    key,
    kind,
    plugin,
    count: 1,
    lastTs: new Date().toISOString(),
    sample,
  };
  counters.set(key, created);
  return created;
}

export function getDiagnosticCounters(): DiagnosticCounter[] {
  return [...counters.values()].sort((a, b) => b.count - a.count);
}

export function resetDiagnosticCounters(): void {
  counters.clear();
  bootTs = new Date().toISOString();
}

export function getDiagnosticsBootTs(): string {
  return bootTs;
}

/** Whether we're currently inside the error handler (for the re-entrancy guard). */
export function isInErrorHandler(): boolean {
  return inErrorHandler;
}

export function enterErrorHandler(): void {
  inErrorHandler = true;
}

export function exitErrorHandler(): void {
  inErrorHandler = false;
}

/**
 * Append to a log file, rotating to `<path>.1` first if it would exceed
 * `maxBytes`. Single-roll (overwrites any prior `.1`) — enough to bound disk
 * use without unbounded rotation bookkeeping. Best-effort: never throws.
 */
export function appendBoundedLog(logPath: string, line: string, maxBytes = MAIN_LOG_MAX_BYTES): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    let size = 0;
    try {
      size = statSync(logPath).size;
    } catch {
      /* file may not exist yet */
    }
    if (size > maxBytes) {
      try {
        renameSync(logPath, `${logPath}.1`);
      } catch {
        // Rename can fail (e.g. cross-device); fall back to truncation so the
        // file can never grow without bound.
        try {
          writeFileSync(logPath, '');
        } catch {
          /* give up on rotation, still try to append below */
        }
      }
    }
    appendFileSync(logPath, line, 'utf-8');
  } catch {
    /* best-effort logging only */
  }
}

/**
 * Read the last `maxBytes` of a file as UTF-8 (for the in-app log tail viewer).
 * Reads only the tail window via a positioned fd read — safe on large files.
 */
export function readLogTail(
  logPath: string,
  maxBytes: number,
): { text: string; sizeBytes: number; truncated: boolean } {
  let fd: number | null = null;
  try {
    const size = statSync(logPath).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(logPath, 'r');
    let readTotal = 0;
    while (readTotal < len) {
      const n = readSync(fd, buf, readTotal, len - readTotal, start + readTotal);
      if (n === 0) break;
      readTotal += n;
    }
    return { text: buf.subarray(0, readTotal).toString('utf-8'), sizeBytes: size, truncated: start > 0 };
  } catch {
    return { text: '', sizeBytes: 0, truncated: false };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* noop */
      }
    }
  }
}

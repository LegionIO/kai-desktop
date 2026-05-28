/**
 * Global terminal output buffer — stores output for all terminal sessions
 * (both real PTY and virtual Mastra sessions) so it can be replayed when
 * the user navigates back to a task.
 *
 * Buffers are kept in memory AND persisted to disk at:
 *   ~/.kai/data/terminal-logs/{sessionId}.log
 *
 * On startup, existing logs can be loaded from disk for any session ID.
 * Writes are debounced (flush every 2s) to avoid excessive I/O.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';

const buffers = new Map<string, string[]>();
const MAX_LINES = 5000;

/** Directory where terminal logs are persisted. Set via initOutputBuffer(). */
let logDir: string | null = null;

/** Pending flush timers per session. */
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Separator used in the log file between chunks. */
const CHUNK_SEP = '\x00';

// ── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize the output buffer with the app data directory.
 * Must be called once at startup before any output is buffered.
 */
export function initOutputBuffer(appHome: string): void {
  logDir = join(appHome, 'data', 'terminal-logs');
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
}

// ── Core API ────────────────────────────────────────────────────────────────

/** Append a chunk of output for the given session. */
export function appendOutput(sessionId: string, data: string): void {
  let buf = buffers.get(sessionId);
  if (!buf) {
    buf = [];
    buffers.set(sessionId, buf);
  }
  buf.push(data);
  if (buf.length > MAX_LINES) {
    buf.splice(0, buf.length - MAX_LINES);
  }

  // Schedule a debounced disk flush
  scheduleDiskFlush(sessionId);
}

/** Retrieve the full buffered output for a session. Loads from disk if not in memory. */
export function getBuffer(sessionId: string): string[] {
  // Check in-memory first
  const memBuf = buffers.get(sessionId);
  if (memBuf && memBuf.length > 0) return memBuf;

  // Try loading from disk
  const diskBuf = loadFromDisk(sessionId);
  if (diskBuf.length > 0) {
    buffers.set(sessionId, diskBuf);
    return diskBuf;
  }

  return [];
}

/** Delete the buffer for a session (memory + disk). */
export function clearBuffer(sessionId: string): void {
  buffers.delete(sessionId);
  cancelFlush(sessionId);
  deleteFromDisk(sessionId);
}

/** Check whether any buffered output exists for a session (memory or disk). */
export function hasBuffer(sessionId: string): boolean {
  if ((buffers.get(sessionId)?.length ?? 0) > 0) return true;
  return logFileExists(sessionId);
}

/** List all session IDs that have persisted logs on disk. */
export function listPersistedSessions(): string[] {
  if (!logDir || !existsSync(logDir)) return [];
  try {
    return readdirSync(logDir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => f.slice(0, -4)); // remove .log extension
  } catch {
    return [];
  }
}

/** Flush all pending buffers to disk immediately (call on app quit). */
export function flushAll(): void {
  for (const [sessionId] of buffers) {
    flushToDisk(sessionId);
  }
  for (const timer of flushTimers.values()) {
    clearTimeout(timer);
  }
  flushTimers.clear();
}

// ── Disk I/O (internal) ─────────────────────────────────────────────────────

function getLogPath(sessionId: string): string | null {
  if (!logDir) return null;
  // Sanitize sessionId to prevent path traversal
  const safe = sessionId.replace(/[^a-zA-Z0-9\-_]/g, '_');
  return join(logDir, `${safe}.log`);
}

function logFileExists(sessionId: string): boolean {
  const path = getLogPath(sessionId);
  return path ? existsSync(path) : false;
}

function loadFromDisk(sessionId: string): string[] {
  const path = getLogPath(sessionId);
  if (!path || !existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    if (!raw) return [];
    // Split by chunk separator, filter empty entries
    return raw.split(CHUNK_SEP).filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

function flushToDisk(sessionId: string): void {
  const path = getLogPath(sessionId);
  if (!path) return;
  const buf = buffers.get(sessionId);
  if (!buf || buf.length === 0) return;
  try {
    // Write the full buffer (overwrite). Using chunk separator for later parsing.
    writeFileSync(path, buf.join(CHUNK_SEP), 'utf-8');
  } catch (err) {
    console.warn(`[output-buffer] Failed to flush ${sessionId} to disk:`, err);
  }
}

function deleteFromDisk(sessionId: string): void {
  const path = getLogPath(sessionId);
  if (!path) return;
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // ignore
  }
}

function scheduleDiskFlush(sessionId: string): void {
  if (flushTimers.has(sessionId)) return; // already scheduled
  const timer = setTimeout(() => {
    flushTimers.delete(sessionId);
    flushToDisk(sessionId);
  }, 2000); // flush every 2 seconds
  flushTimers.set(sessionId, timer);
}

function cancelFlush(sessionId: string): void {
  const timer = flushTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(sessionId);
  }
}

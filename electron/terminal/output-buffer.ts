/**
 * Global terminal output buffer — stores output for all terminal sessions
 * (both real PTY and virtual Mastra sessions) so it can be replayed when
 * the user navigates back to a task.
 *
 * Buffers are kept in memory only. They persist across navigation within a
 * session but are lost on app restart. Disk persistence is a follow-up.
 */

const buffers = new Map<string, string[]>();
const MAX_LINES = 5000;

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
}

/** Retrieve the full buffered output for a session (empty array if none). */
export function getBuffer(sessionId: string): string[] {
  return buffers.get(sessionId) ?? [];
}

/** Delete the buffer for a session (e.g. on explicit task deletion). */
export function clearBuffer(sessionId: string): void {
  buffers.delete(sessionId);
}

/** Check whether any buffered output exists for a session. */
export function hasBuffer(sessionId: string): boolean {
  return (buffers.get(sessionId)?.length ?? 0) > 0;
}

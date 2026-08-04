/**
 * Cross-module lock so on-demand `/compact` (ipc/conversations.ts) and turn
 * admission (ipc/agent.ts) coordinate WITHOUT importing each other. `/compact`
 * marks a conversation while its paid summarization runs; agent admission
 * (agent:submit AND agent:stream) rejects a new turn for a marked conversation,
 * and `/compact` rejects if a turn already holds the conversation. A tiny shared
 * module (not a runStatus value) so the two can't confuse each other's marker.
 */
const compacting = new Set<string>();

// Optional broadcaster (injected by main so this tiny module needn't import
// electron/web-clients). Called on every mark/clear so ALL clients — other windows,
// the web bridge, a reloaded renderer — can mirror the compacting set and block a
// concurrent send BEFORE optimistically persisting a user turn the backend rejects.
let notify: ((conversationId: string, compacting: boolean) => void) | null = null;
export function setCompactionLockNotifier(fn: ((conversationId: string, compacting: boolean) => void) | null): void {
  notify = fn;
}

// Fire the notifier best-effort: it fans out to webContents.send / web clients, any of
// which can throw (a window/socket that just disappeared). A broadcast failure must NEVER
// leave the lock in a corrupt state — if this threw out of markCompacting the id would be
// added but the caller's cleanup try/finally may not yet be established, wedging the lock
// and rejecting every future turn for that conversation.
function safeNotify(conversationId: string, isCompactingNow: boolean): void {
  if (!notify) return;
  try {
    notify(conversationId, isCompactingNow);
  } catch {
    /* best-effort mirror; the authoritative set is the local `compacting` Set */
  }
}

export function markCompacting(conversationId: string): void {
  if (compacting.has(conversationId)) return;
  compacting.add(conversationId);
  safeNotify(conversationId, true);
}
export function clearCompacting(conversationId: string): void {
  if (!compacting.delete(conversationId)) return;
  safeNotify(conversationId, false);
}
export function isCompacting(conversationId: string): boolean {
  return compacting.has(conversationId);
}
/** Snapshot of currently-compacting conversation ids — for a late-joining/reloaded
 *  client to sync its initial state via an IPC query. */
export function compactingConversationIds(): string[] {
  return [...compacting];
}

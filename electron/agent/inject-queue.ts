/**
 * Per-conversation pending-inject queue for cooperative mid-turn injection.
 *
 * When a follow-up message is queued into a conversation whose Mastra turn is
 * still generating, we DON'T abort. Instead we enqueue the message here and let
 * the running turn's `prepareStep` hook (see mastra-agent.ts) drain it at the
 * next step boundary, appending it to that step's messages so the model
 * continues the same turn and sees the new message. No abort, no lost partial.
 *
 * The CLI runtimes (codex/claude/pi/opencode) can't be stepped, so they use the
 * abort+restart path instead (ipc/agent.ts injectUserTurnAndRestart); this queue
 * is only consulted on the Mastra path.
 *
 * Pure + side-effect-free (a module-level Map) so it can be unit-tested and
 * shared by the IPC injection entry and the Mastra stream without an import
 * cycle.
 */

export type QueuedInject = {
  /** Stable per-entry id (for cancel/edit of a specific queued message). */
  id: string;
  /** The user message text to splice into the running turn. */
  text: string;
  /** Enqueue time (ms epoch) — FIFO ordering + potential future staleness cap. */
  at: number;
};

const queues = new Map<string, QueuedInject[]>();

let injectSeq = 0;
function nextInjectId(): string {
  injectSeq += 1;
  return `inj-${Date.now().toString(36)}-${injectSeq}`;
}

/** Append a message to a conversation's pending-inject queue (FIFO). Returns the
 *  new entry's id (for later cancel/edit), or null if nothing was enqueued. */
export function enqueueInject(conversationId: string, text: string): string | null {
  if (!conversationId || !text) return null;
  const entry: QueuedInject = { id: nextInjectId(), text, at: Date.now() };
  const q = queues.get(conversationId);
  if (q) q.push(entry);
  else queues.set(conversationId, [entry]);
  return entry.id;
}

/** Re-insert a previously-drained entry at the FRONT of the queue, preserving its
 *  original id + enqueue time (used when boundary persistence fails and the entry
 *  must be retried without becoming a duplicate). FIFO order is restored across
 *  multiple re-enqueues by inserting in reverse at the head. */
export function reenqueueInject(conversationId: string, entry: QueuedInject): void {
  if (!conversationId || !entry?.text) return;
  const q = queues.get(conversationId);
  if (q) q.unshift(entry);
  else queues.set(conversationId, [entry]);
}

/**
 * Return and REMOVE all queued injects for a conversation, in FIFO order.
 * Empty array if none. Called by prepareStep at each step boundary.
 */
export function drainInjects(conversationId: string): QueuedInject[] {
  const q = queues.get(conversationId);
  if (!q || q.length === 0) return [];
  queues.delete(conversationId);
  return q;
}

/** True if the conversation has at least one queued inject. */
export function hasInjects(conversationId: string): boolean {
  const q = queues.get(conversationId);
  return q !== undefined && q.length > 0;
}

/** Snapshot the pending injects for a conversation (for the queued-chip UI). */
export function listInjects(conversationId: string): QueuedInject[] {
  return [...(queues.get(conversationId) ?? [])];
}

/**
 * Remove one queued inject by id (queue-editable cancel/edit). Returns the
 * removed entry's text, or null if not found (already spliced/drained).
 */
export function removeInject(conversationId: string, id: string): string | null {
  const q = queues.get(conversationId);
  if (!q) return null;
  const idx = q.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  const [removed] = q.splice(idx, 1);
  if (q.length === 0) queues.delete(conversationId);
  return removed.text;
}

/**
 * Drop any queued injects for a conversation without returning them (turn end /
 * cancel safety net, so a message queued in a race after the last step can't
 * leak into an unrelated later turn — the caller handles the drained-at-end case
 * explicitly via drainInjects).
 */
export function clearInjects(conversationId: string): void {
  queues.delete(conversationId);
}

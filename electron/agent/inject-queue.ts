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
  /** The user message text to splice into the running turn. */
  text: string;
  /** Enqueue time (ms epoch) — FIFO ordering + potential future staleness cap. */
  at: number;
};

const queues = new Map<string, QueuedInject[]>();

/** Append a message to a conversation's pending-inject queue (FIFO). */
export function enqueueInject(conversationId: string, text: string): void {
  if (!conversationId || !text) return;
  const q = queues.get(conversationId);
  const entry: QueuedInject = { text, at: Date.now() };
  if (q) q.push(entry);
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

/**
 * Drop any queued injects for a conversation without returning them (turn end /
 * cancel safety net, so a message queued in a race after the last step can't
 * leak into an unrelated later turn — the caller handles the drained-at-end case
 * explicitly via drainInjects).
 */
export function clearInjects(conversationId: string): void {
  queues.delete(conversationId);
}

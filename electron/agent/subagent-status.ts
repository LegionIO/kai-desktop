/**
 * Sub-agent lifecycle status persistence.
 *
 * Stores `status`, `completedAt`, `exitReason`, and `parentThreadId` in the
 * thread's `metadata` field via Mastra's public `updateThread()` API. No
 * direct SQL, no schema migrations, no reaching into Mastra internals.
 *
 * Status transitions are guarded by a finite-state machine so a completed
 * (or otherwise terminal) thread can never silently regress to `running`.
 */

import type { Memory } from '@mastra/memory';

export type SubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'abandoned' | 'stopped';

/** Fields tracked under `metadata.subagent` for sub-agent threads. */
export interface SubagentStatusFields {
  status?: SubagentStatus;
  completedAt?: string | null;
  exitReason?: string | null;
  parentThreadId?: string | null;
}

/**
 * Valid status transitions. Terminal states (completed/failed/abandoned/stopped)
 * have no outgoing edges — once a sub-agent is done it stays done.
 */
const VALID_TRANSITIONS: Record<SubagentStatus, SubagentStatus[]> = {
  pending: ['running', 'failed', 'abandoned', 'stopped'],
  running: ['completed', 'failed', 'abandoned', 'stopped'],
  completed: [],
  failed: [],
  abandoned: [],
  stopped: [],
};

/** Sentinel key under thread.metadata where sub-agent fields live. */
const METADATA_KEY = 'subagent';

interface StoredMetadata {
  [METADATA_KEY]?: SubagentStatusFields;
  [key: string]: unknown;
}

/**
 * Read the current sub-agent metadata for a thread.
 * Returns `null` if the thread doesn't exist.
 */
export async function readSubagentStatus(memory: Memory, threadId: string): Promise<SubagentStatusFields | null> {
  const thread = await memory.getThreadById({ threadId });
  if (!thread) return null;
  const metadata = (thread.metadata ?? {}) as StoredMetadata;
  const sub = metadata[METADATA_KEY];
  return sub ? { ...sub } : {};
}

/**
 * Merge the given fields into the sub-agent metadata on `threadId`.
 *
 * - If the thread does not exist, logs a warning and returns without writing.
 * - If a `status` change is requested, the FSM is consulted; illegal
 *   transitions log an error and the entire update is aborted (no partial write).
 * - Other (non-status) fields can always be updated.
 */
export async function updateSubagentStatus(
  memory: Memory,
  threadId: string,
  updates: SubagentStatusFields,
): Promise<void> {
  let existing: Awaited<ReturnType<Memory['getThreadById']>> | null;
  try {
    existing = await memory.getThreadById({ threadId });
  } catch (err) {
    console.error(`[Subagent] Failed to read thread ${threadId}:`, err);
    return;
  }

  if (!existing) {
    console.warn(`[Subagent] Cannot update status — thread ${threadId} not found`);
    return;
  }

  const currentMetadata = (existing.metadata ?? {}) as StoredMetadata;
  const currentSub = currentMetadata[METADATA_KEY] ?? {};

  // FSM gate: validate any requested status transition before applying anything.
  if (updates.status !== undefined && currentSub.status !== undefined) {
    const allowed = VALID_TRANSITIONS[currentSub.status] ?? [];
    if (!allowed.includes(updates.status)) {
      console.error(`[Subagent] Illegal status transition for ${threadId}: ${currentSub.status} -> ${updates.status}`);
      return;
    }
  }

  // Merge metadata: preserve other top-level keys (e.g. Mastra-internal data)
  // and merge sub-agent fields with the incoming updates.
  const mergedSub: SubagentStatusFields = { ...currentSub };
  if (updates.status !== undefined) mergedSub.status = updates.status;
  if (updates.completedAt !== undefined) mergedSub.completedAt = updates.completedAt;
  if (updates.exitReason !== undefined) mergedSub.exitReason = updates.exitReason;
  if (updates.parentThreadId !== undefined) mergedSub.parentThreadId = updates.parentThreadId;

  const nextMetadata: StoredMetadata = {
    ...currentMetadata,
    [METADATA_KEY]: mergedSub,
  };

  try {
    await memory.updateThread({
      id: threadId,
      title: existing.title ?? '',
      metadata: nextMetadata,
    });
  } catch (err) {
    console.error(`[Subagent] Failed to update status for ${threadId}:`, err);
  }
}

/** Exported for tests. */
export const __internal = { VALID_TRANSITIONS, METADATA_KEY };

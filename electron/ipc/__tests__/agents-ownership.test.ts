/**
 * Tests for isOwningTaskRun (electron/ipc/agents.ts) — the ownership fence that
 * promote_task / block_task apply before mutating a task. The Mastra task agent's
 * lifecycle tools run in still-draining stream closures; abort only signals the
 * stream, so a stale run (task reassigned to another agent, or a superseded prior
 * run of the same agent with a different session id) could otherwise promote/
 * block work it no longer owns. The fence requires: in_progress + assignedAgentId
 * match + terminalSessionId match.
 */
import { describe, it, expect } from 'vitest';
import { isOwningTaskRun } from '../agents.js';
import type { TaskFile } from '../../../shared/task-types';

const task = (over: Partial<TaskFile> = {}): TaskFile =>
  ({
    status: 'in_progress',
    assignedAgentId: 'agent-A',
    terminalSessionId: 'mastra-sess-1',
    ...over,
  }) as TaskFile;

describe('isOwningTaskRun', () => {
  it('is true only when in_progress AND assignedAgentId AND terminalSessionId all match', () => {
    expect(isOwningTaskRun(task(), 'agent-A', 'mastra-sess-1')).toBe(true);
  });

  it('is false when the task is owned by a DIFFERENT agent (reassigned to B)', () => {
    // A's stale run must not promote/block a task now assigned to B.
    expect(isOwningTaskRun(task({ assignedAgentId: 'agent-B' }), 'agent-A', 'mastra-sess-1')).toBe(false);
  });

  it('is false for a SUPERSEDED run of the same agent (different session id)', () => {
    // Same agent, newer run → different terminalSessionId. The old run's stale
    // tool call must not act on the newer run's task.
    expect(isOwningTaskRun(task({ terminalSessionId: 'mastra-sess-2' }), 'agent-A', 'mastra-sess-1')).toBe(false);
  });

  it('is false when the task is no longer in_progress', () => {
    for (const status of ['todo', 'ai_review', 'human_review', 'done', 'blocked'] as const) {
      expect(isOwningTaskRun(task({ status }), 'agent-A', 'mastra-sess-1'), status).toBe(false);
    }
  });

  it('is false for a null/undefined task', () => {
    expect(isOwningTaskRun(null, 'agent-A', 'mastra-sess-1')).toBe(false);
    expect(isOwningTaskRun(undefined, 'agent-A', 'mastra-sess-1')).toBe(false);
  });

  it('is false when the task has no assignedAgentId or no terminalSessionId', () => {
    expect(isOwningTaskRun(task({ assignedAgentId: undefined }), 'agent-A', 'mastra-sess-1')).toBe(false);
    expect(isOwningTaskRun(task({ terminalSessionId: undefined }), 'agent-A', 'mastra-sess-1')).toBe(false);
  });
});

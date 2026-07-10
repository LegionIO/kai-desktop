import { describe, it, expect, vi } from 'vitest';
import { TaskDispatcher, type DispatcherDeps } from '../task-dispatcher';
import type { TaskFile } from '../../../shared/task-types.js';
import type { AgentFile } from '../../../shared/agent-types.js';

function makeTask(id: string, over: Partial<TaskFile> = {}): TaskFile {
  return {
    id,
    title: `task ${id}`,
    description: 'do the thing',
    status: 'todo',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as TaskFile;
}

function makeAgent(id: string, over: Partial<AgentFile> = {}): AgentFile {
  return {
    id,
    name: `agent ${id}`,
    role: 'engineer',
    status: 'idle',
    runtime: 'mastra',
    config: {},
    instructions: '',
    stats: { tasksCompleted: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as AgentFile;
}

const baseConfig = {
  enabled: true,
  intervalMs: 30000,
  autoStart: true,
  maxConcurrentAgents: 3,
  matchingStrategy: 'simple' as const,
  requireHumanReview: true,
};

describe('TaskDispatcher rollback safety', () => {
  it('does NOT re-assign the same task/agent when start fails and unassignTask is absent', async () => {
    const task = makeTask('t1', { title: 'build feature', description: 'implement feature X' });
    const agent = makeAgent('a1', { name: 'engineer', description: 'builds features' });

    const assignTask = vi.fn().mockResolvedValue({ ok: true });
    const startAgent = vi.fn().mockResolvedValue({ error: 'boom' });

    const deps: DispatcherDeps = {
      listTasks: () => [task],
      listAgents: () => [agent],
      assignTask,
      startAgent,
      getConfig: () => baseConfig,
      // no unassignTask on purpose
    };

    const d = new TaskDispatcher(deps, baseConfig);
    const decisions = await d.forceTick();

    // start failed → decision records the error; because we can't roll back the
    // persisted assignment, the task/agent slot stays consumed (no double-assign).
    expect(assignTask).toHaveBeenCalledTimes(1);
    expect(startAgent).toHaveBeenCalledTimes(1);
    const dec = decisions.find((x) => x.taskId === 't1');
    expect(dec?.error).toContain('start failed');
  });

  it('rolls back and frees the slot when unassignTask succeeds', async () => {
    const task = makeTask('t1', { title: 'build feature', description: 'implement feature X' });
    const agent = makeAgent('a1', { name: 'engineer', description: 'builds features' });

    const assignTask = vi.fn().mockResolvedValue({ ok: true });
    const startAgent = vi.fn().mockResolvedValueOnce({ error: 'boom' });
    const unassignTask = vi.fn().mockResolvedValue(undefined);

    const deps: DispatcherDeps = {
      listTasks: () => [task],
      listAgents: () => [agent],
      assignTask,
      startAgent,
      unassignTask,
      getConfig: () => baseConfig,
    };

    const d = new TaskDispatcher(deps, baseConfig);
    const decisions = await d.forceTick();

    expect(unassignTask).toHaveBeenCalledWith('a1', 't1');
    const dec = decisions.find((x) => x.taskId === 't1');
    expect(dec?.assigned).toBe(false);
  });
});

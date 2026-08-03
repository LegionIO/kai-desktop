import type { TaskFile } from '../../shared/task-types.js';
import type { PluginTaskChangeEvent, PluginTaskChangeOrigin } from '../plugins/types.js';

type TaskChangeHandler = (event: PluginTaskChangeEvent) => void | Promise<void>;

const listenersByHome = new Map<string, Set<TaskChangeHandler>>();
const snapshotsByHome = new Map<string, Map<string, TaskFile>>();

function cloneTask(task: TaskFile): TaskFile {
  return structuredClone(task);
}

function snapshot(tasks: readonly TaskFile[]): Map<string, TaskFile> {
  return new Map(tasks.map((task) => [task.id, cloneTask(task)]));
}

function changedFields(previous: TaskFile, task: TaskFile): Array<keyof TaskFile> {
  const keys = new Set<keyof TaskFile>([
    ...(Object.keys(previous) as Array<keyof TaskFile>),
    ...(Object.keys(task) as Array<keyof TaskFile>),
  ]);
  return [...keys].filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(task[key]));
}

function changeType(previous: TaskFile, task: TaskFile): PluginTaskChangeEvent['type'] {
  if (!previous.archivedAt && task.archivedAt) return 'archived';
  if (previous.archivedAt && !task.archivedAt) return 'unarchived';
  return 'updated';
}

/**
 * Subscribe a plugin to board changes. The current board is supplied at
 * registration time to establish a baseline; existing tasks are not replayed
 * as newly-created events.
 */
export function subscribeToTaskChanges(
  appHome: string,
  currentTasks: readonly TaskFile[],
  handler: TaskChangeHandler,
): () => void {
  let listeners = listenersByHome.get(appHome);
  if (!listeners) {
    listeners = new Set();
    listenersByHome.set(appHome, listeners);
  }
  if (listeners.size === 0) snapshotsByHome.set(appHome, snapshot(currentTasks));
  listeners.add(handler);

  return () => {
    const current = listenersByHome.get(appHome);
    current?.delete(handler);
    if (current?.size === 0) listenersByHome.delete(appHome);
  };
}

/**
 * Diff and publish a full task snapshot. Taking a snapshot instead of trusting
 * individual mutation call sites also catches task changes made by agent and
 * orchestrator paths that persist tasks directly.
 */
export function publishTaskChanges(
  appHome: string,
  currentTasks: readonly TaskFile[],
  origin: PluginTaskChangeOrigin,
): void {
  const next = snapshot(currentTasks);
  const previous = snapshotsByHome.get(appHome) ?? new Map<string, TaskFile>();
  snapshotsByHome.set(appHome, next);

  const listeners = listenersByHome.get(appHome);
  if (!listeners || listeners.size === 0) return;

  const timestamp = new Date().toISOString();
  const events: PluginTaskChangeEvent[] = [];

  for (const [taskId, task] of next) {
    const oldTask = previous.get(taskId);
    if (!oldTask) {
      events.push({
        type: 'created',
        taskId,
        task,
        changedFields: Object.keys(task) as Array<keyof TaskFile>,
        origin,
        timestamp,
      });
      continue;
    }
    const fields = changedFields(oldTask, task);
    if (fields.length === 0) continue;
    events.push({
      type: changeType(oldTask, task),
      taskId,
      task,
      previous: oldTask,
      changedFields: fields,
      origin,
      timestamp,
    });
  }

  for (const [taskId, oldTask] of previous) {
    if (next.has(taskId)) continue;
    events.push({
      type: 'deleted',
      taskId,
      previous: oldTask,
      changedFields: Object.keys(oldTask) as Array<keyof TaskFile>,
      origin,
      timestamp,
    });
  }

  for (const event of events) {
    for (const listener of [...listeners]) {
      try {
        Promise.resolve(listener(structuredClone(event))).catch((error) => {
          console.warn('[tasks] Plugin task-change listener rejected:', error);
        });
      } catch (error) {
        console.warn('[tasks] Plugin task-change listener threw:', error);
      }
    }
  }
}

/** Test-only reset for module-global subscription state. */
export function resetTaskSyncStateForTests(): void {
  listenersByHome.clear();
  snapshotsByHome.clear();
}

import type { IpcMain } from 'electron';
import { readFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import type {
  TaskFile,
  KaiTaskOrder,
  TaskConversationMessage,
  TaskStreamEvent,
  TaskReviewNote,
  TaskExternalLink,
} from '../../shared/task-types.js';
import { isValidTransition } from '../../shared/task-state-machine.js';
import type { AppConfig } from '../config/schema.js';
import { TASK_PLAN_SYSTEM_PROMPT } from '../agent/prompts.js';
import { broadcastToAllWindows } from '../utils/window-send.js';
import { warnOnDeprecatedField } from '../utils/field-validation.js';
import { clearBuffer } from '../terminal/output-buffer.js';
import type {
  PluginTaskChangeOrigin,
  PluginTaskCreateInput,
  PluginTaskMutationOptions,
  PluginTaskUpsertExternalInput,
  PluginTaskUpdateInput,
} from '../plugins/types.js';
import { publishTaskChanges } from '../tasks/task-sync.js';

export type { TaskStreamEvent } from '../../shared/task-types.js';

// ── Validation Schemas ──────────────────────────────────────────────────

const MAX_TITLE_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 50_000;
const MAX_HISTORY_LENGTH = 200_000;
const MAX_USER_MESSAGE_LENGTH = 50_000;

const kaiTaskStatusSchema = z.enum(['todo', 'in_progress', 'blocked', 'ai_review', 'human_review', 'done']);

const taskExternalUrlSchema = z
  .string()
  .url()
  .max(4000)
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'External task URL must use HTTP(S)');

const taskExternalLinkSchema = z.object({
  pluginName: z.string().min(1).max(200),
  source: z.string().min(1).max(500),
  externalId: z.string().min(1).max(500),
  externalKey: z.string().max(500).optional(),
  url: taskExternalUrlSchema.optional(),
  revision: z.string().max(500).optional(),
  syncedAt: z.string().max(64),
});

const taskCreateSchema = z
  .object({
    title: z.string().min(1).max(MAX_TITLE_LENGTH),
    description: z.string().max(MAX_DESCRIPTION_LENGTH).default(''),
    status: kaiTaskStatusSchema.default('todo'),
    metadata: z
      .object({
        category: z.enum(['feature', 'bug_fix', 'refactoring', 'docs', 'other']).optional(),
        labels: z.array(z.string().max(100)).max(20).optional(),
        planFileName: z.string().max(200).optional(),
        cwd: z.string().max(500).optional(),
      })
      .optional(),
    sourceConversationId: z.string().max(100).optional(),
    sourceToolCallId: z.string().max(100).optional(),
    workspaceId: z.string().max(100).optional(),
    assignedAgentId: z.string().max(100).optional(),
    reviewerAgentIds: z.array(z.string().max(100)).max(10).optional(),
    reviewMode: z.enum(['parallel', 'sequential']).optional(),
    priority: z.number().int().min(-100).max(100).optional(),
    externalLinks: z.array(taskExternalLinkSchema).max(50).optional(),
  })
  .passthrough(); // allow additional fields for forward compat

// Validates the PARTIAL payload of `tasks:update` (#100 review MED). Previously
// only `status` was checked, so a caller could forge/corrupt runs, reviewResults,
// timestamps, exit codes, and completion metadata, or blank required fields with
// wrong types. Every field is optional (partial merge) and type/-bound checked;
// `.passthrough()` keeps forward-compat for fields not yet enumerated here.
const taskMetadataSchema = z.object({
  category: z.enum(['feature', 'bug_fix', 'refactoring', 'docs', 'other']).optional(),
  labels: z.array(z.string().max(100)).max(50).optional(),
  planFileName: z.string().max(200).optional(),
  cwd: z.string().max(500).optional(),
});

const taskReviewNoteSchema = z.object({
  source: z.enum(['ai', 'human']),
  content: z.string().max(20000),
  timestamp: z.string().max(64),
  fromStatus: kaiTaskStatusSchema,
});

const taskReviewResultSchema = z.object({
  agentId: z.string().max(100),
  agentName: z.string().max(200),
  status: z.enum(['pending', 'approved', 'rejected']),
  feedback: z.string().max(20000).optional(),
  timestamp: z.string().max(64).optional(),
  terminalSessionId: z.string().max(100).optional(),
});

const taskRunSchema = z
  .object({
    id: z.string().max(100),
    number: z.number().int().min(0),
    type: z.enum(['execution', 'review']),
    agentId: z.string().max(100),
    agentName: z.string().max(200),
    terminalSessionId: z.string().max(100),
    startedAt: z.string().max(64),
    completedAt: z.string().max(64).optional(),
    exitCode: z.number().int().optional(),
    outcome: z.enum(['promoted', 'blocked', 'rejected', 'approved', 'timeout', 'crashed', 'stopped']).optional(),
    summary: z.string().max(20000).optional(),
  })
  .passthrough();

const taskConversationMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(100000),
  timestamp: z.string().max(64),
});

export const taskUpdateSchema = z
  .object({
    title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
    description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
    status: kaiTaskStatusSchema.optional(),
    startedAt: z.string().max(64).optional(),
    completedAt: z.string().max(64).optional(),
    reviewNotes: z.array(taskReviewNoteSchema).max(500).optional(),
    sourceConversationId: z.string().max(100).optional(),
    sourceToolCallId: z.string().max(100).optional(),
    agentRuntime: z.string().max(100).optional(),
    terminalSessionId: z.string().max(100).optional(),
    metadata: taskMetadataSchema.optional(),
    assignedAgentId: z.string().max(100).nullable().optional(),
    reviewerAgentIds: z.array(z.string().max(100)).max(50).optional(),
    reviewMode: z.enum(['parallel', 'sequential']).optional(),
    reviewResults: z.array(taskReviewResultSchema).max(500).optional(),
    workspaceId: z.string().max(100).optional(),
    conversationHistory: z.array(taskConversationMessageSchema).max(1000).optional(),
    archivedAt: z.string().max(64).optional(),
    priority: z.number().int().min(-100).max(100).optional(),
    completionSummary: z.string().max(20000).optional(),
    lastExitCode: z.number().int().optional(),
    retryCount: z.number().int().min(0).max(100000).optional(),
    unblockAttempts: z.number().int().min(0).max(100000).optional(),
    runs: z.array(taskRunSchema).max(1000).optional(),
    externalLinks: z.array(taskExternalLinkSchema).max(50).optional(),
  })
  .passthrough();

const pluginTaskCreateSchema = z
  .object({
    title: z.string().min(1).max(MAX_TITLE_LENGTH),
    description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
    status: kaiTaskStatusSchema.optional(),
    metadata: taskMetadataSchema.optional(),
    workspaceId: z.string().max(100).optional(),
    priority: z.number().int().min(-100).max(100).optional(),
  })
  .strict();

const pluginTaskUpdateSchema = z
  .object({
    title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
    description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
    status: kaiTaskStatusSchema.optional(),
    metadata: taskMetadataSchema.optional(),
    workspaceId: z.string().max(100).optional(),
    priority: z.number().int().min(-100).max(100).optional(),
  })
  .strict();

const pluginTaskExternalLinkSchema = taskExternalLinkSchema.omit({ pluginName: true, syncedAt: true });
const pluginTaskUpsertExternalSchema = z
  .object({
    external: pluginTaskExternalLinkSchema,
    task: pluginTaskCreateSchema,
    taskId: z
      .string()
      .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
      .optional(),
  })
  .strict();

const pluginTaskMutationOptionsSchema = z.object({ correlationId: z.string().min(1).max(500).optional() }).strict();

const taskOrderSchema = z
  .record(
    kaiTaskStatusSchema,
    z
      .array(
        z
          .string()
          .regex(/^[a-f0-9-]{36}$/)
          .max(36),
      )
      .max(1000),
  )
  .refine((obj) => {
    // Ensure only valid status keys
    const validKeys = new Set(['todo', 'in_progress', 'blocked', 'ai_review', 'human_review', 'done']);
    return Object.keys(obj).every((k) => validKeys.has(k));
  }, 'Invalid status key in order');

const conversationMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(MAX_HISTORY_LENGTH),
  timestamp: z.string().optional(),
});

/** Active plan generation streams, keyed by taskId. */
const activeTaskStreams = new Map<string, { token: symbol; abort: () => void }>();

// ── Async Mutex ─────────────────────────────────────────────────────────

/**
 * Per-task async mutex to prevent concurrent read-modify-write races.
 * Each task ID maps to the tail of a promise chain; new writes await the
 * previous write before proceeding.
 */
const taskLocks = new Map<string, Promise<void>>();

function withTaskLock<T>(taskId: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = taskLocks.get(taskId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn regardless of prev success/failure
  // Store the void-ified chain so subsequent callers wait
  taskLocks.set(
    taskId,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function getTasksDir(appHome: string): string {
  const dir = join(appHome, 'data', 'tasks');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Validate that a task ID is a well-formed UUID to prevent path traversal. */
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function isValidTaskId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

export function broadcastTaskChange(appHome: string, origin: PluginTaskChangeOrigin = { type: 'app' }): void {
  try {
    const tasks = listAllTasks(appHome);
    publishTaskChanges(appHome, listTasks(appHome, { includeArchived: true }), origin);
    // broadcastToAllWindows fans out to every desktop window AND web-bridge
    // clients (via broadcastToWebClients), so the web Tasks view gets live
    // updates too — a plain webContents.send loop would skip web clients.
    broadcastToAllWindows('tasks:changed', tasks);
  } catch (err) {
    console.error('[tasks] Failed to broadcast task change:', err);
  }
}

function broadcastTaskStreamEvent(event: TaskStreamEvent): void {
  broadcastToAllWindows('tasks:stream-event', event);
}

export function listAllTasks(appHome: string): TaskFile[] {
  return listTasks(appHome);
}

export function listTasks(appHome: string, options?: { includeArchived?: boolean }): TaskFile[] {
  const dir = getTasksDir(appHome);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.json') && f !== 'order.json')
    .map((f) => {
      try {
        const raw = readFileSync(join(dir, f), 'utf-8');
        const parsed = JSON.parse(raw) as TaskFile;
        // Validate essential fields — skip corrupt entries
        if (!parsed.id || !parsed.title || !parsed.status) return null;
        return parsed;
      } catch {
        console.warn(`[tasks] Skipping corrupt task file: ${f}`);
        return null;
      }
    })
    .filter((t): t is TaskFile => t !== null && (options?.includeArchived === true || !t.archivedAt))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getTask(appHome: string, id: string): TaskFile | null {
  if (!isValidTaskId(id)) return null;
  const filePath = join(getTasksDir(appHome), `${id}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const task = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
    if (!task.id || !task.title || !task.status) return null;
    warnOnDeprecatedField(task, 'assignedAgent', 'assignedAgentId', 'tasks', 'Task', id);
    return task;
  } catch {
    return null;
  }
}

type TaskOperationError = { error: string };
type TaskOperationResult = TaskFile | TaskOperationError;

function isTaskOperationError(result: TaskOperationResult): result is TaskOperationError {
  return 'error' in result;
}

export function createTask(
  appHome: string,
  taskData: Omit<TaskFile, 'id' | 'createdAt' | 'updatedAt'>,
  origin: PluginTaskChangeOrigin = { type: 'app' },
): TaskOperationResult {
  const parsed = taskCreateSchema.safeParse(taskData);
  if (!parsed.success) {
    return { error: `Invalid task data: ${parsed.error.issues[0]?.message ?? 'validation failed'}` };
  }

  try {
    const id = randomUUID();
    const now = new Date().toISOString();
    const task: TaskFile = { ...taskData, id, createdAt: now, updatedAt: now };
    atomicWriteFileSync(join(getTasksDir(appHome), `${id}.json`), JSON.stringify(task, null, 2));
    broadcastTaskChange(appHome, origin);
    return task;
  } catch (error) {
    console.error('[tasks] Failed to create task:', error);
    return { error: String(error) };
  }
}

export function updateTask(
  appHome: string,
  id: string,
  updates: Partial<TaskFile>,
  origin: PluginTaskChangeOrigin = { type: 'app' },
): Promise<TaskOperationResult> {
  return updateTaskWith(appHome, id, () => updates, origin);
}

function updateTaskWith(
  appHome: string,
  id: string,
  resolveUpdates: (existing: TaskFile) => Partial<TaskFile>,
  origin: PluginTaskChangeOrigin,
): Promise<TaskOperationResult> {
  if (!isValidTaskId(id)) return Promise.resolve({ error: 'Invalid task ID' });
  return withTaskLock(id, () => {
    const filePath = join(getTasksDir(appHome), `${id}.json`);
    if (!existsSync(filePath)) return { error: `Task ${id} not found` };

    try {
      const existing = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
      const updates = resolveUpdates(existing);
      const parsedUpdates = taskUpdateSchema.safeParse(updates);
      if (!parsedUpdates.success) {
        return { error: `Invalid task update: ${parsedUpdates.error.issues[0]?.message ?? 'validation failed'}` };
      }

      if ('status' in updates) {
        const nextStatus = parsedUpdates.data.status;
        if (nextStatus === undefined) {
          return { error: `Invalid task status: ${JSON.stringify(updates.status)}` };
        }
        if (existing.status !== nextStatus && !isValidTransition(existing.status, nextStatus)) {
          return { error: `Invalid transition: ${existing.status} → ${nextStatus}` };
        }
      }

      const cleanUpdates = Object.fromEntries(
        Object.entries(updates).filter(([, value]) => value !== undefined),
      ) as Partial<TaskFile>;
      const skipUpdatedAtKeys: Array<keyof TaskFile> = ['terminalSessionId', 'startedAt', 'completedAt', 'archivedAt'];
      const isMeaningful = Object.keys(cleanUpdates).some((key) => !skipUpdatedAtKeys.includes(key as keyof TaskFile));
      const updated: TaskFile = {
        ...existing,
        ...cleanUpdates,
        id,
        ...(isMeaningful && { updatedAt: new Date().toISOString() }),
      };
      atomicWriteFileSync(filePath, JSON.stringify(updated, null, 2));
      broadcastTaskChange(appHome, origin);
      return updated;
    } catch {
      return { error: `Failed to update task ${id}` };
    }
  });
}

export function unarchiveTask(
  appHome: string,
  id: string,
  origin: PluginTaskChangeOrigin = { type: 'app' },
): TaskOperationResult {
  if (!isValidTaskId(id)) return { error: 'Invalid task ID' };
  const filePath = join(getTasksDir(appHome), `${id}.json`);
  if (!existsSync(filePath)) return { error: `Task ${id} not found` };
  try {
    const existing = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
    const { archivedAt: _removed, ...rest } = existing;
    const updated: TaskFile = { ...rest, updatedAt: new Date().toISOString() };
    atomicWriteFileSync(filePath, JSON.stringify(updated, null, 2));
    broadcastTaskChange(appHome, origin);
    return updated;
  } catch (error) {
    return { error: String(error) };
  }
}

function pluginMutationOrigin(pluginName: string, options?: PluginTaskMutationOptions): PluginTaskChangeOrigin {
  const parsed = pluginTaskMutationOptionsSchema.safeParse(options ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid task mutation options: ${parsed.error.issues[0]?.message ?? 'validation failed'}`);
  }
  return { type: 'plugin', pluginName, ...parsed.data };
}

function unwrapTaskOperation(result: TaskOperationResult): TaskFile {
  if (isTaskOperationError(result)) throw new Error(result.error);
  return result;
}

export function createPluginTask(
  appHome: string,
  pluginName: string,
  input: PluginTaskCreateInput,
  options?: PluginTaskMutationOptions,
): TaskFile {
  const parsed = pluginTaskCreateSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid plugin task: ${parsed.error.issues[0]?.message ?? 'validation failed'}`);
  }
  const status = parsed.data.status ?? 'todo';
  const now = new Date().toISOString();
  return unwrapTaskOperation(
    createTask(
      appHome,
      {
        ...parsed.data,
        description: parsed.data.description ?? '',
        status,
        ...(status === 'in_progress' && { startedAt: now }),
        ...(status === 'done' && { completedAt: now }),
      },
      pluginMutationOrigin(pluginName, options),
    ),
  );
}

export async function updatePluginTask(
  appHome: string,
  pluginName: string,
  id: string,
  input: PluginTaskUpdateInput,
  options?: PluginTaskMutationOptions,
): Promise<TaskFile> {
  const parsed = pluginTaskUpdateSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid plugin task update: ${parsed.error.issues[0]?.message ?? 'validation failed'}`);
  }

  return unwrapTaskOperation(
    await updateTaskWith(
      appHome,
      id,
      (existing) => {
        const now = new Date().toISOString();
        const updates: Partial<TaskFile> = { ...parsed.data };
        if (parsed.data.status === 'done' && existing.status !== 'done') updates.completedAt = now;
        if (parsed.data.status === 'in_progress' && !existing.startedAt) updates.startedAt = now;
        return updates;
      },
      pluginMutationOrigin(pluginName, options),
    ),
  );
}

export async function archivePluginTask(
  appHome: string,
  pluginName: string,
  id: string,
  options?: PluginTaskMutationOptions,
): Promise<TaskFile> {
  return unwrapTaskOperation(
    await updateTask(appHome, id, { archivedAt: new Date().toISOString() }, pluginMutationOrigin(pluginName, options)),
  );
}

export function unarchivePluginTask(
  appHome: string,
  pluginName: string,
  id: string,
  options?: PluginTaskMutationOptions,
): TaskFile {
  return unwrapTaskOperation(unarchiveTask(appHome, id, pluginMutationOrigin(pluginName, options)));
}

export function upsertExternalPluginTask(
  appHome: string,
  pluginName: string,
  input: PluginTaskUpsertExternalInput,
  options?: PluginTaskMutationOptions,
): Promise<{ task: TaskFile; created: boolean }> {
  const parsed = pluginTaskUpsertExternalSchema.safeParse(input);
  if (!parsed.success) {
    return Promise.reject(
      new Error(`Invalid external task upsert: ${parsed.error.issues[0]?.message ?? 'validation failed'}`),
    );
  }
  const { external, task: taskInput, taskId } = parsed.data;
  const lockKey = `external:${pluginName}:${external.source}:${external.externalId}`;

  return withTaskLock(lockKey, async () => {
    const now = new Date().toISOString();
    const externalLink: TaskExternalLink = { ...external, pluginName, syncedAt: now };
    const linkedTask = listTasks(appHome, { includeArchived: true }).find((task) =>
      task.externalLinks?.some(
        (link) =>
          link.pluginName === pluginName && link.source === external.source && link.externalId === external.externalId,
      ),
    );

    if (linkedTask && taskId && linkedTask.id !== taskId) {
      throw new Error(
        `External task ${external.source}:${external.externalId} is already linked to task ${linkedTask.id}`,
      );
    }
    const existing = linkedTask ?? (taskId ? getTask(appHome, taskId) : null);
    if (taskId && !existing) throw new Error(`Task ${taskId} not found`);

    if (!existing) {
      const status = taskInput.status ?? 'todo';
      const created = unwrapTaskOperation(
        createTask(
          appHome,
          {
            ...taskInput,
            description: taskInput.description ?? '',
            status,
            ...(status === 'in_progress' && { startedAt: now }),
            ...(status === 'done' && { completedAt: now }),
            externalLinks: [externalLink],
          },
          pluginMutationOrigin(pluginName, options),
        ),
      );
      return { task: created, created: true };
    }

    const updated = unwrapTaskOperation(
      await updateTaskWith(
        appHome,
        existing.id,
        (current) => {
          const links = (current.externalLinks ?? []).filter(
            (link) =>
              !(
                link.pluginName === pluginName &&
                link.source === external.source &&
                link.externalId === external.externalId
              ),
          );
          const updates: Partial<TaskFile> = { ...taskInput, externalLinks: [...links, externalLink] };
          if (taskInput.status === 'done' && current.status !== 'done') updates.completedAt = now;
          if (taskInput.status === 'in_progress' && !current.startedAt) updates.startedAt = now;
          return updates;
        },
        pluginMutationOrigin(pluginName, options),
      ),
    );
    return { task: updated, created: false };
  });
}

// ── Registration ─────────────────────────────────────────────────────────

export interface TaskHandlerOptions {
  /** Called when a task is kicked back to in_progress. Auto-restarts the assigned agent. */
  onTaskKickedBack?: (taskId: string, assignedAgentId: string | undefined) => void;
  /**
   * Called just before a task file is unlinked. Lets the agent lifecycle stop
   * the assigned running agent (abort its Mastra stream / kill its PTY + reset
   * to idle) so a deleted running task can't keep executing invisibly.
   */
  onTaskDeleted?: (taskId: string, assignedAgentId: string | undefined) => void;
}

export function registerTaskHandlers(ipcMain: IpcMain, appHome: string, options?: TaskHandlerOptions): void {
  // ── CRUD ────────────────────────────────────────────────────────────

  ipcMain.handle('tasks:list', () => {
    return listAllTasks(appHome);
  });

  ipcMain.handle('tasks:list-all', () => {
    return listTasks(appHome, { includeArchived: true });
  });

  ipcMain.handle('tasks:get', (_e, id: string) => {
    return getTask(appHome, id);
  });

  ipcMain.handle('tasks:create', (_e, taskData: Omit<TaskFile, 'id' | 'createdAt' | 'updatedAt'>) => {
    return createTask(appHome, taskData);
  });

  ipcMain.handle('tasks:update', (_e, id: string, updates: Partial<TaskFile>) => {
    return updateTask(appHome, id, updates);
  });

  ipcMain.handle('tasks:unarchive', (_e, id: string) => {
    return unarchiveTask(appHome, id);
  });

  ipcMain.handle('tasks:delete', (_e, id: string) => {
    if (!isValidTaskId(id)) return { error: 'Invalid task ID' };
    try {
      const filePath = join(getTasksDir(appHome), `${id}.json`);
      // Clear the terminal output buffers (memory + disk) for this task's
      // execution + review sessions before removing it, so deleted tasks don't
      // leak orphaned logs in data/terminal-logs. (Stopping a still-running
      // agent on delete is handled separately in the agent lifecycle.)
      if (existsSync(filePath)) {
        try {
          const task = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
          // Stop the assigned running agent BEFORE removing the file, so it
          // can't keep executing against a task that no longer exists.
          if (options?.onTaskDeleted) {
            try {
              options.onTaskDeleted(id, task.assignedAgentId);
            } catch (err) {
              console.warn(`[tasks] onTaskDeleted hook threw for task ${id}:`, err);
            }
          }
          const sessionIds = new Set<string>();
          if (task.terminalSessionId) sessionIds.add(task.terminalSessionId);
          for (const run of task.runs ?? []) if (run.terminalSessionId) sessionIds.add(run.terminalSessionId);
          for (const rr of task.reviewResults ?? []) if (rr.terminalSessionId) sessionIds.add(rr.terminalSessionId);
          for (const sid of sessionIds) clearBuffer(sid);
        } catch {
          /* best-effort — still delete the task file below */
        }
        unlinkSync(filePath);
      }
      broadcastTaskChange(appHome);
      return { ok: true };
    } catch (err) {
      console.error(`[tasks] Failed to delete task ${id}:`, err);
      return { error: String(err) };
    }
  });

  // ── Kick-back (return to in_progress with feedback) ───────────────

  ipcMain.handle('tasks:kick-back', (_e, id: string, reason: string, source: 'ai' | 'human') => {
    if (!isValidTaskId(id)) return { error: 'Invalid task ID' };
    return withTaskLock(id, () => {
      const filePath = join(getTasksDir(appHome), `${id}.json`);
      if (!existsSync(filePath)) return { error: `Task ${id} not found` };

      try {
        const task = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;

        // Only allow kick-back from review statuses
        if (task.status !== 'ai_review' && task.status !== 'human_review') {
          return { error: `Cannot kick back from status: ${task.status}` };
        }

        // Add the review note
        const note: TaskReviewNote = {
          source,
          content: reason,
          timestamp: new Date().toISOString(),
          fromStatus: task.status,
        };
        if (!task.reviewNotes) task.reviewNotes = [];
        task.reviewNotes.push(note);

        // Move back to in_progress
        task.status = 'in_progress';
        task.updatedAt = new Date().toISOString();
        atomicWriteFileSync(filePath, JSON.stringify(task, null, 2));
        broadcastTaskChange(appHome);

        // Auto-restart the assigned agent (regardless of autopilot setting)
        if (task.assignedAgentId && options?.onTaskKickedBack) {
          options.onTaskKickedBack(task.id, task.assignedAgentId);
        }

        return { ok: true };
      } catch (err) {
        return { error: String(err) };
      }
    }); // end withTaskLock
  });

  // ── Column ordering ────────────────────────────────────────────────

  ipcMain.handle('tasks:get-order', () => {
    const filePath = join(getTasksDir(appHome), 'order.json');
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as KaiTaskOrder;
    } catch {
      return null;
    }
  });

  ipcMain.handle('tasks:save-order', (_e, order: KaiTaskOrder) => {
    const parsed = taskOrderSchema.safeParse(order);
    if (!parsed.success) {
      return { error: `Invalid order data: ${parsed.error.issues[0]?.message ?? 'validation failed'}` };
    }

    try {
      atomicWriteFileSync(join(getTasksDir(appHome), 'order.json'), JSON.stringify(order, null, 2));
      return { ok: true };
    } catch (err) {
      console.error('[tasks] Failed to save order:', err);
      return { error: String(err) };
    }
  });

  // ── AI plan streaming ───────────────────────────────────────────────

  ipcMain.handle(
    'tasks:stream-plan',
    async (_e, taskId: string, userMessage: string, existingHistory?: TaskConversationMessage[]) => {
      // Validate taskId to prevent path traversal
      if (!isValidTaskId(taskId)) {
        broadcastTaskStreamEvent({ taskId: taskId ?? '', type: 'error', error: 'Invalid task ID' });
        broadcastTaskStreamEvent({ taskId: taskId ?? '', type: 'done' });
        return { taskId };
      }

      if (!userMessage || typeof userMessage !== 'string' || userMessage.length > MAX_USER_MESSAGE_LENGTH) {
        broadcastTaskStreamEvent({ taskId, type: 'error', error: 'User message too long or invalid' });
        broadcastTaskStreamEvent({ taskId, type: 'done' });
        return { taskId };
      }

      if (existingHistory) {
        const historyCheck = z.array(conversationMessageSchema).max(100).safeParse(existingHistory);
        if (!historyCheck.success) {
          broadcastTaskStreamEvent({ taskId, type: 'error', error: 'Invalid conversation history' });
          broadcastTaskStreamEvent({ taskId, type: 'done' });
          return { taskId };
        }
      }

      // Cancel any existing stream for this task
      const existing = activeTaskStreams.get(taskId);
      if (existing) existing.abort();

      const controller = new AbortController();
      // Token identifies THIS stream so a later stream replacing it under the
      // same taskId isn't torn down by this one's finally (which would make the
      // new stream uncancellable and race plan writes).
      const streamToken = Symbol(taskId);
      activeTaskStreams.set(taskId, { token: streamToken, abort: () => controller.abort() });
      const clearIfCurrent = () => {
        if (activeTaskStreams.get(taskId)?.token === streamToken) {
          activeTaskStreams.delete(taskId);
        }
      };

      // Resolve config and model
      let config: AppConfig;
      try {
        const { readEffectiveConfig } = await import('./config.js');
        config = readEffectiveConfig(appHome);
      } catch {
        broadcastTaskStreamEvent({ taskId, type: 'error', error: 'Failed to load config' });
        broadcastTaskStreamEvent({ taskId, type: 'done' });
        activeTaskStreams.delete(taskId);
        return { taskId };
      }

      const { resolveModelCatalog } = await import('../agent/model-catalog.js');
      const catalog = resolveModelCatalog(config);
      // Prefer a fast/cheap model (Haiku) for plan generation
      const haikuModel = catalog.entries.find((e) => e.modelConfig.modelName.toLowerCase().includes('haiku'));
      const modelEntry = haikuModel ?? catalog.defaultEntry;
      if (!modelEntry) {
        broadcastTaskStreamEvent({ taskId, type: 'error', error: 'No model configured' });
        broadcastTaskStreamEvent({ taskId, type: 'done' });
        activeTaskStreams.delete(taskId);
        return { taskId };
      }

      // Build conversation messages
      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      if (existingHistory) {
        for (const msg of existingHistory) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
      messages.push({ role: 'user', content: userMessage });

      // Stream in background (handler returns immediately)
      void (async () => {
        try {
          const { streamText } = await import('ai');
          const { createLanguageModelFromConfig } = await import('../agent/language-model.js');
          const model = await createLanguageModelFromConfig(modelEntry.modelConfig);

          const result = streamText({
            model,
            system: config.systemPrompts?.taskPlan?.trim() || TASK_PLAN_SYSTEM_PROMPT,
            messages,
            abortSignal: controller.signal,
          });

          let fullText = '';
          for await (const textPart of (await result).textStream) {
            if (controller.signal.aborted) break;
            fullText += textPart;
            broadcastTaskStreamEvent({ taskId, type: 'text-delta', text: textPart });
          }

          // Persist final description to task file
          if (fullText && !controller.signal.aborted) {
            const filePath = join(getTasksDir(appHome), `${taskId}.json`);
            if (existsSync(filePath)) {
              const task = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
              const newHistory: TaskConversationMessage[] = [
                ...(existingHistory ?? []),
                { role: 'user', content: userMessage, timestamp: new Date().toISOString() },
                { role: 'assistant', content: fullText, timestamp: new Date().toISOString() },
              ];
              const updated: TaskFile = {
                ...task,
                description: fullText,
                conversationHistory: newHistory,
                updatedAt: new Date().toISOString(),
              };
              atomicWriteFileSync(filePath, JSON.stringify(updated, null, 2));
              broadcastTaskChange(appHome);
            }
          }

          broadcastTaskStreamEvent({ taskId, type: 'done' });
        } catch (error) {
          if (!controller.signal.aborted) {
            broadcastTaskStreamEvent({
              taskId,
              type: 'error',
              error: error instanceof Error ? error.message : String(error),
            });
            broadcastTaskStreamEvent({ taskId, type: 'done' });
          }
        } finally {
          clearIfCurrent();
        }
      })();

      return { taskId };
    },
  );

  ipcMain.handle('tasks:cancel-stream', (_e, taskId: string) => {
    const stream = activeTaskStreams.get(taskId);
    if (stream) {
      stream.abort();
      activeTaskStreams.delete(taskId);
    }
    return { ok: true };
  });

  // ── AI title generation ─────────────────────────────────────────────

  ipcMain.handle('tasks:generate-title', async (_e, userMessage: string) => {
    if (!userMessage || typeof userMessage !== 'string' || userMessage.length > MAX_USER_MESSAGE_LENGTH) {
      return { title: null };
    }

    let config: AppConfig;
    try {
      const { readEffectiveConfig } = await import('./config.js');
      config = readEffectiveConfig(appHome);
    } catch {
      return { title: null };
    }

    const TASK_TITLE_PROMPT = [
      'Generate a concise task title using at most 6 words.',
      'Summarize what needs to be done, not how.',
      'Use imperative form (e.g. "Add user auth", "Fix sidebar overflow").',
      'Return only the title text with no quotes or formatting.',
    ].join(' ');

    const { generateTitle } = await import('../agent/title-generation.js');
    const title = await generateTitle({
      systemPrompt: TASK_TITLE_PROMPT,
      maxWords: 6,
      input: userMessage,
      config,
    });

    return { title };
  });
}

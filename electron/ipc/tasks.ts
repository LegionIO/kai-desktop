import type { IpcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import type {
  TaskFile,
  KaiTaskOrder,
  TaskConversationMessage,
  TaskStreamEvent,
  TaskReviewNote,
} from '../../shared/task-types.js';
import { isValidTransition } from '../../shared/task-state-machine.js';
import type { AppConfig } from '../config/schema.js';
import { TASK_PLAN_SYSTEM_PROMPT } from '../agent/prompts.js';
import { warnOnDeprecatedField } from '../utils/field-validation.js';
import { clearBuffer } from '../terminal/output-buffer.js';

export type { TaskStreamEvent } from '../../shared/task-types.js';

// ── Validation Schemas ──────────────────────────────────────────────────

const MAX_TITLE_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 50_000;
const MAX_HISTORY_LENGTH = 200_000;
const MAX_USER_MESSAGE_LENGTH = 50_000;

const kaiTaskStatusSchema = z.enum(['todo', 'in_progress', 'blocked', 'ai_review', 'human_review', 'done']);

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
  })
  .passthrough(); // allow additional fields for forward compat

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

function broadcastTaskChange(appHome: string): void {
  try {
    const tasks = listAllTasks(appHome);
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send('tasks:changed', tasks);
    }
  } catch (err) {
    console.error('[tasks] Failed to broadcast task change:', err);
  }
}

function broadcastTaskStreamEvent(event: TaskStreamEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('tasks:stream-event', event);
  }
}

export function listAllTasks(appHome: string): TaskFile[] {
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
    .filter((t): t is TaskFile => t !== null && !t.archivedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ── Registration ─────────────────────────────────────────────────────────

export interface TaskHandlerOptions {
  /** Called when a task is kicked back to in_progress. Auto-restarts the assigned agent. */
  onTaskKickedBack?: (taskId: string, assignedAgentId: string | undefined) => void;
}

export function registerTaskHandlers(ipcMain: IpcMain, appHome: string, options?: TaskHandlerOptions): void {
  // ── CRUD ────────────────────────────────────────────────────────────

  ipcMain.handle('tasks:list', () => {
    return listAllTasks(appHome);
  });

  ipcMain.handle('tasks:list-all', () => {
    // Returns every task including archived — used by the archived filter view.
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
          if (!parsed.id || !parsed.title || !parsed.status) return null;
          return parsed;
        } catch {
          return null;
        }
      })
      .filter((t): t is TaskFile => t !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });

  ipcMain.handle('tasks:get', (_e, id: string) => {
    if (!isValidTaskId(id)) return null;
    const filePath = join(getTasksDir(appHome), `${id}.json`);
    if (!existsSync(filePath)) return null;
    try {
      const task = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;

      // Validate common field naming mistakes
      warnOnDeprecatedField(task, 'assignedAgent', 'assignedAgentId', 'tasks', 'Task', id);

      return task;
    } catch {
      return null;
    }
  });

  ipcMain.handle('tasks:create', (_e, taskData: Omit<TaskFile, 'id' | 'createdAt' | 'updatedAt'>) => {
    const parsed = taskCreateSchema.safeParse(taskData);
    if (!parsed.success) {
      return { error: `Invalid task data: ${parsed.error.issues[0]?.message ?? 'validation failed'}` };
    }

    try {
      const id = randomUUID();
      const now = new Date().toISOString();
      const task: TaskFile = { ...taskData, id, createdAt: now, updatedAt: now };
      writeFileSync(join(getTasksDir(appHome), `${id}.json`), JSON.stringify(task, null, 2), 'utf-8');
      broadcastTaskChange(appHome);
      return task;
    } catch (err) {
      console.error('[tasks] Failed to create task:', err);
      return { error: String(err) };
    }
  });

  ipcMain.handle('tasks:update', (_e, id: string, updates: Partial<TaskFile>) => {
    if (!isValidTaskId(id)) return { error: 'Invalid task ID' };
    return withTaskLock(id, () => {
      const filePath = join(getTasksDir(appHome), `${id}.json`);
      if (!existsSync(filePath)) {
        return { error: `Task ${id} not found` };
      }
      try {
        const existing = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;

        // Validate the status transition whenever the status key is PRESENT.
        // A truthiness-only check let status: undefined/null/'' slip past the
        // state machine and then get spread into the persisted task, wiping the
        // status and dropping the task off the board / out of listAllTasks.
        if ('status' in updates) {
          const parsed = kaiTaskStatusSchema.safeParse(updates.status);
          if (!parsed.success) {
            return { error: `Invalid task status: ${JSON.stringify(updates.status)}` };
          }
          if (existing.status !== parsed.data && !isValidTransition(existing.status, parsed.data)) {
            return { error: `Invalid transition: ${existing.status} → ${parsed.data}` };
          }
        }

        // Strip keys explicitly set to undefined so a `{ field: undefined }`
        // update can't blank out an existing value on merge.
        const cleanUpdates = Object.fromEntries(
          Object.entries(updates).filter(([, v]) => v !== undefined),
        ) as Partial<TaskFile>;

        // Don't bump updatedAt for operational/bookkeeping-only fields.
        // Everything else (status, title, description, metadata, assignedAgentId, …) counts as a meaningful change.
        const SKIP_UPDATED_AT_KEYS: Array<keyof TaskFile> = [
          'terminalSessionId',
          'startedAt',
          'completedAt',
          'archivedAt',
        ];
        const isMeaningful = Object.keys(cleanUpdates).some((k) => !SKIP_UPDATED_AT_KEYS.includes(k as keyof TaskFile));
        const updated: TaskFile = {
          ...existing,
          ...cleanUpdates,
          id, // prevent ID mutation
          ...(isMeaningful && { updatedAt: new Date().toISOString() }),
        };
        writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8');
        broadcastTaskChange(appHome);
        return updated;
      } catch {
        return { error: `Failed to update task ${id}` };
      }
    }); // end withTaskLock
  });

  ipcMain.handle('tasks:unarchive', (_e, id: string) => {
    if (!isValidTaskId(id)) return { error: 'Invalid task ID' };
    const filePath = join(getTasksDir(appHome), `${id}.json`);
    if (!existsSync(filePath)) return { error: `Task ${id} not found` };
    try {
      const existing = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
      const { archivedAt: _removed, ...rest } = existing as TaskFile & { archivedAt?: string };
      const updated = { ...rest, updatedAt: new Date().toISOString() };
      writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8');
      broadcastTaskChange(appHome);
      return updated;
    } catch (err) {
      return { error: String(err) };
    }
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
        writeFileSync(filePath, JSON.stringify(task, null, 2), 'utf-8');
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
      writeFileSync(join(getTasksDir(appHome), 'order.json'), JSON.stringify(order, null, 2), 'utf-8');
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
              writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8');
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

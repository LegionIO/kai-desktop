import type { IpcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { TaskFile, KaiTaskOrder, TaskConversationMessage, TaskStreamEvent } from '../../shared/task-types.js';
import type { AppConfig } from '../config/schema.js';
import { TASK_PLAN_SYSTEM_PROMPT } from '../agent/prompts.js';

export type { TaskStreamEvent } from '../../shared/task-types.js';

/** Active plan generation streams, keyed by taskId. */
const activeTaskStreams = new Map<string, { abort: () => void }>();

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
      win.webContents.send('tasks:changed', tasks);
    }
  } catch (err) {
    console.error('[tasks] Failed to broadcast task change:', err);
  }
}

function broadcastTaskStreamEvent(event: TaskStreamEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('tasks:stream-event', event);
  }
}

function listAllTasks(appHome: string): TaskFile[] {
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
    .filter((t): t is TaskFile => t !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ── Registration ─────────────────────────────────────────────────────────

export function registerTaskHandlers(ipcMain: IpcMain, appHome: string): void {
  // ── CRUD ────────────────────────────────────────────────────────────

  ipcMain.handle('tasks:list', () => {
    return listAllTasks(appHome);
  });

  ipcMain.handle('tasks:get', (_e, id: string) => {
    if (!isValidTaskId(id)) return null;
    const filePath = join(getTasksDir(appHome), `${id}.json`);
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
    } catch {
      return null;
    }
  });

  ipcMain.handle(
    'tasks:create',
    (_e, taskData: Omit<TaskFile, 'id' | 'createdAt' | 'updatedAt'>) => {
      try {
        const id = randomUUID();
        const now = new Date().toISOString();
        const task: TaskFile = { ...taskData, id, createdAt: now, updatedAt: now };
        writeFileSync(
          join(getTasksDir(appHome), `${id}.json`),
          JSON.stringify(task, null, 2),
          'utf-8',
        );
        broadcastTaskChange(appHome);
        return task;
      } catch (err) {
        console.error('[tasks] Failed to create task:', err);
        return { error: String(err) };
      }
    },
  );

  ipcMain.handle('tasks:update', (_e, id: string, updates: Partial<TaskFile>) => {
    if (!isValidTaskId(id)) return { error: 'Invalid task ID' };
    const filePath = join(getTasksDir(appHome), `${id}.json`);
    if (!existsSync(filePath)) {
      return { error: `Task ${id} not found` };
    }
    try {
      const existing = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
      const updated: TaskFile = {
        ...existing,
        ...updates,
        id, // prevent ID mutation
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8');
      broadcastTaskChange(appHome);
      return updated;
    } catch {
      return { error: `Failed to update task ${id}` };
    }
  });

  ipcMain.handle('tasks:delete', (_e, id: string) => {
    if (!isValidTaskId(id)) return { error: 'Invalid task ID' };
    try {
      const filePath = join(getTasksDir(appHome), `${id}.json`);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
      broadcastTaskChange(appHome);
      return { ok: true };
    } catch (err) {
      console.error(`[tasks] Failed to delete task ${id}:`, err);
      return { error: String(err) };
    }
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
    try {
      writeFileSync(
        join(getTasksDir(appHome), 'order.json'),
        JSON.stringify(order, null, 2),
        'utf-8',
      );
      return { ok: true };
    } catch (err) {
      console.error('[tasks] Failed to save order:', err);
      return { error: String(err) };
    }
  });

  // ── AI plan streaming ───────────────────────────────────────────────

  ipcMain.handle(
    'tasks:stream-plan',
    async (
      _e,
      taskId: string,
      userMessage: string,
      existingHistory?: TaskConversationMessage[],
    ) => {
      // Cancel any existing stream for this task
      const existing = activeTaskStreams.get(taskId);
      if (existing) existing.abort();

      const controller = new AbortController();
      activeTaskStreams.set(taskId, { abort: () => controller.abort() });

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
      const haikuModel = catalog.entries.find((e) =>
        e.modelConfig.modelName.toLowerCase().includes('haiku'),
      );
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
          activeTaskStreams.delete(taskId);
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

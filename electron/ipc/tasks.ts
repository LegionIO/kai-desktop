import type { IpcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { TaskFile, KaiTaskOrder, KaiTaskStatus, TaskConversationMessage, TaskStreamEvent } from '../../shared/task-types.js';
import type { AppConfig } from '../config/schema.js';
import { TASK_PLAN_SYSTEM_PROMPT } from '../agent/prompts.js';
import type { PluginManager } from '../plugins/plugin-manager.js';
import type { TaskLifecycleEvent, TaskLifecycleHookArgs, ExecutionDirective } from '../plugins/types.js';
import type { TaskTerminalManager } from '../terminal/task-terminal-manager.js';
import { readConversationStore } from './conversations.js';

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

// ── Lifecycle event detection ────────────────────────────────────────────

function detectLifecycleEvent(
  previousStatus: KaiTaskStatus | undefined,
  newStatus: KaiTaskStatus,
): TaskLifecycleEvent | null {
  if (!previousStatus) return 'task_created';
  if (previousStatus === newStatus) return null;
  if (previousStatus === 'todo' && newStatus === 'in_progress') return 'task_started';
  if (previousStatus === 'in_progress' && (newStatus === 'ai_review' || newStatus === 'human_review')) {
    return 'task_review';
  }
  if (newStatus === 'done') return 'task_completed';
  return 'task_updated';
}

/**
 * Start a non-interactive execution loop triggered by a hook's execute directive.
 * Handles multi-cycle continuation via post-execution hooks.
 */
function startExecutionLoop(
  appHome: string,
  taskId: string,
  directive: ExecutionDirective,
  pluginManager: PluginManager,
  terminalManager: TaskTerminalManager,
): void {
  let cycle = 1;
  const tasksDir = getTasksDir(appHome);
  const filePath = join(tasksDir, `${taskId}.json`);

  const runCycle = (prompt: string, cwd?: string) => {
    terminalManager.createNonInteractive(taskId, {
      runtime: (directive.runtime ?? 'claude-code') as 'claude-code' | 'codex',
      cwd: cwd ?? directive.cwd ?? process.env.HOME ?? '/tmp',
      prompt,
      onComplete: async ({ exitCode, output, sessionId }) => {
        console.info(`[tasks] Execution complete: task=${taskId} exit=${exitCode} cycle=${cycle} output=${output.slice(0, 200)}`);

        // Read current task state for assessment context
        let currentTask: TaskFile;
        try {
          currentTask = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
        } catch {
          console.error(`[tasks] Cannot read task ${taskId} for post-execution assessment`);
          return;
        }

        // Run post-execution hooks (assessment + continuation decision)
        const result = await pluginManager.runPostExecutionHooks({
          taskId,
          exitCode,
          output,
          sessionId,
          cycle,
          task: currentTask,
        }).catch((err) => {
          console.error('[tasks] Post-execution hook error:', err);
          return null;
        });

        // Apply metadata patch if present
        if (result?.metadataPatch) {
          try {
            const task = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
            task.metadata = { ...(task.metadata ?? {}), ...result.metadataPatch };
            task.updatedAt = new Date().toISOString();
            writeFileSync(filePath, JSON.stringify(task, null, 2), 'utf-8');
          } catch (patchErr) {
            console.error('[tasks] Failed to apply post-execution metadata patch:', patchErr);
          }
        }

        if (result?.execute) {
          // Level 1/2: Auto-continue with new prompt
          cycle++;
          console.info(`[tasks] Execution cycle ${cycle} starting for task ${taskId}`);
          runCycle(result.execute.prompt, result.execute.cwd);
        } else if (result?.awaitApproval) {
          // Level 3: Hard stop — move to human_review (keep terminalSessionId for output history)
          try {
            const task = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
            task.status = 'human_review';
            task.updatedAt = new Date().toISOString();
            writeFileSync(filePath, JSON.stringify(task, null, 2), 'utf-8');
            broadcastTaskChange(appHome);
          } catch { /* ignore */ }
        } else {
          // Default: move to human_review on success, keep in_progress on failure
          // Keep terminalSessionId so the output history remains visible
          try {
            const task = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
            task.status = exitCode === 0 ? 'human_review' : 'in_progress';
            task.updatedAt = new Date().toISOString();
            writeFileSync(filePath, JSON.stringify(task, null, 2), 'utf-8');
            broadcastTaskChange(appHome);
          } catch { /* ignore */ }
        }
      },
    }).then((sessionId) => {
      // Update task to in_progress with terminal session
      try {
        const task = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
        task.status = 'in_progress';
        task.terminalSessionId = sessionId;
        task.updatedAt = new Date().toISOString();
        writeFileSync(filePath, JSON.stringify(task, null, 2), 'utf-8');
        broadcastTaskChange(appHome);
      } catch { /* ignore */ }
      console.info(`[tasks] Non-interactive execution started: task=${taskId} session=${sessionId} cycle=${cycle}`);
    }).catch((err) => {
      console.error(`[tasks] Non-interactive execution failed for task ${taskId}:`, err);
    });
  };

  runCycle(directive.prompt);
}

// ── Registration ─────────────────────────────────────────────────────────

export function registerTaskHandlers(
  ipcMain: IpcMain,
  appHome: string,
  pluginManager: PluginManager | null,
  terminalManager?: TaskTerminalManager,
): void {
  // ── CRUD ────────────────────────────────────────────────────────────

  ipcMain.handle('tasks:list', () => {
    return listAllTasks(appHome);
  });

  ipcMain.handle('tasks:list-all', () => {
    // Returns every task including archived — used by the archived filter view.
    const dir = getTasksDir(appHome);
    let files: string[];
    try { files = readdirSync(dir); } catch { return []; }
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

        // Inject source conversation messages into metadata for plugin consumption.
        // When a task is created from a chat conversation, the plugin needs the
        // conversation context to provide to the council advisor.
        if (task.sourceConversationId) {
          try {
            const convStore = readConversationStore(appHome);
            const sourceConvo = convStore.conversations[task.sourceConversationId];
            if (sourceConvo?.messages?.length) {
              // Take last 20 messages, truncate content to prevent metadata bloat
              const relevantMessages = (sourceConvo.messages as Array<{ role?: string; content?: unknown }>).slice(-20).map((m) => ({
                role: (m.role as string) ?? 'user',
                content: typeof m.content === 'string'
                  ? m.content.slice(0, 2000)
                  : JSON.stringify(m.content ?? '').slice(0, 2000),
              }));
              task.metadata = { ...(task.metadata ?? {}), sourceConversation: relevantMessages };
            }
          } catch (convErr) {
            console.warn('[tasks] Failed to inject source conversation:', convErr);
          }
        }

        writeFileSync(
          join(getTasksDir(appHome), `${id}.json`),
          JSON.stringify(task, null, 2),
          'utf-8',
        );
        broadcastTaskChange(appHome);

        // Fire task lifecycle hooks (non-blocking)
        if (pluginManager) {
          pluginManager.runPostTaskLifecycleHooks({
            task,
            event: 'task_created',
            previousStatus: undefined,
            previousTask: undefined,
            changedFields: Object.keys(taskData),
          }).then((hookResult) => {
            if (!hookResult) return;
            const filePath = join(getTasksDir(appHome), `${id}.json`);

            // Apply metadata patch
            if (hookResult.metadataPatch) {
              try {
                const current = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
                current.metadata = { ...(current.metadata ?? {}), ...hookResult.metadataPatch };
                current.updatedAt = new Date().toISOString();
                writeFileSync(filePath, JSON.stringify(current, null, 2), 'utf-8');
                broadcastTaskChange(appHome);
              } catch (patchErr) {
                console.error('[tasks] Failed to apply hook metadata patch (create):', patchErr);
              }
            }

            // Apply status override (e.g. plugin sets 'awaiting_approval')
            if (hookResult.statusOverride) {
              try {
                const current = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
                current.status = hookResult.statusOverride as KaiTaskStatus;
                current.updatedAt = new Date().toISOString();
                writeFileSync(filePath, JSON.stringify(current, null, 2), 'utf-8');
                broadcastTaskChange(appHome);
              } catch (statusErr) {
                console.error('[tasks] Failed to apply hook status override (create):', statusErr);
              }
            }

            // Apply title override (e.g. plan title from council deliberation)
            if (hookResult.titleOverride || hookResult.descriptionOverride) {
              try {
                const current = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
                if (hookResult.titleOverride) current.title = hookResult.titleOverride;
                if (hookResult.descriptionOverride) current.description = hookResult.descriptionOverride;
                current.updatedAt = new Date().toISOString();
                writeFileSync(filePath, JSON.stringify(current, null, 2), 'utf-8');
                broadcastTaskChange(appHome);
              } catch (titleErr) {
                console.error('[tasks] Failed to apply hook title/description override (create):', titleErr);
              }
            }

            // Trigger non-interactive execution if directive present
            if (hookResult.execute && terminalManager) {
              startExecutionLoop(appHome, id, hookResult.execute, pluginManager, terminalManager);
            }
          }).catch((err) => {
            console.error('[tasks] Task lifecycle hook error (create):', err);
          });
        }

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
      // Don't bump updatedAt for operational/bookkeeping-only fields.
      // Everything else (status, title, description, metadata, assignedAgentId, …) counts as a meaningful change.
      const SKIP_UPDATED_AT_KEYS: Array<keyof TaskFile> = [
        'terminalSessionId',
        'startedAt',
        'completedAt',
        'archivedAt',
      ];
      const isMeaningful = Object.keys(updates).some(
        (k) => !SKIP_UPDATED_AT_KEYS.includes(k as keyof TaskFile),
      );
      const updated: TaskFile = {
        ...existing,
        ...updates,
        id, // prevent ID mutation
        ...(isMeaningful && { updatedAt: new Date().toISOString() }),
      };
      writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8');
      broadcastTaskChange(appHome);

      // Fire task lifecycle hooks (non-blocking)
      if (pluginManager) {
        const statusChanged = existing.status !== updated.status;
        const event: TaskLifecycleEvent | null = statusChanged
          ? detectLifecycleEvent(existing.status, updated.status)
          : (isMeaningful ? 'task_updated' : null);
        if (event) {
          pluginManager.runPostTaskLifecycleHooks({
            task: updated,
            event,
            previousStatus: existing.status,
            previousTask: existing,
            changedFields: Object.keys(updates),
          }).then((hookResult) => {
            if (!hookResult) return;

            // Apply metadata patch
            if (hookResult.metadataPatch) {
              try {
                const current = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
                current.metadata = { ...(current.metadata ?? {}), ...hookResult.metadataPatch };
                current.updatedAt = new Date().toISOString();
                writeFileSync(filePath, JSON.stringify(current, null, 2), 'utf-8');
                broadcastTaskChange(appHome);
              } catch (patchErr) {
                console.error('[tasks] Failed to apply hook metadata patch:', patchErr);
              }
            }

            // Apply status override (e.g. plugin sets 'awaiting_approval')
            if (hookResult.statusOverride) {
              try {
                const current = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
                current.status = hookResult.statusOverride as KaiTaskStatus;
                current.updatedAt = new Date().toISOString();
                writeFileSync(filePath, JSON.stringify(current, null, 2), 'utf-8');
                broadcastTaskChange(appHome);
              } catch (statusErr) {
                console.error('[tasks] Failed to apply hook status override:', statusErr);
              }
            }

            // Apply title/description override
            if (hookResult.titleOverride || hookResult.descriptionOverride) {
              try {
                const current = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
                if (hookResult.titleOverride) current.title = hookResult.titleOverride;
                if (hookResult.descriptionOverride) current.description = hookResult.descriptionOverride;
                current.updatedAt = new Date().toISOString();
                writeFileSync(filePath, JSON.stringify(current, null, 2), 'utf-8');
                broadcastTaskChange(appHome);
              } catch (titleErr) {
                console.error('[tasks] Failed to apply hook title/description override:', titleErr);
              }
            }

            // Trigger non-interactive execution if directive present
            if (hookResult.execute && terminalManager) {
              startExecutionLoop(appHome, id, hookResult.execute, pluginManager, terminalManager);
            }
          }).catch((err) => {
            console.error('[tasks] Task lifecycle hook error (update):', err);
          });
        }
      }

      return updated;
    } catch {
      return { error: `Failed to update task ${id}` };
    }
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
      let deletedTask: TaskFile | null = null;
      if (existsSync(filePath)) {
        try {
          deletedTask = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
        } catch { /* proceed with delete even if read fails */ }
        unlinkSync(filePath);
      }
      broadcastTaskChange(appHome);

      // Fire task lifecycle hooks (non-blocking)
      if (pluginManager && deletedTask) {
        pluginManager.runPostTaskLifecycleHooks({
          task: deletedTask,
          event: 'task_deleted',
          previousStatus: deletedTask.status,
          previousTask: deletedTask,
          changedFields: [],
        }).catch((err) => {
          console.error('[tasks] Task lifecycle hook error (delete):', err);
        });
      }

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

  // ── Council Approval ──────────────────────────────────────────────────

  ipcMain.handle('tasks:approve-council', async (_e, taskId: string) => {
    const filePath = join(getTasksDir(appHome), `${taskId}.json`);
    try {
      const task = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;

      if (task.status !== 'awaiting_approval' && task.status !== 'human_review') {
        return { ok: false, error: `Task not in awaiting_approval or human_review (current: ${task.status})` };
      }

      // Plugin stores council data in metadata (extended beyond KaiTaskMetadata)
      const meta = (task.metadata ?? {}) as Record<string, unknown>;
      const plan = meta.councilPlan as string | undefined;
      if (!plan) {
        return { ok: false, error: 'No council plan found in task metadata' };
      }

      // Build execution prompt from stored plan
      const executionPrompt = [
        'You are executing an approved plan. Follow it precisely.',
        '',
        '## Approved Plan',
        plan,
        '',
        '## Task',
        `Title: ${task.title}`,
        `Description: ${task.description || task.title}`,
        '',
        'Execute this plan now. Do not ask questions — proceed with implementation.',
      ].join('\n');

      const runtime = ((meta.chosenExecutor as string) ?? 'claude-code') as 'claude-code' | 'codex';
      const cwd = (meta.cwd as string) ?? process.env.HOME ?? '/tmp';

      // Move to in_progress
      task.status = 'in_progress';
      task.startedAt = task.startedAt ?? new Date().toISOString();
      task.updatedAt = new Date().toISOString();
      writeFileSync(filePath, JSON.stringify(task, null, 2), 'utf-8');
      broadcastTaskChange(appHome);

      // Start execution loop
      if (terminalManager && pluginManager) {
        startExecutionLoop(appHome, taskId, { prompt: executionPrompt, runtime, cwd }, pluginManager, terminalManager);
      }

      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  // Council respond — user answers advisor's clarification questions mid-deliberation
  ipcMain.handle('tasks:council-respond', async (_e, taskId: string, message: string) => {
    const filePath = join(getTasksDir(appHome), `${taskId}.json`);
    try {
      const task = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
      const meta = (task.metadata ?? {}) as Record<string, unknown>;

      if (!pluginManager) {
        return { ok: false, error: 'Plugin manager not available' };
      }

      // Call the Aithena plugin's council:respond action
      await pluginManager.handleAction({
        pluginName: 'aithena',
        targetId: 'council:respond',
        action: 'respond',
        data: {
          taskId,
          message,
          sessionId: meta.councilSessionId as string | undefined,
          taskTitle: task.title,
          taskDescription: task.description,
          taskMetadata: meta,
        },
      });

      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
}

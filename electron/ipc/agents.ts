/**
 * Agents IPC handlers — CRUD + lifecycle management for persistent agent entities.
 *
 * Agents are stored as individual JSON files at ~/.kai/data/agents/{uuid}.json.
 * Follows the same pattern as tasks.ts for consistency.
 */

import type { IpcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { AgentFile, CreateAgentPayload } from '../../shared/agent-types.js';
import type { TaskFile } from '../../shared/task-types.js';
import type { TaskTerminalManager } from '../terminal/task-terminal-manager.js';
import { listAllTasks } from './tasks.js';
import { readEffectiveConfig } from './config.js';
import { warnOnDeprecatedField } from '../utils/field-validation.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

function getAgentsDir(appHome: string): string {
  const dir = join(appHome, 'data', 'agents');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getTasksDir(appHome: string): string {
  return join(appHome, 'data', 'tasks');
}

function listAllAgents(appHome: string): AgentFile[] {
  const dir = getAgentsDir(appHome);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const raw = readFileSync(join(dir, f), 'utf-8');
        const parsed = JSON.parse(raw) as AgentFile;
        if (!parsed.id || !parsed.name || !parsed.runtime) return null;
        return parsed;
      } catch {
        console.warn(`[agents] Skipping corrupt agent file: ${f}`);
        return null;
      }
    })
    .filter((a): a is AgentFile => a !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function readAgent(appHome: string, id: string): AgentFile | null {
  const filePath = join(getAgentsDir(appHome), `${id}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const agent = JSON.parse(readFileSync(filePath, 'utf-8')) as AgentFile;

    // Validate common field naming mistakes
    warnOnDeprecatedField(agent, 'assignedTaskId', 'currentTaskId', 'agents', 'Agent', id);

    return agent;
  } catch {
    return null;
  }
}

function writeAgent(appHome: string, agent: AgentFile): void {
  writeFileSync(join(getAgentsDir(appHome), `${agent.id}.json`), JSON.stringify(agent, null, 2), 'utf-8');
}

function readTask(appHome: string, id: string): TaskFile | null {
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
}

function writeTask(appHome: string, task: TaskFile): void {
  writeFileSync(join(getTasksDir(appHome), `${task.id}.json`), JSON.stringify(task, null, 2), 'utf-8');
}

function broadcastAgentChange(appHome: string): void {
  try {
    const agents = listAllAgents(appHome);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('agents:changed', agents);
    }
  } catch (err) {
    console.error('[agents] Failed to broadcast agent change:', err);
  }
}

function broadcastTaskChange(appHome: string): void {
  try {
    const tasks = listAllTasks(appHome);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('tasks:changed', tasks);
    }
  } catch (err) {
    console.error('[agents] Failed to broadcast task change:', err);
  }
}

/**
 * Decide what state a task should land in once its agent terminal has exited.
 *
 * Exit code conventions:
 *   - 0           → clean exit (success)
 *   - 124         → timeout (treated as crash by convention)
 *   - >1 or <0    → crash / abnormal termination
 *   - 1           → soft failure; treat as needing human review
 *   - undefined   → terminal vanished without an exit code recorded
 */
function analyzeCompletion(
  exitCode: number | undefined,
  options: { requireHumanReview?: boolean },
): { nextStatus: 'human_review' | 'done'; isCrash: boolean } {
  if (exitCode === undefined) {
    // Unknown — be conservative and route to human review.
    return { nextStatus: 'human_review', isCrash: false };
  }
  if (exitCode === 124) {
    return { nextStatus: 'human_review', isCrash: true };
  }
  if (exitCode > 1 || exitCode < 0) {
    return { nextStatus: 'human_review', isCrash: true };
  }
  if (exitCode === 0) {
    return {
      nextStatus: options.requireHumanReview ? 'human_review' : 'done',
      isCrash: false,
    };
  }
  // exitCode === 1 — soft failure, hand to a human.
  return { nextStatus: 'human_review', isCrash: false };
}

/** Returns true if the same calendar day in UTC. */
function isSameUtcDay(a: string | undefined, b: Date): boolean {
  if (!a) return false;
  const d = new Date(a);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getUTCFullYear() === b.getUTCFullYear() &&
    d.getUTCMonth() === b.getUTCMonth() &&
    d.getUTCDate() === b.getUTCDate()
  );
}

// ── Exported helpers (used by the orchestrator) ─────────────────────────

export { listAllAgents };

/**
 * Assign a task to an agent. Used by both the IPC handler and the autopilot
 * dispatcher. Returns `{ ok: true }` on success or `{ error }` on failure.
 */
export function assignTaskToAgent(appHome: string, agentId: string, taskId: string): { ok?: boolean; error?: string } {
  if (!isValidId(agentId)) return { error: 'Invalid agent ID' };
  if (!isValidId(taskId)) return { error: 'Invalid task ID' };

  const agent = readAgent(appHome, agentId);
  if (!agent) return { error: `Agent ${agentId} not found` };
  if (agent.status === 'running') return { error: 'Cannot reassign while agent is running' };

  const task = readTask(appHome, taskId);
  if (!task) return { error: `Task ${taskId} not found` };

  if (agent.currentTaskId && agent.currentTaskId !== taskId) {
    const prevTask = readTask(appHome, agent.currentTaskId);
    if (prevTask) {
      prevTask.assignedAgentId = undefined;
      prevTask.updatedAt = new Date().toISOString();
      writeTask(appHome, prevTask);
    }
  }

  // Clear the previous agent that was assigned to this task (if different)
  if (task.assignedAgentId && task.assignedAgentId !== agentId) {
    const prevAgent = readAgent(appHome, task.assignedAgentId);
    if (prevAgent && prevAgent.currentTaskId === taskId) {
      prevAgent.currentTaskId = undefined;
      prevAgent.updatedAt = new Date().toISOString();
      writeAgent(appHome, prevAgent);
    }
  }

  agent.currentTaskId = taskId;
  agent.updatedAt = new Date().toISOString();
  writeAgent(appHome, agent);

  task.assignedAgentId = agentId;
  task.updatedAt = new Date().toISOString();
  writeTask(appHome, task);

  broadcastAgentChange(appHome);
  broadcastTaskChange(appHome);
  return { ok: true };
}

/**
 * Start an assigned agent. Used by both the IPC handler and the autopilot
 * dispatcher.
 */
export async function startAgentRun(
  appHome: string,
  terminalManager: TaskTerminalManager,
  agentId: string,
): Promise<{ sessionId?: string; error?: string }> {
  if (!isValidId(agentId)) return { error: 'Invalid agent ID' };

  const agent = readAgent(appHome, agentId);
  if (!agent) return { error: `Agent ${agentId} not found` };
  if (agent.status === 'running') return { error: 'Agent is already running' };
  if (!agent.currentTaskId) return { error: 'No task assigned to agent' };

  const task = readTask(appHome, agent.currentTaskId);
  if (!task) return { error: `Assigned task ${agent.currentTaskId} not found` };

  let effectiveRuntime = agent.runtime;
  if (effectiveRuntime === 'auto') {
    const config = readEffectiveConfig(appHome);
    const configRuntime = config?.agent?.runtime;
    if (configRuntime === 'claude-agent-sdk') effectiveRuntime = 'claude-code';
    else if (configRuntime === 'codex-sdk') effectiveRuntime = 'codex';
    else if (configRuntime === 'mastra') effectiveRuntime = 'mastra';
    else effectiveRuntime = 'claude-code';
  }

  const cwd = agent.config.cwd ?? task.metadata?.cwd ?? process.env.HOME ?? '/tmp';

  // Mastra runtime uses the built-in Mastra agent system, not a terminal PTY.
  // We create a virtual session ID so the UI can display streaming output,
  // then run the task through streamAgentResponse.
  if (effectiveRuntime === 'mastra') {
    const virtualSessionId = `mastra-${randomUUID()}`;

    agent.status = 'running';
    agent.terminalSessionId = virtualSessionId;
    agent.stats.lastRunAt = new Date().toISOString();
    agent.updatedAt = new Date().toISOString();
    writeAgent(appHome, agent);

    if (task.status === 'todo') {
      task.status = 'in_progress';
      if (!task.startedAt) task.startedAt = new Date().toISOString();
    }
    task.terminalSessionId = virtualSessionId;
    task.agentRuntime = effectiveRuntime;
    task.updatedAt = new Date().toISOString();
    writeTask(appHome, task);

    broadcastAgentChange(appHome);
    broadcastTaskChange(appHome);

    // Broadcast formatted output to the terminal viewer via the standard channel
    const broadcast = (text: string) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('tasks:terminal-data', { sessionId: virtualSessionId, data: text });
      }
    };

    // Run the Mastra agent asynchronously
    const { streamAgentResponse } = await import('../agent/mastra-agent.js');
    const config = readEffectiveConfig(appHome);

    // Build a simple user message from the task description
    const messages: Array<{ role: string; content: string }> = [
      { role: 'user', content: task.description ?? 'No task description provided.' },
    ];

    // Add agent instructions as system context if available
    if (agent.instructions) {
      messages.unshift({ role: 'system', content: agent.instructions });
    }

    broadcast(`\x1b[1;36m[Mastra Agent]\x1b[0m Starting task: ${task.title}\r\n`);
    broadcast(`\x1b[90m${'-'.repeat(60)}\x1b[0m\r\n`);

    // Run in background — don't await (would block IPC)
    void (async () => {
      try {
        const modelConfig = config?.models?.catalog?.[0] ?? {
          modelName: 'claude-sonnet-4-20250514',
          provider: 'anthropic',
        };
        const dbPath = join(appHome, 'data');
        const tools: unknown[] = []; // Task agents use built-in workspace tools

        const stream = streamAgentResponse(
          `task-${task.id}`,
          messages as unknown[],
          modelConfig as unknown as Parameters<typeof streamAgentResponse>[2],
          config as unknown as Parameters<typeof streamAgentResponse>[3],
          tools as Parameters<typeof streamAgentResponse>[4],
          dbPath,
          { cwd: cwd },
        );

        for await (const event of stream) {
          const ev = event as Record<string, unknown>;
          if (ev.type === 'text-delta' && ev.textDelta) {
            // Convert newlines to terminal-friendly \r\n
            const text = String(ev.textDelta).replace(/\n/g, '\r\n');
            broadcast(text);
          } else if (ev.type === 'tool-call') {
            broadcast(
              `\r\n\x1b[1;33m[Tool]\x1b[0m ${String(ev.toolName ?? 'unknown')}(${JSON.stringify(ev.args ?? {}).slice(0, 100)})\r\n`,
            );
          } else if (ev.type === 'tool-result') {
            const resultStr = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? '');
            const truncated = resultStr.length > 500 ? resultStr.slice(0, 500) + '…' : resultStr;
            broadcast(`\x1b[90m${truncated.replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
          }
        }

        broadcast(`\r\n\x1b[90m${'-'.repeat(60)}\x1b[0m\r\n`);
        broadcast(`\x1b[1;32m[Mastra Agent]\x1b[0m Task completed.\r\n`);
      } catch (err) {
        broadcast(`\r\n\x1b[1;31m[Error]\x1b[0m ${String(err)}\r\n`);
      } finally {
        // Reconcile: mark agent idle, move task to human_review
        const freshAgent = readAgent(appHome, agentId);
        if (freshAgent && freshAgent.status === 'running') {
          freshAgent.status = 'idle';
          freshAgent.terminalSessionId = undefined;
          freshAgent.stats.tasksCompleted = (freshAgent.stats.tasksCompleted ?? 0) + 1;
          freshAgent.updatedAt = new Date().toISOString();
          writeAgent(appHome, freshAgent);
        }
        const freshTask = readTask(appHome, task.id);
        if (freshTask && freshTask.status === 'in_progress') {
          freshTask.status = 'human_review';
          freshTask.terminalSessionId = undefined;
          freshTask.updatedAt = new Date().toISOString();
          writeTask(appHome, freshTask);
        }
        broadcastAgentChange(appHome);
        broadcastTaskChange(appHome);

        // Broadcast terminal exit so the UI knows it's done
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('tasks:terminal-exit', { sessionId: virtualSessionId, exitCode: 0 });
        }
      }
    })();

    return { sessionId: virtualSessionId };
  }

  try {
    const sessionId = await terminalManager.create(agent.currentTaskId, {
      runtime: effectiveRuntime,
      cwd,
      cols: 120,
      rows: 30,
      customArgs: agent.config.customArgs,
      env: agent.config.env,
    });

    agent.status = 'running';
    agent.terminalSessionId = sessionId;
    agent.stats.lastRunAt = new Date().toISOString();
    agent.updatedAt = new Date().toISOString();
    writeAgent(appHome, agent);

    if (task.status === 'todo') {
      task.status = 'in_progress';
    }
    task.terminalSessionId = sessionId;
    task.agentRuntime = effectiveRuntime;
    task.updatedAt = new Date().toISOString();
    writeTask(appHome, task);

    broadcastAgentChange(appHome);
    broadcastTaskChange(appHome);

    // Only auto-write task description to agent-backed runtimes (claude-code, codex)
    // that accept text prompts. Shell-backed runtimes (mastra/default) would execute
    // the description as a shell command — a security risk.
    const promptableRuntimes = ['claude-code', 'codex'];
    if (task.description && promptableRuntimes.includes(effectiveRuntime)) {
      setTimeout(() => {
        const prompt = task.description.trim() + '\n';
        terminalManager.write(sessionId, prompt);
      }, 1500);
    }

    // Register immediate exit callback for fast reconciliation
    terminalManager.onSessionExit(sessionId, (exitCode: number) => {
      const freshAgent = readAgent(appHome, agentId);
      if (!freshAgent || freshAgent.status !== 'running') return;

      const requireHumanReview =
        (freshAgent.config as { requireHumanReview?: boolean } | undefined)?.requireHumanReview === true;
      const { nextStatus, isCrash } = analyzeCompletion(exitCode, { requireHumanReview });

      freshAgent.terminalSessionId = undefined;
      freshAgent.updatedAt = new Date().toISOString();

      if (isCrash) {
        const now = new Date();
        if (!isSameUtcDay(freshAgent.stats.lastCrashAt, now)) {
          freshAgent.stats.crashCount = 0;
        }
        freshAgent.stats.crashCount += 1;
        freshAgent.stats.lastCrashAt = now.toISOString();

        const cap = freshAgent.config.maxCrashesPerDay ?? 5;
        freshAgent.status = freshAgent.stats.crashCount >= cap ? 'error' : 'idle';
      } else {
        freshAgent.status = 'idle';
        freshAgent.stats.tasksCompleted += 1;
      }
      writeAgent(appHome, freshAgent);

      if (freshAgent.currentTaskId) {
        const exitTask = readTask(appHome, freshAgent.currentTaskId);
        if (exitTask) {
          const taskNow = new Date().toISOString();
          exitTask.status = nextStatus;
          exitTask.terminalSessionId = undefined;
          exitTask.updatedAt = taskNow;
          if (nextStatus === 'done') exitTask.completedAt = taskNow;
          writeTask(appHome, exitTask);
          broadcastTaskChange(appHome);
        }
      }
      broadcastAgentChange(appHome);
    });

    return { sessionId };
  } catch (err) {
    return { error: String(err) };
  }
}

// ── Registration ─────────────────────────────────────────────────────────

export function registerAgentHandlers(ipcMain: IpcMain, appHome: string, terminalManager: TaskTerminalManager): void {
  // ── CRUD ────────────────────────────────────────────────────────────

  ipcMain.handle('agents:list', () => {
    return listAllAgents(appHome);
  });

  ipcMain.handle('agents:get', (_e, id: string) => {
    if (!isValidId(id)) return null;
    return readAgent(appHome, id);
  });

  ipcMain.handle('agents:create', (_e, payload: CreateAgentPayload) => {
    try {
      const id = randomUUID();
      const now = new Date().toISOString();
      const agent: AgentFile = {
        id,
        name: payload.name ?? `Agent ${id.slice(0, 6)}`,
        role: payload.role,
        runtime: payload.runtime,
        status: 'idle',
        icon: payload.icon,
        description: payload.description,
        instructions: payload.instructions,
        config: {
          cwd: payload.config?.cwd,
          maxSessionSeconds: payload.config?.maxSessionSeconds,
          maxCrashesPerDay: payload.config?.maxCrashesPerDay ?? 5,
          customArgs: payload.config?.customArgs,
          env: payload.config?.env,
        },
        stats: {
          tasksCompleted: 0,
          totalRuntime: 0,
          crashCount: 0,
        },
        createdAt: now,
        updatedAt: now,
        workspaceId: payload.workspaceId,
      };
      writeAgent(appHome, agent);
      broadcastAgentChange(appHome);
      return agent;
    } catch (err) {
      console.error('[agents] Failed to create agent:', err);
      return { error: String(err) };
    }
  });

  ipcMain.handle('agents:update', (_e, id: string, updates: Partial<AgentFile>) => {
    if (!isValidId(id)) return { error: 'Invalid agent ID' };
    // Validate nested IDs to prevent path traversal via persisted references
    if (updates.currentTaskId && !isValidId(updates.currentTaskId)) {
      return { error: 'Invalid task ID in update' };
    }
    const existing = readAgent(appHome, id);
    if (!existing) return { error: `Agent ${id} not found` };
    try {
      const updated: AgentFile = {
        ...existing,
        ...updates,
        id, // prevent ID mutation
        updatedAt: new Date().toISOString(),
      };
      writeAgent(appHome, updated);
      broadcastAgentChange(appHome);
      return updated;
    } catch {
      return { error: `Failed to update agent ${id}` };
    }
  });

  ipcMain.handle('agents:delete', (_e, id: string) => {
    if (!isValidId(id)) return { error: 'Invalid agent ID' };
    try {
      // Kill any running terminal first
      const agent = readAgent(appHome, id);
      if (agent?.terminalSessionId) {
        terminalManager.kill(agent.terminalSessionId);
      }
      // Unassign from any task
      if (agent?.currentTaskId) {
        const task = readTask(appHome, agent.currentTaskId);
        if (task) {
          task.assignedAgentId = undefined;
          task.updatedAt = new Date().toISOString();
          writeTask(appHome, task);
          broadcastTaskChange(appHome);
        }
      }
      const filePath = join(getAgentsDir(appHome), `${id}.json`);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
      broadcastAgentChange(appHome);
      return { ok: true };
    } catch (err) {
      console.error(`[agents] Failed to delete agent ${id}:`, err);
      return { error: String(err) };
    }
  });

  // ── Task assignment ────────────────────────────────────────────────

  ipcMain.handle('agents:assign-task', (_e, agentId: string, taskId: string) => {
    return assignTaskToAgent(appHome, agentId, taskId);
  });

  ipcMain.handle('agents:unassign-task', (_e, agentId: string) => {
    if (!isValidId(agentId)) return { error: 'Invalid agent ID' };

    const agent = readAgent(appHome, agentId);
    if (!agent) return { error: `Agent ${agentId} not found` };

    // If agent is running, stop it first
    if (agent.status === 'running' && agent.terminalSessionId) {
      terminalManager.kill(agent.terminalSessionId);
      agent.terminalSessionId = undefined;
      agent.status = 'idle';
    } else if (agent.status === 'running') {
      // Force idle if terminal is already gone
      agent.status = 'idle';
    }

    if (agent.currentTaskId) {
      const task = readTask(appHome, agent.currentTaskId);
      if (task) {
        task.assignedAgentId = undefined;
        task.terminalSessionId = undefined;
        task.status = task.status === 'in_progress' ? 'todo' : task.status;
        task.updatedAt = new Date().toISOString();
        writeTask(appHome, task);
        broadcastTaskChange(appHome);
      }
    }

    agent.currentTaskId = undefined;
    agent.updatedAt = new Date().toISOString();
    writeAgent(appHome, agent);

    broadcastAgentChange(appHome);
    return { ok: true };
  });

  // ── Lifecycle: start / stop ────────────────────────────────────────

  ipcMain.handle('agents:start', async (_e, agentId: string) => {
    return startAgentRun(appHome, terminalManager, agentId);
  });

  ipcMain.handle('agents:stop', (_e, agentId: string) => {
    if (!isValidId(agentId)) return { error: 'Invalid agent ID' };

    const agent = readAgent(appHome, agentId);
    if (!agent) return { error: `Agent ${agentId} not found` };

    // Kill terminal if one exists (regardless of agent.status)
    if (agent.terminalSessionId) {
      terminalManager.kill(agent.terminalSessionId);
    }

    // Force agent to idle
    agent.status = 'idle';
    agent.terminalSessionId = undefined;
    agent.updatedAt = new Date().toISOString();
    writeAgent(appHome, agent);

    // Update task: clear terminal, move to human_review if in_progress
    if (agent.currentTaskId) {
      const task = readTask(appHome, agent.currentTaskId);
      if (task) {
        task.terminalSessionId = undefined;
        if (task.status === 'in_progress') {
          task.status = 'human_review';
        }
        task.updatedAt = new Date().toISOString();
        writeTask(appHome, task);
        broadcastTaskChange(appHome);
      }
    }

    broadcastAgentChange(appHome);
    return { ok: true };
  });

  // ── Prompt Synthesis (background, after creation) ─────────────────────

  ipcMain.handle('agents:synthesize-prompt', async (_e, agentId: string, userDescription: string) => {
    if (!isValidId(agentId)) return { error: 'Invalid agent ID' };

    try {
      const config = readEffectiveConfig(appHome);

      // Step 1: Match role AND generate a thematic name using Haiku (single call)
      const { matchAgentRole } = await import('../agent/agent-role-matching.js');
      const existingNames = listAllAgents(appHome)
        .filter((a) => a.id !== agentId)
        .map((a) => a.name);
      const { role: matchedRole, name: generatedName } = await matchAgentRole(userDescription, config, existingNames);

      // Step 2: Apply name immediately — don't wait for the slower synthesis steps
      if (generatedName) {
        const agentForName = readAgent(appHome, agentId);
        if (agentForName) {
          agentForName.name = generatedName;
          agentForName.matchedRoleId = matchedRole?.id;
          agentForName.updatedAt = new Date().toISOString();
          writeAgent(appHome, agentForName);
          broadcastAgentChange(appHome);
        }
      }

      // Step 3: Fetch role template from GitHub (if matched)
      let roleTemplate: string | null = null;
      if (matchedRole) {
        const { fetchRoleTemplate } = await import('../agent/agent-role-fetching.js');
        roleTemplate = await fetchRoleTemplate(matchedRole.id);
      }

      // Step 4: Synthesize system prompt using profile model
      const { synthesizeAgentPrompt } = await import('../agent/agent-prompt-synthesis.js');
      const synthesizedInstructions = await synthesizeAgentPrompt(roleTemplate, userDescription, config);

      // Step 5: Update agent with synthesized instructions (name already written above)
      const agent = readAgent(appHome, agentId);
      if (!agent) return { error: 'Agent not found' };

      agent.instructions = synthesizedInstructions;
      agent.updatedAt = new Date().toISOString();
      writeAgent(appHome, agent);

      // Step 6: Broadcast final state with synthesized instructions
      broadcastAgentChange(appHome);

      return { ok: true, matchedRole: matchedRole?.name ?? null, name: generatedName || null };
    } catch (error) {
      console.error('[agents] Prompt synthesis failed:', error);
      return { error: String(error) };
    }
  });

  // ── Terminal exit listener ─────────────────────────────────────────
  // Periodically reconcile agent status with terminal state.
  // If a terminal has exited (removed from manager), update the agent.

  const reconcileInterval = setInterval(() => {
    const agents = listAllAgents(appHome);
    for (const agent of agents) {
      if (agent.status === 'running' && agent.terminalSessionId) {
        // The terminal manager removes entries on exit, so if write throws
        // or does nothing on a missing session, the terminal is gone.
        try {
          terminalManager.write(agent.terminalSessionId, '');
        } catch {
          // Terminal is gone — read fresh agent state and reconcile.
          const freshAgent = readAgent(appHome, agent.id);
          if (!freshAgent || freshAgent.status !== 'running') continue;

          const sessionId = freshAgent.terminalSessionId;
          const exitCode = sessionId ? terminalManager.consumeExitCode(sessionId) : undefined;

          // Optional per-agent override: route every completion through human review.
          const requireHumanReview =
            (freshAgent.config as { requireHumanReview?: boolean } | undefined)?.requireHumanReview === true;

          const { nextStatus, isCrash } = analyzeCompletion(exitCode, {
            requireHumanReview,
          });

          // Update agent
          freshAgent.terminalSessionId = undefined;
          freshAgent.updatedAt = new Date().toISOString();

          if (isCrash) {
            const now = new Date();
            // Reset crash counter at UTC day boundary
            if (!isSameUtcDay(freshAgent.stats.lastCrashAt, now)) {
              freshAgent.stats.crashCount = 0;
            }
            freshAgent.stats.crashCount += 1;
            freshAgent.stats.lastCrashAt = now.toISOString();

            const cap = freshAgent.config.maxCrashesPerDay ?? 5;
            if (freshAgent.stats.crashCount >= cap) {
              freshAgent.status = 'error';
            } else {
              freshAgent.status = 'idle';
            }
          } else {
            freshAgent.status = 'idle';
            freshAgent.stats.tasksCompleted += 1;
          }
          writeAgent(appHome, freshAgent);

          // Move task to next status
          if (freshAgent.currentTaskId) {
            const task = readTask(appHome, freshAgent.currentTaskId);
            if (task) {
              const taskNow = new Date().toISOString();
              task.status = nextStatus;
              task.terminalSessionId = undefined;
              task.updatedAt = taskNow;
              if (nextStatus === 'done') {
                task.completedAt = taskNow;
              }
              writeTask(appHome, task);
              broadcastTaskChange(appHome);
            }
          }
          broadcastAgentChange(appHome);
        }
      }
    }
  }, 5000);

  // Clean up on app quit
  process.on('beforeExit', () => clearInterval(reconcileInterval));
}

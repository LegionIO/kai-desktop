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
import type { AgentFile, HireAgentPayload } from '../../shared/agent-types.js';
import type { TaskFile } from '../../shared/task-types.js';
import type { TaskTerminalManager } from '../terminal/task-terminal-manager.js';

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
    return JSON.parse(readFileSync(filePath, 'utf-8')) as AgentFile;
  } catch {
    return null;
  }
}

function writeAgent(appHome: string, agent: AgentFile): void {
  writeFileSync(
    join(getAgentsDir(appHome), `${agent.id}.json`),
    JSON.stringify(agent, null, 2),
    'utf-8',
  );
}

function readTask(appHome: string, id: string): TaskFile | null {
  const filePath = join(getTasksDir(appHome), `${id}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as TaskFile;
  } catch {
    return null;
  }
}

function writeTask(appHome: string, task: TaskFile): void {
  writeFileSync(
    join(getTasksDir(appHome), `${task.id}.json`),
    JSON.stringify(task, null, 2),
    'utf-8',
  );
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
    const dir = getTasksDir(appHome);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      return;
    }
    const tasks = files
      .filter((f) => f.endsWith('.json') && f !== 'order.json')
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), 'utf-8')) as TaskFile;
        } catch {
          return null;
        }
      })
      .filter((t): t is TaskFile => t !== null);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('tasks:changed', tasks);
    }
  } catch (err) {
    console.error('[agents] Failed to broadcast task change:', err);
  }
}

// ── Registration ─────────────────────────────────────────────────────────

export function registerAgentHandlers(
  ipcMain: IpcMain,
  appHome: string,
  terminalManager: TaskTerminalManager,
): void {
  // ── CRUD ────────────────────────────────────────────────────────────

  ipcMain.handle('agents:list', () => {
    return listAllAgents(appHome);
  });

  ipcMain.handle('agents:get', (_e, id: string) => {
    if (!isValidId(id)) return null;
    return readAgent(appHome, id);
  });

  ipcMain.handle('agents:create', (_e, payload: HireAgentPayload) => {
    try {
      const id = randomUUID();
      const now = new Date().toISOString();
      const agent: AgentFile = {
        id,
        name: payload.name,
        role: payload.role,
        runtime: payload.runtime,
        status: 'idle',
        icon: payload.icon,
        description: payload.description,
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
    if (!isValidId(agentId)) return { error: 'Invalid agent ID' };
    if (!isValidId(taskId)) return { error: 'Invalid task ID' };

    const agent = readAgent(appHome, agentId);
    if (!agent) return { error: `Agent ${agentId} not found` };
    if (agent.status === 'running') return { error: 'Cannot reassign while agent is running' };

    const task = readTask(appHome, taskId);
    if (!task) return { error: `Task ${taskId} not found` };

    // Unassign from previous task if any
    if (agent.currentTaskId && agent.currentTaskId !== taskId) {
      const prevTask = readTask(appHome, agent.currentTaskId);
      if (prevTask) {
        prevTask.assignedAgentId = undefined;
        prevTask.updatedAt = new Date().toISOString();
        writeTask(appHome, prevTask);
      }
    }

    // Assign agent to task
    agent.currentTaskId = taskId;
    agent.updatedAt = new Date().toISOString();
    writeAgent(appHome, agent);

    // Set task's assignedAgentId
    task.assignedAgentId = agentId;
    task.updatedAt = new Date().toISOString();
    writeTask(appHome, task);

    broadcastAgentChange(appHome);
    broadcastTaskChange(appHome);
    return { ok: true };
  });

  ipcMain.handle('agents:unassign-task', (_e, agentId: string) => {
    if (!isValidId(agentId)) return { error: 'Invalid agent ID' };

    const agent = readAgent(appHome, agentId);
    if (!agent) return { error: `Agent ${agentId} not found` };
    if (agent.status === 'running') return { error: 'Cannot unassign while agent is running' };

    if (agent.currentTaskId) {
      const task = readTask(appHome, agent.currentTaskId);
      if (task) {
        task.assignedAgentId = undefined;
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
    if (!isValidId(agentId)) return { error: 'Invalid agent ID' };

    const agent = readAgent(appHome, agentId);
    if (!agent) return { error: `Agent ${agentId} not found` };
    if (agent.status === 'running') return { error: 'Agent is already running' };
    if (!agent.currentTaskId) return { error: 'No task assigned to agent' };

    const task = readTask(appHome, agent.currentTaskId);
    if (!task) return { error: `Assigned task ${agent.currentTaskId} not found` };

    // Determine working directory
    const cwd = agent.config.cwd ?? task.metadata?.cwd ?? process.env.HOME ?? '/tmp';

    try {
      const sessionId = await terminalManager.create(agent.currentTaskId, {
        runtime: agent.runtime,
        cwd,
        cols: 120,
        rows: 30,
      });

      // Update agent state
      agent.status = 'running';
      agent.terminalSessionId = sessionId;
      agent.stats.lastRunAt = new Date().toISOString();
      agent.updatedAt = new Date().toISOString();
      writeAgent(appHome, agent);

      // Update task state
      if (task.status === 'todo') {
        task.status = 'in_progress';
      }
      task.terminalSessionId = sessionId;
      task.agentRuntime = agent.runtime;
      task.updatedAt = new Date().toISOString();
      writeTask(appHome, task);

      broadcastAgentChange(appHome);
      broadcastTaskChange(appHome);

      // If task has a description, feed it as the initial prompt after a small delay
      if (task.description && (agent.runtime === 'claude-code' || agent.runtime === 'codex')) {
        setTimeout(() => {
          const prompt = task.description.trim() + '\n';
          terminalManager.write(sessionId, prompt);
        }, 1500);
      }

      return { sessionId };
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('agents:stop', (_e, agentId: string) => {
    if (!isValidId(agentId)) return { error: 'Invalid agent ID' };

    const agent = readAgent(appHome, agentId);
    if (!agent) return { error: `Agent ${agentId} not found` };
    if (agent.status !== 'running') return { error: 'Agent is not running' };

    // Kill terminal
    if (agent.terminalSessionId) {
      terminalManager.kill(agent.terminalSessionId);
    }

    // Update agent state
    agent.status = 'idle';
    agent.terminalSessionId = undefined;
    agent.updatedAt = new Date().toISOString();
    writeAgent(appHome, agent);

    // Clear terminal from task
    if (agent.currentTaskId) {
      const task = readTask(appHome, agent.currentTaskId);
      if (task) {
        task.terminalSessionId = undefined;
        task.updatedAt = new Date().toISOString();
        writeTask(appHome, task);
        broadcastTaskChange(appHome);
      }
    }

    broadcastAgentChange(appHome);
    return { ok: true };
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
          // Terminal is gone — update agent status
          const freshAgent = readAgent(appHome, agent.id);
          if (freshAgent && freshAgent.status === 'running') {
            freshAgent.status = 'idle';
            freshAgent.terminalSessionId = undefined;
            freshAgent.updatedAt = new Date().toISOString();
            freshAgent.stats.tasksCompleted += 1;
            writeAgent(appHome, freshAgent);

            // Move task to human_review
            if (freshAgent.currentTaskId) {
              const task = readTask(appHome, freshAgent.currentTaskId);
              if (task) {
                task.status = 'human_review';
                task.terminalSessionId = undefined;
                task.updatedAt = new Date().toISOString();
                writeTask(appHome, task);
                broadcastTaskChange(appHome);
              }
            }
            broadcastAgentChange(appHome);
          }
        }
      }
    }
  }, 5000);

  // Clean up on app quit
  process.on('beforeExit', () => clearInterval(reconcileInterval));
}

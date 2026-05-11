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
    const tasks = listAllTasks(appHome);
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

    // Resolve effective runtime (auto → user's preferred runtime from config)
    let effectiveRuntime = agent.runtime;
    if (effectiveRuntime === 'auto') {
      const config = readEffectiveConfig(appHome);
      const configRuntime = config?.agent?.runtime;
      // Map config runtime IDs to agent runtime IDs
      if (configRuntime === 'claude-agent-sdk') effectiveRuntime = 'claude-code';
      else if (configRuntime === 'codex-sdk') effectiveRuntime = 'codex';
      else if (configRuntime === 'mastra') effectiveRuntime = 'mastra';
      else effectiveRuntime = 'claude-code'; // fallback
    }

    // Determine working directory
    const cwd = agent.config.cwd ?? task.metadata?.cwd ?? process.env.HOME ?? '/tmp';

    try {
      const sessionId = await terminalManager.create(agent.currentTaskId, {
        runtime: effectiveRuntime,
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
      task.agentRuntime = effectiveRuntime;
      task.updatedAt = new Date().toISOString();
      writeTask(appHome, task);

      broadcastAgentChange(appHome);
      broadcastTaskChange(appHome);

      // If task has a description, feed it as the initial prompt after a small delay
      if (task.description && (effectiveRuntime === 'claude-code' || effectiveRuntime === 'codex')) {
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

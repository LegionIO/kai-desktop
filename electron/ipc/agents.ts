/**
 * Agents IPC handlers — CRUD + lifecycle management for persistent agent entities.
 *
 * Agents are stored as individual JSON files at ~/.kai/data/agents/{uuid}.json.
 * Follows the same pattern as tasks.ts for consistency.
 */

import type { IpcMain } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { AgentFile, CreateAgentPayload } from '../../shared/agent-types.js';
import type { TaskFile, TaskReviewResult, TaskRun } from '../../shared/task-types.js';
import type { TaskTerminalManager } from '../terminal/task-terminal-manager.js';
import { analyzeCompletion as analyzeCompletionCore } from '../agent/task-completion.js';
import { broadcastToAllWindows } from '../utils/window-send.js';
import { z } from 'zod';
import { appendOutput, getBuffer } from '../terminal/output-buffer.js';
import { listAllTasks } from './tasks.js';
import { readEffectiveConfig } from './config.js';
import { DEFAULT_AGENT_ENV_DENYLIST, DEFAULT_AGENT_ARGS_DENYLIST } from '../config/schema.js';
import { getRegisteredTools } from './agent.js';
import { resolveModelCatalog } from '../agent/model-catalog.js';
import { warnOnDeprecatedField } from '../utils/field-validation.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** AbortControllers for running Mastra virtual sessions (keyed by sessionId). */
const mastraAbortControllers = new Map<string, AbortController>();

/** Module-level ref to terminal manager — set during registration, used by autoRestartAgent. */
let _terminalManager: TaskTerminalManager | null = null;
let _appHome: string | null = null;

/**
 * Auto-restart an agent after kick-back (AI review rejection or human request changes).
 * This runs regardless of autopilot state — it's re-executing work that was already assigned.
 */
async function autoRestartAgent(appHome: string, agentId: string): Promise<void> {
  if (!_terminalManager) return;
  try {
    const result = await startAgentRun(appHome, _terminalManager, agentId);
    if (result.error) {
      console.warn(`[Agent:task] Auto-restart failed for agent ${agentId}: ${result.error}`);
    } else {
      console.info(`[Agent:task] Auto-restart succeeded for agent ${agentId} session=${result.sessionId}`);
    }
  } catch (err) {
    console.warn(`[Agent:task] Auto-restart threw for agent ${agentId}:`, err);
  }
}

function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

/**
 * Fully stop an agent's execution: abort a Mastra virtual-session stream (for
 * which terminalManager.kill is a no-op) AND kill a real PTY. Used by stop,
 * unassign, and delete so a Mastra run can't keep streaming after any of them.
 */
function stopAgentExecution(terminalManager: TaskTerminalManager, sessionId: string | undefined): void {
  if (!sessionId) return;
  const abortCtrl = mastraAbortControllers.get(sessionId);
  if (abortCtrl) {
    abortCtrl.abort();
    mastraAbortControllers.delete(sessionId);
  }
  try {
    terminalManager.kill(sessionId);
  } catch {
    /* best-effort */
  }
}

// ── Runtime / env / arg validation ──────────────────────────────────────
//
// Persisted agents carry caller-supplied `runtime`, `config.env`, and
// `config.customArgs`. These flow into a PTY in startAgentRun(), so we
// validate runtime against a fixed allowlist at write time and filter
// env/args through a configurable dual deny+allowlist at run time.

/** Runtimes an AgentFile may persist. Mirrors shared/agent-types.ts AgentRuntime. */
const ALLOWED_AGENT_RUNTIMES: ReadonlySet<string> = new Set(['auto', 'claude-code', 'codex', 'mastra']);

function isValidAgentRuntime(runtime: unknown): runtime is AgentFile['runtime'] {
  return typeof runtime === 'string' && ALLOWED_AGENT_RUNTIMES.has(runtime);
}

/**
 * Match a value against a simple glob pattern supporting `*` as a prefix
 * and/or suffix wildcard only (no mid-string globs, no regex).
 * Comparison is case-insensitive to catch `Path` / `path` on macOS.
 */
function matchesGlob(value: string, pattern: string): boolean {
  const v = value.toLowerCase();
  const p = pattern.toLowerCase();
  const leading = p.startsWith('*');
  const trailing = p.endsWith('*');
  const core = p.slice(leading ? 1 : 0, trailing ? p.length - 1 : p.length);
  if (leading && trailing) return core === '' || v.includes(core);
  if (leading) return v.endsWith(core);
  if (trailing) return v.startsWith(core);
  return v === core;
}

function matchesAny(value: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesGlob(value, p));
}

/**
 * Filter agent env vars through a dual deny+allowlist.
 * - Drop any key matching a denylist pattern.
 * - If allowlist is non-empty, additionally drop any key NOT matching it.
 */
export function filterAgentEnv(
  env: Record<string, string> | undefined,
  denylist: readonly string[],
  allowlist: readonly string[] | undefined,
): Record<string, string> {
  if (!env) return {};
  const useAllowlist = Array.isArray(allowlist) && allowlist.length > 0;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(env)) {
    if (typeof key !== 'string' || typeof val !== 'string') continue;
    if (matchesAny(key, denylist)) continue;
    if (useAllowlist && !matchesAny(key, allowlist)) continue;
    out[key] = val;
  }
  return out;
}

/**
 * Filter agent CLI args through a dual deny+allowlist.
 * - Drop any arg matching a denylist pattern.
 * - If allowlist is non-empty, additionally drop any arg NOT matching it.
 */
export function filterAgentArgs(
  args: readonly string[] | undefined,
  denylist: readonly string[],
  allowlist: readonly string[] | undefined,
): string[] {
  if (!Array.isArray(args)) return [];
  const useAllowlist = Array.isArray(allowlist) && allowlist.length > 0;
  return args.filter((arg) => {
    if (typeof arg !== 'string') return false;
    if (matchesAny(arg, denylist)) return false;
    if (useAllowlist && !matchesAny(arg, allowlist)) return false;
    return true;
  });
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
    // Fan out to desktop windows AND web-bridge clients so the web Agents view
    // updates live (a plain webContents.send loop would skip web clients).
    broadcastToAllWindows('agents:changed', agents);
  } catch (err) {
    console.error('[agents] Failed to broadcast agent change:', err);
  }
}

function broadcastTaskChange(appHome: string): void {
  try {
    const tasks = listAllTasks(appHome);
    broadcastToAllWindows('tasks:changed', tasks);
  } catch (err) {
    console.error('[agents] Failed to broadcast task change:', err);
  }
}

// ── Multi-Reviewer Process ──────────────────────────────────────────────────

/**
 * Run a single reviewer agent against a task. Returns the review result.
 * Each reviewer gets its own virtual terminal session for output isolation.
 */
async function runSingleReviewer(
  appHome: string,
  task: TaskFile,
  reviewerAgentId: string,
  executorOutput: string,
): Promise<TaskReviewResult> {
  // Validate the reviewer id before it reaches readAgent() (which joins it into
  // a file path) — a non-UUID id could path-traverse. Fail the review rather
  // than run with a missing agent's "Unknown Reviewer" fallback instructions.
  if (!isValidId(reviewerAgentId)) {
    return {
      agentId: String(reviewerAgentId),
      agentName: 'Invalid Reviewer',
      status: 'rejected',
      feedback: 'Reviewer agent id is not a valid identifier.',
      terminalSessionId: `review-invalid-${randomUUID()}`,
    };
  }
  const agent = readAgent(appHome, reviewerAgentId);
  if (!agent) {
    return {
      agentId: reviewerAgentId,
      agentName: 'Missing Reviewer',
      status: 'rejected',
      feedback: 'Reviewer agent no longer exists.',
      terminalSessionId: `review-missing-${randomUUID()}`,
    };
  }
  const agentName = agent.name;
  const virtualSessionId = `review-${task.id}-${reviewerAgentId}-${randomUUID()}`;

  // Initialize result
  const result: TaskReviewResult = {
    agentId: reviewerAgentId,
    agentName,
    status: 'pending',
    terminalSessionId: virtualSessionId,
  };

  // Update the task's reviewResults with the session ID
  const freshTask = readTask(appHome, task.id);
  if (freshTask?.reviewResults) {
    const idx = freshTask.reviewResults.findIndex((r) => r.agentId === reviewerAgentId);
    if (idx >= 0) {
      freshTask.reviewResults[idx].terminalSessionId = virtualSessionId;
      writeTask(appHome, freshTask);
      broadcastTaskChange(appHome);
    }
  }

  // Record review run in audit trail
  const freshTaskForRun = readTask(appHome, task.id);
  if (freshTaskForRun) {
    const reviewRun: TaskRun = {
      id: randomUUID(),
      number: (freshTaskForRun.runs?.length ?? 0) + 1,
      type: 'review',
      agentId: reviewerAgentId,
      agentName,
      terminalSessionId: virtualSessionId,
      startedAt: new Date().toISOString(),
    };
    freshTaskForRun.runs = [...(freshTaskForRun.runs ?? []), reviewRun];
    writeTask(appHome, freshTaskForRun);
  }

  const broadcast = (text: string) => {
    appendOutput(virtualSessionId, text);
    broadcastToAllWindows('tasks:terminal-data', { sessionId: virtualSessionId, data: text });
  };

  broadcast(`\x1b[1;35m[Reviewer: ${agentName}]\x1b[0m Starting review of task: ${task.title}\r\n`);
  broadcast(`\x1b[90m${'-'.repeat(60)}\x1b[0m\r\n`);

  try {
    const { streamAgentResponse } = await import('../agent/mastra-agent.js');
    const config = readEffectiveConfig(appHome);

    const catalog = resolveModelCatalog(config as Parameters<typeof resolveModelCatalog>[0]);
    const defaultKey = (config as { models?: { defaultModelKey?: string } })?.models?.defaultModelKey;
    const modelEntry = defaultKey
      ? (catalog.byKey.get(defaultKey) ?? catalog.defaultEntry)
      : (catalog.defaultEntry ?? catalog.entries[0]);

    if (!modelEntry) {
      broadcast(`\r\n\x1b[1;31m[Error]\x1b[0m No model configured for reviewer.\r\n`);
      result.status = 'rejected';
      result.feedback = 'Review failed: no model configured.';
      result.timestamp = new Date().toISOString();
      return result;
    }

    broadcast(
      `\x1b[90mUsing model: ${modelEntry.modelConfig.modelName} (${modelEntry.modelConfig.provider})\x1b[0m\r\n`,
    );
    broadcast(`\x1b[90m${'-'.repeat(60)}\x1b[0m\r\n\r\n`);

    // Build reviewer system prompt
    const reviewSystemPrompt = [
      agent?.instructions ?? 'You are a code reviewer. Review work for quality, correctness, and completeness.',
      '',
      '## Review Mode',
      '',
      'You are reviewing work done on a task. Your job is to:',
      '1. Read the task description carefully.',
      "2. Review the executor's output to verify the work was done correctly.",
      '3. Check for quality, correctness, completeness, and potential issues.',
      '4. Call `approve_review` if the work is satisfactory.',
      '5. Call `reject_review` with specific, actionable feedback if the work needs improvement.',
      '',
      'You MUST call exactly one of: `approve_review` or `reject_review`. Do NOT end without calling one.',
    ].join('\n');

    // Build user message with task info and executor output
    const userMessage = [
      '## Task Under Review',
      '',
      `**Title:** ${task.title}`,
      '',
      `**Description:** ${task.description ?? 'No description'}`,
      '',
      `**Completion Summary:** ${task.completionSummary ?? 'No summary provided'}`,
      '',
      '## Executor Terminal Output',
      '',
      '```',
      executorOutput.slice(0, 50000), // Limit to 50k chars to avoid context overflow
      '```',
    ].join('\n');

    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: reviewSystemPrompt },
      { role: 'user', content: userMessage },
    ];

    // Review outcome tracking
    let reviewDecision: 'approved' | 'rejected' | null = null;
    let reviewFeedback: string | undefined;

    // Review tools
    const reviewTools = [
      {
        name: 'approve_review',
        description: 'Approve the reviewed work. Call this when the task was completed correctly and satisfactorily.',
        inputSchema: z.object({
          comment: z.string().optional().describe('Optional brief comment on the quality of the work'),
        }),
        execute: async (input: unknown) => {
          const { comment } = input as { comment?: string };
          reviewDecision = 'approved';
          reviewFeedback = comment;
          return { success: true, decision: 'approved', message: 'Review approved.' };
        },
      },
      {
        name: 'reject_review',
        description: 'Reject the reviewed work. Call this when the task has issues that need to be addressed.',
        inputSchema: z.object({
          reason: z.string().describe('Specific, actionable feedback on what needs to be fixed'),
        }),
        execute: async (input: unknown) => {
          const { reason } = input as { reason: string };
          reviewDecision = 'rejected';
          reviewFeedback = reason;
          return { success: true, decision: 'rejected', message: 'Review rejected with feedback.' };
        },
      },
    ];

    const dbPath = join(appHome, 'data', 'task-agent-memory.db');

    const reviewConfig = {
      ...(config as Record<string, unknown>),
      advanced: {
        ...(((config as Record<string, unknown>).advanced as Record<string, unknown>) ?? {}),
        maxSteps: 10, // Reviewers shouldn't need many steps
      },
      agent: {
        ...(((config as Record<string, unknown>).agent as Record<string, unknown>) ?? {}),
        maxTurns: 10,
      },
    };

    const stream = streamAgentResponse(
      `review-${task.id}-${reviewerAgentId}`,
      messages as unknown[],
      modelEntry.modelConfig as unknown as Parameters<typeof streamAgentResponse>[2],
      reviewConfig as unknown as Parameters<typeof streamAgentResponse>[3],
      reviewTools as unknown as Parameters<typeof streamAgentResponse>[4],
      dbPath,
      { cwd: process.env.HOME ?? '/tmp' },
    );

    for await (const event of stream) {
      const ev = event as Record<string, unknown>;
      if (ev.type === 'text-delta' && ev.text) {
        const text = String(ev.text).replace(/\n/g, '\r\n');
        broadcast(text);
      } else if (ev.type === 'tool-call') {
        broadcast(
          `\r\n\x1b[1;33m[Tool]\x1b[0m ${String(ev.toolName ?? 'unknown')}(${JSON.stringify(ev.args ?? {}).slice(0, 200)})\r\n`,
        );
      } else if (ev.type === 'tool-result') {
        const resultStr = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? '');
        const truncated = resultStr.length > 300 ? resultStr.slice(0, 300) + '…' : resultStr;
        broadcast(`\x1b[90m${truncated.replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
      }
    }

    // Determine final result
    if (reviewDecision === 'approved') {
      result.status = 'approved';
      result.feedback = reviewFeedback;
      broadcast(`\r\n\x1b[1;32m[Reviewer: ${agentName}]\x1b[0m ✓ APPROVED\r\n`);
    } else if (reviewDecision === 'rejected') {
      result.status = 'rejected';
      result.feedback = reviewFeedback;
      broadcast(`\r\n\x1b[1;31m[Reviewer: ${agentName}]\x1b[0m ✗ REJECTED: ${reviewFeedback}\r\n`);
    } else {
      // Agent didn't call either tool — treat as rejection with generic feedback
      result.status = 'rejected';
      result.feedback = 'Reviewer did not provide an explicit decision. Treating as rejection.';
      broadcast(`\r\n\x1b[1;33m[Reviewer: ${agentName}]\x1b[0m ⚠ No decision made — defaulting to REJECTED\r\n`);
    }
    result.timestamp = new Date().toISOString();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    broadcast(`\r\n\x1b[1;31m[Error]\x1b[0m Reviewer failed: ${errMsg.replace(/\n/g, '\r\n')}\r\n`);
    result.status = 'rejected';
    result.feedback = `Review process error: ${errMsg}`;
    result.timestamp = new Date().toISOString();
  }

  // Complete the review run in audit trail
  const finalTask = readTask(appHome, task.id);
  if (finalTask?.runs?.length) {
    const reviewRun = [...finalTask.runs]
      .reverse()
      .find((r) => r.type === 'review' && r.agentId === reviewerAgentId && !r.completedAt);
    if (reviewRun) {
      reviewRun.completedAt = new Date().toISOString();
      reviewRun.outcome = result.status === 'approved' ? 'approved' : 'rejected';
      reviewRun.summary = result.feedback?.slice(0, 200);
      writeTask(appHome, finalTask);
    }
  }

  // Broadcast terminal exit for this reviewer's session
  broadcastToAllWindows('tasks:terminal-exit', { sessionId: virtualSessionId, exitCode: 0 });

  return result;
}

/**
 * Start the multi-reviewer process for a task in ai_review status.
 * Supports parallel (all at once) and sequential (one-by-one) modes.
 * Runs in the background — does not block the caller.
 */
async function startReviewProcess(appHome: string, task: TaskFile): Promise<void> {
  const reviewerIds = task.reviewerAgentIds ?? [];
  if (reviewerIds.length === 0) return;

  const mode = task.reviewMode ?? 'parallel';

  // Get the executor's terminal output for reviewers to examine
  const executorSessionId = task.terminalSessionId;
  const executorOutputChunks = executorSessionId ? getBuffer(executorSessionId) : [];
  const executorOutput = executorOutputChunks.join('');

  let results: TaskReviewResult[];

  if (mode === 'parallel') {
    // Run all reviewers simultaneously
    results = await Promise.all(reviewerIds.map((rid) => runSingleReviewer(appHome, task, rid, executorOutput)));
  } else {
    // Sequential mode: run one at a time, stop on first rejection
    results = [];
    for (const rid of reviewerIds) {
      const result = await runSingleReviewer(appHome, task, rid, executorOutput);
      results.push(result);

      if (result.status === 'rejected') {
        // First rejection stops the chain — remaining reviewers stay pending
        const remaining = reviewerIds.slice(results.length);
        for (const remainingId of remaining) {
          const remainingAgent = readAgent(appHome, remainingId);
          results.push({
            agentId: remainingId,
            agentName: remainingAgent?.name ?? 'Unknown Reviewer',
            status: 'pending',
          });
        }
        break;
      }
    }
  }

  // Update the task with final review results
  const freshTask = readTask(appHome, task.id);
  if (!freshTask) return;

  freshTask.reviewResults = results;
  freshTask.updatedAt = new Date().toISOString();

  const allApproved = results.every((r) => r.status === 'approved');
  const anyRejected = results.some((r) => r.status === 'rejected');

  if (allApproved) {
    // All reviewers approved — check review policy for next status
    const config = readEffectiveConfig(appHome);
    const policy = (
      config?.autopilot as
        | { reviewPolicy?: { skipHumanReviewOnApproval?: boolean; aiCanRequireHumanReview?: boolean } }
        | undefined
    )?.reviewPolicy;

    if (policy?.skipHumanReviewOnApproval) {
      if (policy.aiCanRequireHumanReview) {
        // AI decides if human review is still needed for complex work
        const { assessComplexity } = await import('../agent/task-unblocker.js');
        const needsHuman = await assessComplexity(freshTask);
        freshTask.status = needsHuman ? 'human_review' : 'done';
        if (!needsHuman) freshTask.completedAt = new Date().toISOString();
        console.info(
          `[Agent:task] AI complexity check: ${needsHuman ? 'requires human review' : 'auto-completing'} for "${freshTask.title}"`,
        );
      } else {
        freshTask.status = 'done';
        freshTask.completedAt = new Date().toISOString();
      }
    } else {
      freshTask.status = 'human_review';
    }
  } else if (anyRejected) {
    // At least one rejection — kick back to in_progress with merged feedback
    freshTask.status = 'in_progress';
    if (!freshTask.reviewNotes) freshTask.reviewNotes = [];
    for (const r of results) {
      if (r.status === 'rejected' && r.feedback) {
        freshTask.reviewNotes.push({
          source: 'ai',
          content: `[${r.agentName}] ${r.feedback}`,
          timestamp: r.timestamp ?? new Date().toISOString(),
          fromStatus: 'ai_review',
        });
      }
    }
  }

  writeTask(appHome, freshTask);
  broadcastTaskChange(appHome);

  // Auto-restart the assigned agent if task was kicked back (regardless of autopilot)
  if (anyRejected && freshTask.assignedAgentId) {
    console.info(`[Agent:task] AI review rejected — auto-restarting agent for task "${freshTask.title}"`);
    // Import terminalManager from the outer scope via a module-level ref
    setTimeout(() => {
      void autoRestartAgent(appHome, freshTask.assignedAgentId!);
    }, 500);
  }
}

/**
 * Wrapper around the consolidated task-completion module.
 *
 * Handles the `undefined` exit code case (terminal vanished) and adapts the
 * new pipeline's result shape for callers that expect `{ nextStatus, isCrash }`.
 */
function analyzeCompletion(
  exitCode: number | undefined,
  options: {
    requireHumanReview?: boolean;
    reviewerAgentIds?: string[];
    retryCount?: number;
  },
): { nextStatus: string; isCrash: boolean; shouldRetry?: boolean; blockedReason?: string } {
  if (exitCode === undefined) {
    // Unknown — be conservative and route to human review.
    return { nextStatus: 'human_review', isCrash: false };
  }
  const result = analyzeCompletionCore(
    exitCode,
    {} as never, // agent (unused in new impl)
    {} as never, // task (unused in new impl)
    {
      requireHumanReview: options.requireHumanReview ?? false,
      reviewerAgentIds: options.reviewerAgentIds,
      retryCount: options.retryCount,
    },
  );
  return {
    nextStatus: result.nextStatus,
    isCrash: result.wasCrash ?? false,
    shouldRetry: result.shouldRetry,
    blockedReason: result.blockedReason,
  };
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

  // If agent has no currentTaskId, try to find the task that's assigned to this agent.
  // This happens after kick-back: task.assignedAgentId still points here but
  // agent.currentTaskId was cleared on the previous run's completion.
  if (!agent.currentTaskId) {
    const tasks = listAllTasks(appHome);
    const assignedTask = tasks.find((t) => t.assignedAgentId === agentId && t.status === 'in_progress');
    if (assignedTask) {
      agent.currentTaskId = assignedTask.id;
      agent.updatedAt = new Date().toISOString();
      writeAgent(appHome, agent);
      console.info(`[Agent:task] Re-linked agent "${agent.name}" to task "${assignedTask.title}" for restart`);
    } else {
      return { error: 'No task assigned to agent' };
    }
  }

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
    console.info(
      `[Agent:task] Starting Mastra agent "${agent.name}" on task "${task.title}" session=${virtualSessionId}`,
    );

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

    // Record execution run in audit trail
    const run: TaskRun = {
      id: randomUUID(),
      number: (task.runs?.length ?? 0) + 1,
      type: 'execution',
      agentId,
      agentName: agent.name,
      terminalSessionId: virtualSessionId,
      startedAt: new Date().toISOString(),
    };
    task.runs = [...(task.runs ?? []), run];
    writeTask(appHome, task);

    broadcastAgentChange(appHome);
    broadcastTaskChange(appHome);

    // Broadcast formatted output to the terminal viewer via the standard channel
    const broadcast = (text: string) => {
      appendOutput(virtualSessionId, text);
      broadcastToAllWindows('tasks:terminal-data', { sessionId: virtualSessionId, data: text });
    };

    // Run the Mastra agent asynchronously
    const { streamAgentResponse } = await import('../agent/mastra-agent.js');
    const config = readEffectiveConfig(appHome);

    // Build task-aware system prompt that ensures the agent completes the full task
    const taskSystemPrompt = [
      agent.instructions ?? '',
      '',
      '## Task Execution Mode',
      '',
      'You are executing a task from the task board. You MUST:',
      '1. Complete the ENTIRE task described below — do not stop after one step.',
      '2. Use workspace tools (file read/write/edit, shell commands) to accomplish the task.',
      '3. Verify your work is correct (read files you created, check output).',
      '4. Continue making tool calls until the task is fully complete.',
      '5. Do NOT just update memory or acknowledge the task — actually DO the work.',
      '6. When DONE, call the `promote_task` tool with a summary of what you accomplished.',
      '7. If BLOCKED (missing info, access denied, dependency), call `block_task` with the reason.',
      '8. Do NOT end your response without calling either `promote_task` or `block_task`.',
      '',
      `Working directory: ${cwd}`,
    ]
      .filter(Boolean)
      .join('\n');

    // Build the user message — include review feedback if task was kicked back
    let userMessage = task.description ?? 'No task description provided.';
    if (task.reviewNotes && task.reviewNotes.length > 0) {
      const feedbackSection = task.reviewNotes
        .map((note) => `[${note.source.toUpperCase()} review — ${note.timestamp}]\n${note.content}`)
        .join('\n\n');
      userMessage += `\n\n---\n## Review Feedback (address these issues)\n\n${feedbackSection}`;
    }

    // Build messages with task description as user message
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: taskSystemPrompt },
      { role: 'user', content: userMessage },
    ];

    broadcast(`\x1b[1;36m[Mastra Agent]\x1b[0m Starting task: ${task.title}\r\n`);
    broadcast(`\x1b[90m${'-'.repeat(60)}\x1b[0m\r\n`);

    // Run in background — don't await (would block IPC)
    const abortController = new AbortController();
    mastraAbortControllers.set(virtualSessionId, abortController);

    void (async () => {
      let _hasError = false;
      try {
        // Resolve the model using the same catalog resolution as the main chat
        // This ensures correct provider endpoint, API key, and TLS settings
        const catalog = resolveModelCatalog(config as Parameters<typeof resolveModelCatalog>[0]);
        const defaultKey = (config as { models?: { defaultModelKey?: string } })?.models?.defaultModelKey;
        const modelEntry = defaultKey
          ? (catalog.byKey.get(defaultKey) ?? catalog.defaultEntry)
          : (catalog.defaultEntry ?? catalog.entries[0]);

        if (!modelEntry) {
          broadcast(
            `\r\n\x1b[1;31m[Error]\x1b[0m No model configured. Please set a default model in Settings → Models.\r\n`,
          );
          _hasError = true;
          return;
        }

        broadcast(
          `\x1b[90mUsing model: ${modelEntry.modelConfig.modelName} (${modelEntry.modelConfig.provider})\x1b[0m\r\n`,
        );
        broadcast(`\x1b[90m${'-'.repeat(60)}\x1b[0m\r\n\r\n`);

        const dbPath = join(appHome, 'data', 'task-agent-memory.db');
        const registeredTools = getRegisteredTools();

        // Add task lifecycle tools that let the agent explicitly promote/block the task
        const taskLifecycleTools = [
          {
            name: 'promote_task',
            description:
              'Call this tool when you have COMPLETED the task successfully and want to submit it for review. ' +
              'This moves the task to AI Review status. Only call this after you have verified your work is correct.',
            inputSchema: z.object({
              summary: z.string().describe('Brief summary of what was accomplished (1-3 sentences)'),
            }),
            execute: async (input: unknown) => {
              const { summary } = input as { summary: string };
              const t = readTask(appHome, task.id);
              if (t && t.status === 'in_progress') {
                console.info(`[Agent:task] promote_task called for "${t.title}" summary="${summary?.slice(0, 80)}..."`);
                t.completionSummary = summary;
                t.updatedAt = new Date().toISOString();

                // Complete the last execution run in audit trail
                if (t.runs?.length) {
                  const lastRun = t.runs[t.runs.length - 1];
                  if (lastRun.type === 'execution' && !lastRun.completedAt) {
                    lastRun.completedAt = new Date().toISOString();
                    lastRun.outcome = 'promoted';
                    lastRun.summary = summary?.slice(0, 200);
                  }
                }

                // Multi-reviewer: check if reviewerAgentIds has entries
                const hasReviewers = t.reviewerAgentIds && t.reviewerAgentIds.length > 0;

                if (!hasReviewers) {
                  // No reviewers assigned — skip AI review, go directly to human_review
                  t.status = 'human_review';
                  writeTask(appHome, t);
                  broadcastTaskChange(appHome);
                } else {
                  // Move to ai_review and start the multi-reviewer process
                  t.status = 'ai_review';
                  t.reviewResults = t.reviewerAgentIds!.map((rid) => {
                    const reviewerAgent = readAgent(appHome, rid);
                    return {
                      agentId: rid,
                      agentName: reviewerAgent?.name ?? 'Unknown Reviewer',
                      status: 'pending' as const,
                    };
                  });
                  writeTask(appHome, t);
                  broadcastTaskChange(appHome);

                  // Start the review process in the background
                  void startReviewProcess(appHome, t);
                }

                // Also mark agent as idle immediately (task is done)
                const ag = readAgent(appHome, agentId);
                if (ag && ag.status === 'running') {
                  ag.status = 'idle';
                  ag.currentTaskId = undefined;
                  ag.stats.tasksCompleted = (ag.stats.tasksCompleted ?? 0) + 1;
                  ag.updatedAt = new Date().toISOString();
                  writeAgent(appHome, ag);
                  broadcastAgentChange(appHome);
                }

                const newStatus = hasReviewers ? 'ai_review' : 'human_review';
                return {
                  success: true,
                  newStatus,
                  message: `Task promoted to ${newStatus === 'ai_review' ? 'AI Review' : 'Human Review'}.`,
                };
              }
              return { success: false, message: `Task is in status '${t?.status}', cannot promote.` };
            },
          },
          {
            name: 'block_task',
            description:
              'Call this tool when the task CANNOT be completed due to a blocker (missing info, dependency, access issue, etc). ' +
              'Provide the reason so the blocker can be resolved later.',
            inputSchema: z.object({
              reason: z.string().describe('Why the task is blocked and what is needed to unblock it'),
            }),
            execute: async (input: unknown) => {
              const { reason } = input as { reason: string };
              const t = readTask(appHome, task.id);
              if (t) {
                console.info(`[Agent:task] block_task called for "${t.title}" reason="${reason?.slice(0, 80)}"`);

                t.status = 'blocked';
                if (!t.reviewNotes) t.reviewNotes = [];
                t.reviewNotes.push({
                  source: 'ai',
                  content: reason,
                  timestamp: new Date().toISOString(),
                  fromStatus: 'in_progress',
                });
                t.updatedAt = new Date().toISOString();

                // Complete the last execution run in audit trail
                if (t.runs?.length) {
                  const lastRun = t.runs[t.runs.length - 1];
                  if (lastRun.type === 'execution' && !lastRun.completedAt) {
                    lastRun.completedAt = new Date().toISOString();
                    lastRun.outcome = 'blocked';
                    lastRun.summary = reason?.slice(0, 200);
                  }
                }

                writeTask(appHome, t);
                broadcastTaskChange(appHome);

                // Also mark agent as idle immediately
                const ag = readAgent(appHome, agentId);
                if (ag && ag.status === 'running') {
                  ag.status = 'idle';
                  ag.currentTaskId = undefined;
                  ag.updatedAt = new Date().toISOString();
                  writeAgent(appHome, ag);
                  broadcastAgentChange(appHome);
                }

                return { success: true, newStatus: 'blocked', message: 'Task marked as blocked.' };
              }
              return { success: false, message: 'Task not found.' };
            },
          },
        ];

        const tools = [...registeredTools, ...taskLifecycleTools];

        // Ensure maxSteps is set for multi-turn task execution (default 25 if not configured)
        const taskConfig = {
          ...(config as Record<string, unknown>),
          advanced: {
            ...(((config as Record<string, unknown>).advanced as Record<string, unknown>) ?? {}),
            maxSteps: (((config as Record<string, unknown>).advanced as Record<string, unknown>) ?? {}).maxSteps ?? 25,
          },
          agent: {
            ...(((config as Record<string, unknown>).agent as Record<string, unknown>) ?? {}),
            maxTurns: (((config as Record<string, unknown>).agent as Record<string, unknown>) ?? {}).maxTurns ?? 25,
          },
        };

        const stream = streamAgentResponse(
          `task-${task.id}`,
          messages as unknown[],
          modelEntry.modelConfig as unknown as Parameters<typeof streamAgentResponse>[2],
          taskConfig as unknown as Parameters<typeof streamAgentResponse>[3],
          tools as unknown as Parameters<typeof streamAgentResponse>[4],
          dbPath,
          { cwd: cwd, abortSignal: abortController.signal },
        );

        for await (const event of stream) {
          const ev = event as Record<string, unknown>;
          if (ev.type === 'text-delta' && ev.text) {
            // Convert newlines to terminal-friendly \r\n
            const text = String(ev.text).replace(/\n/g, '\r\n');
            broadcast(text);
          } else if (ev.type === 'tool-call') {
            broadcast(
              `\r\n\x1b[1;33m[Tool]\x1b[0m ${String(ev.toolName ?? 'unknown')}(${JSON.stringify(ev.args ?? {}).slice(0, 100)})\r\n`,
            );
          } else if (ev.type === 'tool-result') {
            const resultStr = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? '');
            const truncated = resultStr.length > 500 ? resultStr.slice(0, 500) + '…' : resultStr;
            broadcast(`\x1b[90m${truncated.replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
          } else if (ev.type === 'data-workspace-metadata') {
            const wsData = ev.data as Record<string, unknown>;
            broadcast(
              `\x1b[90m[Workspace] ${String(wsData.toolName ?? '')} → ${String(wsData.status ?? '')}\x1b[0m\r\n`,
            );
          } else if (ev.type === 'data-sandbox-exit') {
            const exitData = ev.data as Record<string, unknown>;
            const success = exitData.success ? '✓' : '✗';
            broadcast(
              `\x1b[90m[Sandbox] ${success} exit=${String(exitData.exitCode)} (${String(exitData.executionTimeMs)}ms)\x1b[0m\r\n`,
            );
          } else if (ev.type === 'step-progress') {
            const stepInfo = ev.stepInfo as Record<string, unknown> | undefined;
            if (stepInfo) {
              broadcast(`\x1b[90m[Step ${stepInfo.currentStep}/${stepInfo.maxSteps}]\x1b[0m\r\n`);
            }
          }
        }

        broadcast(`\r\n\x1b[90m${'-'.repeat(60)}\x1b[0m\r\n`);
        broadcast(`\x1b[1;32m[Mastra Agent]\x1b[0m Task completed.\r\n`);
      } catch (err) {
        _hasError = true;
        // Check if this was an intentional abort (user clicked Stop)
        if (abortController.signal.aborted) {
          broadcast(`\r\n\x1b[1;33m[Mastra Agent]\x1b[0m Stopped by user.\r\n`);
        } else {
          const errMsg = err instanceof Error ? err.message : String(err);
          broadcast(`\r\n\x1b[1;31m[Error]\x1b[0m ${errMsg.replace(/\n/g, '\r\n')}\r\n`);
          if (err instanceof Error && err.cause) {
            broadcast(`\x1b[90mCause: ${String(err.cause).replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
          }
          broadcast(`\r\n\x1b[33mThe task remains in progress. Check your model/provider configuration.\x1b[0m\r\n`);
        }
      } finally {
        // Mark agent idle (if promote_task/block_task didn't already do it)
        const freshAgent = readAgent(appHome, agentId);
        if (freshAgent && freshAgent.status === 'running') {
          console.info(
            `[Agent:task] Mastra stream ended, marking agent "${freshAgent.name}" idle (promote/block not called)`,
          );
          freshAgent.status = 'idle';
          freshAgent.currentTaskId = undefined;
          freshAgent.terminalSessionId = undefined;
          freshAgent.updatedAt = new Date().toISOString();
          writeAgent(appHome, freshAgent);
        } else {
          console.info(`[Agent:task] Mastra stream ended, agent already idle/stopped (status=${freshAgent?.status})`);
        }

        // Don't touch task status — promote_task/block_task handle that.
        // Just broadcast final state to ensure UI is in sync.
        broadcastAgentChange(appHome);
        broadcastTaskChange(appHome);

        // Broadcast terminal exit so the UI knows it's done
        broadcastToAllWindows('tasks:terminal-exit', { sessionId: virtualSessionId, exitCode: 0 });

        // Clean up abort controller
        mastraAbortControllers.delete(virtualSessionId);
      }
    })();

    return { sessionId: virtualSessionId };
  }

  const config = readEffectiveConfig(appHome);
  const dangerousMode = config?.autopilot?.dangerousMode === true;

  // Filter caller-supplied args/env through the configurable dual deny+allowlist
  // before they reach the PTY. Falls back to compiled-in defaults when the
  // autopilot config block is absent.
  const argsDenylist = config?.autopilot?.agentArgsDenylist ?? DEFAULT_AGENT_ARGS_DENYLIST;
  const argsAllowlist = config?.autopilot?.agentArgsAllowlist;
  const envDenylist = config?.autopilot?.agentEnvDenylist ?? DEFAULT_AGENT_ENV_DENYLIST;
  const envAllowlist = config?.autopilot?.agentEnvAllowlist;

  const safeArgs = filterAgentArgs(agent.config?.customArgs, argsDenylist, argsAllowlist);
  // Build the COMPLETE child env: scrub the inherited process.env through the
  // same deny/allow policy (so the app's own secrets like *_API_KEY / *_BASE_URL
  // don't leak into the spawned CLI), then overlay the agent's declared env.
  // Passed with envIsComplete so the terminal manager doesn't re-add process.env.
  const scrubbedProcessEnv = filterAgentEnv(process.env as Record<string, string>, envDenylist, envAllowlist);
  const safeEnv = { ...scrubbedProcessEnv, ...filterAgentEnv(agent.config?.env, envDenylist, envAllowlist) };

  let createdSessionId: string | null = null;
  try {
    const sessionId = await terminalManager.create(agent.currentTaskId, {
      runtime: effectiveRuntime,
      cwd,
      cols: 120,
      rows: 30,
      customArgs: safeArgs,
      env: safeEnv,
      envIsComplete: true,
      dangerousMode,
    });
    createdSessionId = sessionId;

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

    // Record execution run in audit trail
    const ptyRun: TaskRun = {
      id: randomUUID(),
      number: (task.runs?.length ?? 0) + 1,
      type: 'execution',
      agentId,
      agentName: agent.name,
      terminalSessionId: sessionId,
      startedAt: new Date().toISOString(),
    };
    task.runs = [...(task.runs ?? []), ptyRun];
    writeTask(appHome, task);

    broadcastAgentChange(appHome);
    broadcastTaskChange(appHome);

    // Only auto-write task description to agent-backed runtimes (claude-code, codex)
    // that accept text prompts. Shell-backed runtimes (mastra/default) would execute
    // the description as a shell command — a security risk.
    const promptableRuntimes = ['claude-code', 'codex'];
    if (task.description && promptableRuntimes.includes(effectiveRuntime)) {
      setTimeout(() => {
        // The PTY may have been stopped/killed during the delay — guard the
        // write so a throw here (in an unhandled timer) can't crash main.
        try {
          if (!terminalManager.isAlive(sessionId)) return;
          const prompt = task.description.trim() + '\n';
          terminalManager.write(sessionId, prompt);
        } catch (err) {
          console.warn(`[Agent:task] Deferred prompt write failed for session ${sessionId}:`, err);
        }
      }, 1500);
    }

    // Register immediate exit callback for fast reconciliation
    terminalManager.onSessionExit(sessionId, (exitCode: number) => {
      console.info(`[Agent:task] PTY exit code=${exitCode} session=${sessionId} agent=${agentId}`);
      const freshAgent = readAgent(appHome, agentId);
      if (!freshAgent || freshAgent.status !== 'running') return;

      // Read task to get reviewerAgentIds and retryCount for the completion pipeline
      const completedTaskId = freshAgent.currentTaskId;
      const exitTask = completedTaskId ? readTask(appHome, completedTaskId) : null;

      // Determine requireHumanReview: agent-level override takes priority, then app config (default true)
      const appConfig = readEffectiveConfig(appHome);
      const agentRequiresReview = (freshAgent.config as { requireHumanReview?: boolean } | undefined)
        ?.requireHumanReview;
      const requireHumanReview =
        agentRequiresReview !== undefined ? agentRequiresReview : (appConfig?.autopilot?.requireHumanReview ?? true);
      const { nextStatus, isCrash, shouldRetry, blockedReason } = analyzeCompletion(exitCode, {
        requireHumanReview,
        reviewerAgentIds: exitTask?.reviewerAgentIds,
        retryCount: exitTask?.retryCount,
      });

      freshAgent.terminalSessionId = undefined;
      freshAgent.updatedAt = new Date().toISOString();

      // Clear currentTaskId so the dispatcher considers this agent eligible again
      freshAgent.currentTaskId = undefined;

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
        if (!shouldRetry) freshAgent.stats.tasksCompleted += 1;
      }
      writeAgent(appHome, freshAgent);

      if (completedTaskId && exitTask) {
        const taskNow = new Date().toISOString();
        if (shouldRetry) {
          // Timeout auto-retry: increment retryCount, keep in_progress
          exitTask.retryCount = (exitTask.retryCount ?? 0) + 1;
          exitTask.updatedAt = taskNow;
        } else {
          exitTask.status = nextStatus as typeof exitTask.status;
          exitTask.updatedAt = taskNow;
          if (nextStatus === 'done') exitTask.completedAt = taskNow;
          if (nextStatus === 'blocked' && blockedReason) {
            if (!exitTask.reviewNotes) exitTask.reviewNotes = [];
            exitTask.reviewNotes.push({
              source: 'ai',
              content: blockedReason,
              timestamp: taskNow,
              fromStatus: 'in_progress',
            });
          }
        }
        exitTask.lastExitCode = exitCode;

        // Complete the last execution run in audit trail
        if (exitTask.runs?.length) {
          const lastRun = exitTask.runs[exitTask.runs.length - 1];
          if (lastRun.type === 'execution' && !lastRun.completedAt) {
            lastRun.completedAt = new Date().toISOString();
            lastRun.exitCode = exitCode;
            lastRun.outcome = shouldRetry
              ? 'timeout'
              : nextStatus === 'blocked'
                ? 'blocked'
                : nextStatus === 'done'
                  ? 'promoted'
                  : 'promoted';
            lastRun.summary = (blockedReason ?? completedTaskId) ? undefined : undefined;
          }
        }

        writeTask(appHome, exitTask);
        broadcastTaskChange(appHome);

        // Kick off AI review process if task transitioned to ai_review
        if (nextStatus === 'ai_review' && exitTask.reviewerAgentIds && exitTask.reviewerAgentIds.length > 0) {
          void startReviewProcess(appHome, exitTask);
        }
      }
      broadcastAgentChange(appHome);
    });

    return { sessionId };
  } catch (err) {
    // If the PTY was created but a later step (persistence, task write) threw,
    // kill it so we don't orphan a spawned process the agent record no longer
    // tracks.
    if (createdSessionId) {
      try {
        terminalManager.kill(createdSessionId);
      } catch {
        /* best-effort */
      }
    }
    return { error: String(err) };
  }
}

// ── Registration ─────────────────────────────────────────────────────────

export function registerAgentHandlers(ipcMain: IpcMain, appHome: string, terminalManager: TaskTerminalManager): void {
  // Store module-level refs for autoRestartAgent
  _terminalManager = terminalManager;
  _appHome = appHome;

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
      const runtime = payload.runtime ?? 'auto';
      if (!isValidAgentRuntime(runtime)) {
        return { error: `Unknown runtime: ${String(payload.runtime)}` };
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const agent: AgentFile = {
        id,
        name: payload.name ?? `Agent ${id.slice(0, 6)}`,
        role: payload.role,
        runtime,
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
    if (updates.runtime !== undefined && !isValidAgentRuntime(updates.runtime)) {
      return { error: `Unknown runtime: ${String(updates.runtime)}` };
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
      // Kill any running terminal first (aborts a Mastra stream too)
      const agent = readAgent(appHome, id);
      if (agent?.terminalSessionId) {
        stopAgentExecution(terminalManager, agent.terminalSessionId);
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

    // If agent is running, stop it first (aborts a Mastra stream too)
    if (agent.status === 'running' && agent.terminalSessionId) {
      stopAgentExecution(terminalManager, agent.terminalSessionId);
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

    // Kill terminal if one exists (regardless of agent.status) — aborts a
    // Mastra virtual-session stream as well as killing a real PTY.
    if (agent.terminalSessionId) {
      stopAgentExecution(terminalManager, agent.terminalSessionId);
    }

    // Capture currentTaskId before clearing — we need it for task cleanup below
    const taskId = agent.currentTaskId;

    // Force agent to idle and clear task assignment
    agent.status = 'idle';
    agent.currentTaskId = undefined;
    agent.terminalSessionId = undefined;
    agent.updatedAt = new Date().toISOString();
    writeAgent(appHome, agent);

    // Update task: clear terminal, move to human_review if in_progress
    if (taskId) {
      const task = readTask(appHome, taskId);
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
        // Skip Mastra virtual sessions — they're not real PTYs and are never
        // registered in the terminal manager. Their lifecycle is managed by
        // the async IIFE in startAgentRun, not the reconciler.
        if (agent.terminalSessionId.startsWith('mastra-')) continue;

        // Check if the terminal session is still alive. If not, the process
        // has exited and we need to reconcile the agent/task state.
        if (terminalManager.isAlive(agent.terminalSessionId)) continue;

        console.info(
          `[Reconciler] Agent "${agent.name}" (${agent.id}) terminal ${agent.terminalSessionId} is dead, reconciling`,
        );

        // Terminal is gone — read fresh agent state and reconcile.
        const freshAgent = readAgent(appHome, agent.id);
        if (!freshAgent || freshAgent.status !== 'running') continue;

        const sessionId = freshAgent.terminalSessionId;
        const exitCode = sessionId ? terminalManager.consumeExitCode(sessionId) : undefined;

        // Determine requireHumanReview: agent-level override takes priority, then app config (default true)
        const appConfig = readEffectiveConfig(appHome);
        const agentRequiresReview = (freshAgent.config as { requireHumanReview?: boolean } | undefined)
          ?.requireHumanReview;
        const requireHumanReview =
          agentRequiresReview !== undefined ? agentRequiresReview : (appConfig?.autopilot?.requireHumanReview ?? true);

        // Read task for completion pipeline context
        const completedTaskId = freshAgent.currentTaskId;
        const exitTask = completedTaskId ? readTask(appHome, completedTaskId) : null;

        const { nextStatus, isCrash, shouldRetry, blockedReason } = analyzeCompletion(exitCode, {
          requireHumanReview,
          reviewerAgentIds: exitTask?.reviewerAgentIds,
          retryCount: exitTask?.retryCount,
        });

        // Update agent
        freshAgent.terminalSessionId = undefined;
        freshAgent.currentTaskId = undefined;
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
          if (!shouldRetry) freshAgent.stats.tasksCompleted += 1;
        }
        writeAgent(appHome, freshAgent);

        // Move task to next status
        if (completedTaskId && exitTask) {
          const taskNow = new Date().toISOString();
          if (shouldRetry) {
            exitTask.retryCount = (exitTask.retryCount ?? 0) + 1;
            exitTask.updatedAt = taskNow;
          } else {
            exitTask.status = nextStatus as typeof exitTask.status;
            exitTask.updatedAt = taskNow;
            if (nextStatus === 'done') exitTask.completedAt = taskNow;
            if (nextStatus === 'blocked' && blockedReason) {
              if (!exitTask.reviewNotes) exitTask.reviewNotes = [];
              exitTask.reviewNotes.push({
                source: 'ai',
                content: blockedReason,
                timestamp: taskNow,
                fromStatus: 'in_progress',
              });
            }
          }
          exitTask.lastExitCode = exitCode ?? -1;
          writeTask(appHome, exitTask);
          broadcastTaskChange(appHome);

          // Kick off AI review process if task transitioned to ai_review
          if (nextStatus === 'ai_review' && exitTask.reviewerAgentIds && exitTask.reviewerAgentIds.length > 0) {
            void startReviewProcess(appHome, exitTask);
          }
        }
        broadcastAgentChange(appHome);
      }
    }
  }, 5000);

  // Clean up on app quit
  process.on('beforeExit', () => clearInterval(reconcileInterval));
}

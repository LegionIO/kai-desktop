/**
 * TaskDispatcher — the autopilot loop.
 *
 * Each tick:
 *   1. Gather unassigned 'todo' tasks and idle agents (subject to concurrency caps).
 *   2. Score every (task, agent) pair using the configured strategy.
 *   3. Greedily assign the highest-scoring pairs.
 *   4. Optionally start the agent right away.
 *
 * The dispatcher is owned by the main process. The IPC layer in
 * `electron/ipc/orchestrator.ts` exposes the controls and state to the renderer.
 */

import type { AgentFile, AgentRole } from '../../shared/agent-types.js';
import type { TaskFile } from '../../shared/task-types.js';

const TICK_TIMEOUT_MS = 120_000; // 2 minutes max per tick

// ── Public types ─────────────────────────────────────────────────────────

export interface DispatcherConfig {
  enabled: boolean;
  intervalMs: number;
  autoStart: boolean;
  maxConcurrentAgents: number;
  matchingStrategy: 'simple' | 'ai-scored';
  requireHumanReview: boolean;
}

export const DEFAULT_DISPATCHER_CONFIG: DispatcherConfig = {
  enabled: false,
  intervalMs: 30000,
  autoStart: true,
  maxConcurrentAgents: 3,
  matchingStrategy: 'simple',
  requireHumanReview: true,
};

export interface DispatchDecision {
  /** ISO timestamp when the decision was made. */
  at: string;
  taskId: string;
  agentId: string;
  taskTitle: string;
  agentName: string;
  score: number;
  reason: string;
  /** Whether the agent was actually assigned. */
  assigned: boolean;
  /** Whether the agent was auto-started after assignment. */
  started: boolean;
  error?: string;
}

export interface TaskDispatcherState {
  config: DispatcherConfig;
  running: boolean;
  lastTickAt: string | null;
  nextTickAt: string | null;
  decisions: DispatchDecision[];
}

export interface DispatcherDeps {
  listTasks: () => TaskFile[] | Promise<TaskFile[]>;
  listAgents: () => AgentFile[] | Promise<AgentFile[]>;
  /** Assign a task to an agent. Returns truthy on success, or `{ error }` on failure. */
  assignTask: (
    agentId: string,
    taskId: string,
  ) => Promise<{ ok?: boolean; error?: string } | void> | { ok?: boolean; error?: string } | void;
  /** Start the agent. Returns `{ sessionId }` on success or `{ error }` on failure. */
  startAgent: (
    agentId: string,
  ) => Promise<{ sessionId?: string; error?: string }> | { sessionId?: string; error?: string };
  /** Returns the latest dispatcher config from app config. */
  getConfig: () => DispatcherConfig | null | undefined;
  /** Rollback assignment on start failure. */
  unassignTask?: (agentId: string, taskId: string) => Promise<void> | void;
  /** Optional broadcast callback fired whenever state changes. */
  broadcastState?: (state: TaskDispatcherState) => void;
}

// ── Scoring ──────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'as',
  'is',
  'it',
  'be',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'we',
  'they',
  'them',
  'us',
  'me',
  'my',
  'your',
  'our',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'should',
  'can',
  'could',
  'may',
  'might',
  'must',
  'about',
  'into',
  'from',
  'by',
  'at',
  'so',
  'if',
  'then',
  'than',
  'when',
  'where',
  'how',
  'what',
  'which',
  'who',
  'why',
  'not',
  'no',
  'yes',
]);

const ROLE_KEYWORDS: Record<AgentRole, string[]> = {
  general: [],
  engineer: ['build', 'implement', 'fix', 'bug', 'feature', 'refactor', 'code', 'test', 'tests', 'patch'],
  reviewer: ['review', 'audit', 'check', 'security', 'lint', 'verify'],
  researcher: ['research', 'investigate', 'explore', 'analyze', 'compare', 'document', 'docs'],
};

function tokenize(text: string | undefined | null): Set<string> {
  if (!text) return new Set();
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((tok) => tok.length > 2 && !STOPWORDS.has(tok)),
  );
}

interface ScoreResult {
  score: number; // 0..1
  reason: string;
}

export function scoreSimple(task: TaskFile, agent: AgentFile): ScoreResult {
  const taskText = [task.title, task.description, ...(task.metadata?.labels ?? [])].filter(Boolean).join(' ');
  const agentText = [agent.name, agent.description, agent.instructions, ...(agent.capabilities ?? [])]
    .filter(Boolean)
    .join(' ');

  const taskTokens = tokenize(taskText);
  const agentTokens = tokenize(agentText);

  if (taskTokens.size === 0) {
    return { score: 0.1, reason: 'no task tokens; baseline score' };
  }

  let overlap = 0;
  for (const t of taskTokens) {
    if (agentTokens.has(t)) overlap += 1;
  }
  const jaccardDenom = new Set([...taskTokens, ...agentTokens]).size || 1;
  const overlapScore = overlap / jaccardDenom;

  // Role bonus — small nudge if the task description mentions
  // role-flavored vocabulary.
  let roleBonus = 0;
  const roleWords = ROLE_KEYWORDS[agent.role] ?? [];
  for (const word of roleWords) {
    if (taskTokens.has(word)) {
      roleBonus = 0.15;
      break;
    }
  }

  const score = Math.min(1, overlapScore * 0.85 + roleBonus);
  const reason =
    overlap > 0
      ? `overlap=${overlap} jaccard=${overlapScore.toFixed(2)}${roleBonus ? ` +role(${agent.role})` : ''}`
      : `no keyword overlap${roleBonus ? `, role(${agent.role}) bonus` : ''}`;

  return { score, reason };
}

async function scoreAi(task: TaskFile, agent: AgentFile): Promise<ScoreResult> {
  // Fast path: bail out early if no API key — caller falls back to simple.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const fallback = scoreSimple(task, agent);
    return { score: fallback.score, reason: `[ai-fallback] ${fallback.reason}` };
  }

  try {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const { generateText } = await import('ai');

    const anthropic = createAnthropic({ apiKey });
    const model = anthropic('claude-3-5-haiku-latest');

    const prompt = [
      'You are a strict matchmaking judge for an AI task orchestrator.',
      'Rate (0.0-1.0) how well this AGENT fits this TASK.',
      'Return ONLY a number with two decimals on the first line, then a short reason.',
      '',
      `TASK TITLE: ${task.title}`,
      `TASK DESCRIPTION: ${(task.description ?? '').slice(0, 1500)}`,
      `TASK LABELS: ${(task.metadata?.labels ?? []).join(', ') || '(none)'}`,
      '',
      `AGENT NAME: ${agent.name}`,
      `AGENT ROLE: ${agent.role}`,
      `AGENT DESCRIPTION: ${(agent.description ?? '').slice(0, 600)}`,
      `AGENT INSTRUCTIONS: ${(agent.instructions ?? '').slice(0, 1500)}`,
      `AGENT CAPABILITIES: ${(agent.capabilities ?? []).join(', ') || '(none)'}`,
    ].join('\n');

    const { text } = await generateText({
      model,
      prompt,
      maxOutputTokens: 80,
    });

    const raw = (text ?? '').trim();
    const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? '';
    const numMatch = firstLine.match(/[01](?:\.\d+)?|0?\.\d+/);
    const parsed = numMatch ? Number.parseFloat(numMatch[0]) : NaN;
    const score = Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0;
    const reasonLine = raw.split(/\r?\n/).slice(1).join(' ').trim() || `ai-scored (${firstLine})`;
    return { score, reason: `[ai] ${reasonLine.slice(0, 160)}` };
  } catch (err) {
    console.warn('[task-dispatcher] AI scoring failed, falling back to simple:', err);
    const fallback = scoreSimple(task, agent);
    return { score: fallback.score, reason: `[ai-error→simple] ${fallback.reason}` };
  }
}

// ── Dispatcher class ─────────────────────────────────────────────────────

const MAX_DECISIONS = 50;

export class TaskDispatcher {
  private deps: DispatcherDeps;
  private config: DispatcherConfig;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private tickInFlight = false;
  private lastTickAt: string | null = null;
  private nextTickAt: string | null = null;
  private decisions: DispatchDecision[] = [];

  constructor(deps: DispatcherDeps, initialConfig?: Partial<DispatcherConfig>) {
    this.deps = deps;
    this.config = { ...DEFAULT_DISPATCHER_CONFIG, ...(initialConfig ?? {}) };
  }

  // ── Public API ────────────────────────────────────────────────────

  getState(): TaskDispatcherState {
    return {
      config: { ...this.config },
      running: this.running,
      lastTickAt: this.lastTickAt,
      nextTickAt: this.nextTickAt,
      decisions: [...this.decisions],
    };
  }

  getConfig(): DispatcherConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<DispatcherConfig>): DispatcherConfig {
    const next = { ...this.config, ...partial };
    // Clamp into valid ranges (mirrors the zod schema).
    next.intervalMs = Math.max(5000, Math.min(300000, Math.round(next.intervalMs)));
    next.maxConcurrentAgents = Math.max(1, Math.min(10, Math.round(next.maxConcurrentAgents)));
    this.config = next;

    if (this.running) {
      // Restart the timer with the new interval.
      this.scheduleNextTick();
    }
    this.broadcast();
    return { ...this.config };
  }

  toggle(enabled: boolean): void {
    this.config = { ...this.config, enabled };
    if (enabled) {
      this.start();
    } else {
      this.stop();
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Run first tick immediately, then schedule.
    void this.tick().finally(() => {
      if (this.running) this.scheduleNextTick();
    });
    this.broadcast();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextTickAt = null;
    this.broadcast();
  }

  clearLog(): void {
    this.decisions = [];
    this.broadcast();
  }

  /** Manually trigger one dispatch cycle. Returns the decisions made. */
  async forceTick(): Promise<DispatchDecision[]> {
    return this.tick();
  }

  // ── Internals ─────────────────────────────────────────────────────

  private scheduleNextTick(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.running) {
      this.nextTickAt = null;
      return;
    }
    const interval = this.config.intervalMs;
    this.nextTickAt = new Date(Date.now() + interval).toISOString();
    this.timer = setTimeout(() => {
      void this.tick().finally(() => {
        if (this.running) this.scheduleNextTick();
      });
    }, interval);
  }

  private async tick(): Promise<DispatchDecision[]> {
    if (this.tickInFlight) return [];
    this.tickInFlight = true;
    const decisions: DispatchDecision[] = [];
    let aborted = false;

    const deadline = new Promise<never>((_, reject) =>
      setTimeout(() => {
        aborted = true;
        reject(new Error('tick timeout'));
      }, TICK_TIMEOUT_MS),
    );

    try {
      await Promise.race([this.tickBody(decisions, () => aborted), deadline]);
    } catch (err) {
      if (!aborted) console.error('[task-dispatcher] Tick failed:', err);
    } finally {
      this.lastTickAt = new Date().toISOString();
      this.tickInFlight = false;
      this.broadcast();
    }

    return decisions;
  }

  private async tickBody(decisions: DispatchDecision[], isAborted: () => boolean): Promise<void> {
    // Re-read config each tick so external changes take effect.
    const fresh = this.deps.getConfig();
    if (fresh) {
      this.config = { ...this.config, ...fresh };
    }

    const tasks = await this.deps.listTasks();
    const agents = await this.deps.listAgents();

    const running = agents.filter((a) => a.status === 'running');
    const slotsAvailable = Math.max(0, this.config.maxConcurrentAgents - running.length);
    if (slotsAvailable === 0) {
      return;
    }

    const candidateTasks = tasks
      .filter((t) => t.status === 'todo' && !t.assignedAgentId && !t.archivedAt)
      .sort((a, b) => {
        const pa = a.priority ?? 0;
        const pb = b.priority ?? 0;
        if (pa !== pb) return pb - pa; // higher priority first
        return a.createdAt.localeCompare(b.createdAt); // older first
      });

    const candidateAgents = agents.filter((a) => a.status === 'idle' && !a.currentTaskId);

    // Also pick up in_progress tasks whose assigned agent is idle (review rejection retry)
    const retryTasks = tasks
      .filter((t) => t.status === 'in_progress' && t.assignedAgentId && !t.archivedAt)
      .filter((t) => {
        const agent = agents.find((a) => a.id === t.assignedAgentId);
        return agent && agent.status === 'idle';
      });

    if ((candidateTasks.length === 0 && retryTasks.length === 0) || candidateAgents.length === 0) {
      return;
    }

    // Score every (task, agent) pair.
    type Pair = { task: TaskFile; agent: AgentFile; score: number; reason: string };
    const pairs: Pair[] = [];
    for (const task of candidateTasks) {
      if (isAborted()) break;
      for (const agent of candidateAgents) {
        if (isAborted()) break;
        const result =
          this.config.matchingStrategy === 'ai-scored' ? await scoreAi(task, agent) : scoreSimple(task, agent);
        pairs.push({ task, agent, score: result.score, reason: result.reason });
      }
    }

    if (isAborted()) return;

    // Score retry tasks with their already-assigned agent (high priority)
    for (const task of retryTasks) {
      if (isAborted()) break;
      const agent = candidateAgents.find((a) => a.id === task.assignedAgentId);
      if (agent) {
        pairs.push({ task, agent, score: 0.9, reason: 'review-retry: pre-assigned agent' });
      }
    }

    if (isAborted()) return;

    pairs.sort((a, b) => b.score - a.score);

    // Greedy assignment — each task and agent used at most once.
    const usedTasks = new Set<string>();
    const usedAgents = new Set<string>();
    let remainingSlots = slotsAvailable;

    for (const pair of pairs) {
      if (isAborted()) break;
      if (remainingSlots <= 0) break;
      if (usedTasks.has(pair.task.id) || usedAgents.has(pair.agent.id)) continue;

      const decision: DispatchDecision = {
        at: new Date().toISOString(),
        taskId: pair.task.id,
        agentId: pair.agent.id,
        taskTitle: pair.task.title,
        agentName: pair.agent.name,
        score: pair.score,
        reason: pair.reason,
        assigned: false,
        started: false,
      };

      try {
        const assignResult = await this.deps.assignTask(pair.agent.id, pair.task.id);
        if (assignResult && typeof assignResult === 'object' && 'error' in assignResult && assignResult.error) {
          decision.error = String(assignResult.error);
        } else {
          decision.assigned = true;
          usedTasks.add(pair.task.id);
          usedAgents.add(pair.agent.id);
          remainingSlots -= 1;
        }
      } catch (err) {
        decision.error = `assign threw: ${String(err)}`;
      }

      if (decision.assigned && this.config.autoStart) {
        try {
          const startResult = await this.deps.startAgent(pair.agent.id);
          if (startResult && 'error' in startResult && startResult.error) {
            decision.error = `start failed: ${startResult.error}`;
            // Rollback: unassign so dispatcher can retry next tick
            if (this.deps.unassignTask) {
              try {
                await this.deps.unassignTask(pair.agent.id, pair.task.id);
              } catch {}
            }
            usedTasks.delete(pair.task.id);
            usedAgents.delete(pair.agent.id);
            remainingSlots += 1;
            decision.assigned = false;
          } else if (startResult && 'sessionId' in startResult && startResult.sessionId) {
            decision.started = true;
          }
        } catch (err) {
          decision.error = `start threw: ${String(err)}`;
          // Rollback: unassign so dispatcher can retry next tick
          if (this.deps.unassignTask) {
            try {
              await this.deps.unassignTask(pair.agent.id, pair.task.id);
            } catch {}
          }
          usedTasks.delete(pair.task.id);
          usedAgents.delete(pair.agent.id);
          remainingSlots += 1;
          decision.assigned = false;
        }
      }

      decisions.push(decision);
      this.recordDecision(decision);
    }
  }

  private recordDecision(decision: DispatchDecision): void {
    this.decisions.unshift(decision);
    if (this.decisions.length > MAX_DECISIONS) {
      this.decisions.length = MAX_DECISIONS;
    }
  }

  private broadcast(): void {
    if (!this.deps.broadcastState) return;
    try {
      this.deps.broadcastState(this.getState());
    } catch (err) {
      console.warn('[task-dispatcher] broadcastState threw:', err);
    }
  }
}

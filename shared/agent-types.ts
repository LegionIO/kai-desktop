/**
 * Types shared between main and renderer process for the Agents feature.
 */

export type AgentRuntime = 'claude-code' | 'codex' | 'mastra';
export type AgentStatus = 'idle' | 'running' | 'paused' | 'error';
export type AgentRole = 'general' | 'engineer' | 'reviewer' | 'researcher';

export interface AgentRuntimeConfig {
  /** Default working directory for this agent. */
  cwd?: string;
  /** Maximum seconds a single run can last before timeout. */
  maxSessionSeconds?: number;
  /** Max crashes per day before agent is paused (default 5). */
  maxCrashesPerDay?: number;
  /** Extra CLI arguments passed to the runtime command. */
  customArgs?: string[];
  /** Extra environment variables for the agent process. */
  env?: Record<string, string>;
}

export interface AgentStats {
  tasksCompleted: number;
  /** Total runtime in seconds across all runs. */
  totalRuntime: number;
  /** Crash count for the current day. */
  crashCount: number;
  lastRunAt?: string;
  lastCrashAt?: string;
}

export interface AgentFile {
  id: string;
  name: string;
  role: AgentRole;
  runtime: AgentRuntime;
  status: AgentStatus;
  /** Emoji or lucide icon name for display. */
  icon?: string;
  /** What this agent specializes in. */
  description?: string;
  /** ID of the task currently assigned to this agent. */
  currentTaskId?: string;
  /** Active PTY session ID (set when running). */
  terminalSessionId?: string;
  config: AgentRuntimeConfig;
  stats: AgentStats;
  createdAt: string;
  updatedAt: string;
  /** Optional workspace scope (agents are global by default). */
  workspaceId?: string;
}

/** Payload for creating a new agent. */
export interface CreateAgentPayload {
  name: string;
  role: AgentRole;
  runtime: AgentRuntime;
  icon?: string;
  description?: string;
  config?: Partial<AgentRuntimeConfig>;
  workspaceId?: string;
}

/**
 * Types shared between main and renderer process for Tasks.
 */

export type KaiTaskStatus = 'todo' | 'in_progress' | 'awaiting_approval' | 'ai_review' | 'human_review' | 'done';

export interface KaiTaskMetadata {
  category?: 'feature' | 'bug_fix' | 'refactoring' | 'docs' | 'other';
  labels?: string[];
  planFileName?: string;
  cwd?: string;
  /** Injected source conversation messages for council context. */
  sourceConversation?: Array<{ role: string; content: string }>;
  /** Plugin-set: allow arbitrary metadata from hooks. */
  [key: string]: unknown;
}

/** A message in the task's AI conversation history (for plan generation/refinement). */
export interface TaskConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface TaskFile {
  id: string;
  title: string;
  description: string;
  status: KaiTaskStatus;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp set when the task first moves to in_progress. */
  startedAt?: string;
  /** ISO timestamp set when the task is marked done. */
  completedAt?: string;
  sourceConversationId?: string;
  sourceToolCallId?: string;
  agentRuntime?: 'claude-code' | 'codex' | 'mastra' | string;
  terminalSessionId?: string;
  metadata?: KaiTaskMetadata;
  /** The agent assigned to work on this task. */
  assignedAgentId?: string;
  /** The workspace this task belongs to. Undefined = legacy/unscoped. */
  workspaceId?: string;
  /** Conversation history used to generate/refine the task description. */
  conversationHistory?: TaskConversationMessage[];
  /** ISO timestamp set when the task is archived. Archived tasks are hidden from normal views. */
  archivedAt?: string;
}

/** Column ordering state — maps each status to an ordered list of task IDs. */
export type KaiTaskOrder = Record<KaiTaskStatus, string[]>;

/** Events emitted during AI plan streaming. */
export type TaskStreamEvent = {
  taskId: string;
  type: 'text-delta' | 'done' | 'error';
  text?: string;
  error?: string;
};

/** A message from the council deliberation (streamed from Aithena plugin). */
export interface CouncilMessage {
  id: string;
  agent: 'aithena' | 'aidan' | 'airen' | 'user';
  phase: string;
  content: string;
  timestamp: string;
  type: 'text' | 'plan' | 'review' | 'outcome' | 'clarification';
}

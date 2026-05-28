/**
 * Types shared between main and renderer process for Tasks.
 */

export type KaiTaskStatus = 'todo' | 'in_progress' | 'blocked' | 'ai_review' | 'human_review' | 'done';

export interface KaiTaskMetadata {
  category?: 'feature' | 'bug_fix' | 'refactoring' | 'docs' | 'other';
  labels?: string[];
  planFileName?: string;
  cwd?: string;
}

/** A message in the task's AI conversation history (for plan generation/refinement). */
export interface TaskConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

/** A review feedback note — added when a task is kicked back from review. */
export interface TaskReviewNote {
  /** Who wrote this note: 'ai' (AI reviewer) or 'human' (manual). */
  source: 'ai' | 'human';
  /** The feedback/reasoning for why the task was kicked back. */
  content: string;
  /** ISO timestamp when the note was added. */
  timestamp: string;
  /** Which status the task was in when kicked back (ai_review or human_review). */
  fromStatus: KaiTaskStatus;
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
  /** Review feedback entries — accumulated when a task is kicked back from review. */
  reviewNotes?: TaskReviewNote[];
  sourceConversationId?: string;
  sourceToolCallId?: string;
  agentRuntime?: 'claude-code' | 'codex' | 'mastra' | string;
  terminalSessionId?: string;
  metadata?: KaiTaskMetadata;
  /** The agent assigned to work on this task. */
  assignedAgentId?: string;
  /** The agent assigned to review this task (AI review phase). */
  reviewerAgentId?: string;
  /** If true, skip AI review and go directly to human_review on promote. */
  skipAiReview?: boolean;
  /** The workspace this task belongs to. Undefined = legacy/unscoped. */
  workspaceId?: string;
  /** Conversation history used to generate/refine the task description. */
  conversationHistory?: TaskConversationMessage[];
  /** ISO timestamp set when the task is archived. Archived tasks are hidden from normal views. */
  archivedAt?: string;
  /** Optional priority used by the orchestrator when ranking tasks. Higher = sooner. */
  priority?: number;
  /** AI-generated summary written when the task completes. */
  completionSummary?: string;
  /** The exit code from the last terminal session for this task. */
  lastExitCode?: number;
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

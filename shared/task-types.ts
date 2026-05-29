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

/** Tracks an individual reviewer's result during the AI review phase. */
export interface TaskReviewResult {
  agentId: string;
  agentName: string;
  status: 'pending' | 'approved' | 'rejected';
  feedback?: string;
  timestamp?: string;
  terminalSessionId?: string;
}

/** A single execution or review attempt on a task — part of the audit trail. */
export interface TaskRun {
  /** Unique ID for this run. */
  id: string;
  /** Sequential run number (1, 2, 3...). */
  number: number;
  /** What type of run: executor working on the task, or reviewer reviewing it. */
  type: 'execution' | 'review';
  /** Agent that performed this run. */
  agentId: string;
  agentName: string;
  /** Terminal session ID — used to retrieve persisted output from disk. */
  terminalSessionId: string;
  /** ISO timestamp when the run started. */
  startedAt: string;
  /** ISO timestamp when the run completed. */
  completedAt?: string;
  /** Exit code (for PTY-based runs). */
  exitCode?: number;
  /** Outcome of this run. */
  outcome?: 'promoted' | 'blocked' | 'rejected' | 'approved' | 'timeout' | 'crashed' | 'stopped';
  /** Reason/summary for the outcome. */
  summary?: string;
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
  /** Reviewer agent IDs — zero to many. All must approve for promotion. */
  reviewerAgentIds?: string[];
  /** Review execution mode: parallel (all at once) or sequential (one after another). */
  reviewMode?: 'parallel' | 'sequential';
  /** Tracks individual reviewer results during AI review phase. */
  reviewResults?: TaskReviewResult[];
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
  /** Number of times this task has been auto-retried (timeout recovery). */
  retryCount?: number;
  /** Number of AI unblock attempts made on this task. */
  unblockAttempts?: number;
  /** Chronological history of all execution and review runs (audit trail). */
  runs?: TaskRun[];
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

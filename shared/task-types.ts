/**
 * Types shared between main and renderer process for the Tasks kanban board.
 */

export type KaiTaskStatus = 'todo' | 'in_progress' | 'ai_review' | 'human_review' | 'done';

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

export interface TaskFile {
  id: string;
  title: string;
  description: string;
  status: KaiTaskStatus;
  createdAt: string;
  updatedAt: string;
  sourceConversationId?: string;
  sourceToolCallId?: string;
  agentRuntime?: 'claude-code' | 'codex' | 'mastra' | string;
  terminalSessionId?: string;
  metadata?: KaiTaskMetadata;
  /** Conversation history used to generate/refine the task description. */
  conversationHistory?: TaskConversationMessage[];
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

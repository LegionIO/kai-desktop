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
}

/** Column ordering state — maps each status to an ordered list of task IDs. */
export type KaiTaskOrder = Record<KaiTaskStatus, string[]>;

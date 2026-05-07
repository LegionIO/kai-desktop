/**
 * Renderer-side task types, constants, and helpers for the kanban board.
 *
 * Core types are re-exported from the shared module to keep main/renderer in sync.
 */

export type { TaskFile, KaiTaskMetadata, KaiTaskOrder, TaskConversationMessage, TaskStreamEvent } from '../../shared/task-types';
export type { KaiTaskStatus } from '../../shared/task-types';

import type { KaiTaskStatus } from '../../shared/task-types';

// ── Column Definitions ────────────────────────────────────────────────────

/** Ordered list of columns in the kanban board. */
export const KAI_TASK_STATUS_COLUMNS: KaiTaskStatus[] = [
  'todo',
  'in_progress',
  'ai_review',
  'human_review',
  'done',
];

/** Human-readable labels for each lane. */
export const KAI_TASK_STATUS_LABELS: Record<KaiTaskStatus, string> = {
  todo: 'Todo',
  in_progress: 'In Progress',
  ai_review: 'AI Review',
  human_review: 'Human Review',
  done: 'Done',
};

/** Tailwind color classes for each lane's status badge. */
export const KAI_TASK_STATUS_COLORS: Record<KaiTaskStatus, string> = {
  todo: 'bg-sky-500/10 text-sky-600',
  in_progress: 'bg-rose-500/10 text-rose-500',
  ai_review: 'bg-amber-500/10 text-amber-500',
  human_review: 'bg-purple-500/10 text-purple-400',
  done: 'bg-emerald-500/10 text-emerald-500',
};

/** Border accent color for kanban columns (thick top). */
export const KAI_TASK_STATUS_BORDER_COLORS: Record<KaiTaskStatus, string> = {
  todo: 'border-t-sky-500',
  in_progress: 'border-t-rose-500',
  ai_review: 'border-t-amber-500',
  human_review: 'border-t-purple-400',
  done: 'border-t-emerald-500',
};

/** Subtle outer border color for kanban columns. */
export const KAI_TASK_STATUS_OUTER_BORDER_COLORS: Record<KaiTaskStatus, string> = {
  todo: 'border-sky-500/20',
  in_progress: 'border-rose-500/20',
  ai_review: 'border-amber-500/20',
  human_review: 'border-purple-400/20',
  done: 'border-emerald-500/20',
};

// ── Plan → Task bridge type ───────────────────────────────────────────────

/** Data passed from the plan approval callback to task creation. */
export interface PlanApprovedData {
  title: string;
  description: string;
  planFileName?: string;
  toolCallId: string;
  conversationId?: string;
}

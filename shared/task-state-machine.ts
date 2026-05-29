/**
 * Formal state machine for KaiTaskStatus transitions.
 *
 * Defines the legal transitions between task statuses, including which
 * actor (manual user action, automated agent reconciliation, or both) is
 * allowed to drive each transition.
 *
 * Used by the renderer to validate user-initiated status changes and by
 * the main process reconciliation loop to apply automated transitions.
 */

import type { KaiTaskStatus } from './task-types';

/** A single legal status transition. */
export interface TransitionRule {
  from: KaiTaskStatus;
  to: KaiTaskStatus;
  /**
   * Who is allowed to drive this transition:
   *  - `manual` — only triggered by an explicit user action (drag-drop, button)
   *  - `auto`   — only triggered by automated reconciliation (e.g. terminal exit)
   *  - `both`   — either path is allowed
   */
  trigger: 'manual' | 'auto' | 'both';
  /** Optional human-readable description of when this transition fires. */
  condition?: string;
}

/**
 * The complete set of legal transitions in the task workflow.
 *
 *   todo ──▶ in_progress ──▶ ai_review ──▶ human_review ──▶ done
 *                  │              │              │            │
 *                  ├──────────────┴──────────────┘            │
 *                  └──────────────────────────────────────────┘
 *                                   │
 *                              done ──▶ todo (reopen)
 */
export const TASK_TRANSITIONS: readonly TransitionRule[] = [
  // ── Forward flow ──────────────────────────────────────────────────────
  {
    from: 'todo',
    to: 'in_progress',
    trigger: 'both',
    condition: 'Agent started or user manually moves task into work',
  },
  {
    from: 'todo',
    to: 'done',
    trigger: 'manual',
    condition: 'User marks task done without executing (e.g. already completed)',
  },
  {
    from: 'todo',
    to: 'human_review',
    trigger: 'manual',
    condition: 'User moves task directly to review',
  },
  {
    from: 'in_progress',
    to: 'human_review',
    trigger: 'both',
    condition: 'Agent finished and human review is required',
  },
  {
    from: 'in_progress',
    to: 'ai_review',
    trigger: 'both',
    condition: 'Agent finished and AI review is enabled',
  },
  {
    from: 'in_progress',
    to: 'done',
    trigger: 'both',
    condition: 'Agent finished cleanly with no review required',
  },
  {
    from: 'in_progress',
    to: 'todo',
    trigger: 'manual',
    condition: 'User moves task back to backlog',
  },
  {
    from: 'ai_review',
    to: 'human_review',
    trigger: 'both',
    condition: 'AI review surfaced issues that need a human',
  },
  {
    from: 'ai_review',
    to: 'done',
    trigger: 'both',
    condition: 'AI review passed without requiring a human',
  },
  {
    from: 'ai_review',
    to: 'in_progress',
    trigger: 'both',
    condition: 'AI review found problems and sent the task back for more work',
  },
  {
    from: 'ai_review',
    to: 'todo',
    trigger: 'manual',
    condition: 'User moves task back to backlog',
  },
  {
    from: 'human_review',
    to: 'done',
    trigger: 'manual',
    condition: 'Human approved the work',
  },
  {
    from: 'human_review',
    to: 'in_progress',
    trigger: 'manual',
    condition: 'Human requested additional work',
  },
  {
    from: 'human_review',
    to: 'todo',
    trigger: 'manual',
    condition: 'User moves task back to backlog',
  },
  {
    from: 'done',
    to: 'todo',
    trigger: 'manual',
    condition: 'Reopen a completed task',
  },
  {
    from: 'done',
    to: 'in_progress',
    trigger: 'manual',
    condition: 'Reopen and immediately resume work',
  },
  {
    from: 'done',
    to: 'human_review',
    trigger: 'manual',
    condition: 'Send back to human review (e.g. mistake found after completion)',
  },
  {
    from: 'done',
    to: 'ai_review',
    trigger: 'manual',
    condition: 'Send back to AI review (e.g. re-evaluate completed work)',
  },
  // ── Blocked transitions ──────────────────────────────────────────────
  {
    from: 'in_progress',
    to: 'blocked',
    trigger: 'both',
    condition: 'Agent or human marks task as blocked (with reason)',
  },
  {
    from: 'todo',
    to: 'blocked',
    trigger: 'manual',
    condition: 'Task is blocked before work begins',
  },
  {
    from: 'blocked',
    to: 'in_progress',
    trigger: 'both',
    condition: 'Blocker resolved — resume work',
  },
  {
    from: 'blocked',
    to: 'todo',
    trigger: 'manual',
    condition: 'Move blocked task back to backlog',
  },
] as const;

/** Returns the statuses a user is allowed to manually transition to from `current`. */
export function getValidManualTransitions(current: KaiTaskStatus): KaiTaskStatus[] {
  return TASK_TRANSITIONS.filter(
    (rule) => rule.from === current && (rule.trigger === 'manual' || rule.trigger === 'both'),
  ).map((rule) => rule.to);
}

/**
 * Returns true if `from → to` is a legal transition under any trigger.
 *
 * This is a permissive check used by the renderer before issuing an IPC
 * call. The main process is the authoritative validator and may apply
 * stricter rules (e.g. auto-only transitions).
 */
export function isValidTransition(from: KaiTaskStatus, to: KaiTaskStatus): boolean {
  if (from === to) return true;
  return TASK_TRANSITIONS.some((rule) => rule.from === from && rule.to === to);
}

/** Returns the statuses that automated reconciliation is allowed to move to from `current`. */
export function getAutoTransitions(current: KaiTaskStatus): KaiTaskStatus[] {
  return TASK_TRANSITIONS.filter(
    (rule) => rule.from === current && (rule.trigger === 'auto' || rule.trigger === 'both'),
  ).map((rule) => rule.to);
}

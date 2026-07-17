/**
 * AI-powered task unblocking for the autopilot scrum master.
 *
 * Reads the block reason from a task's reviewNotes and uses AI to determine
 * if the blocker can be resolved without human intervention.
 */

import type { TaskFile } from '../../shared/task-types.js';
import { auxGenerateText } from './generate-fallback.js';

export interface UnblockResult {
  /** Whether the AI believes the blocker can be resolved autonomously. */
  resolved: boolean;
  /** Explanation of how to resolve (if resolved=true). */
  resolution?: string;
  /** Whether this requires human intervention (if resolved=false). */
  requiresHuman?: boolean;
  /** Brief reason why it can't be auto-resolved. */
  reason?: string;
}

/**
 * Attempt to assess and resolve a blocked task using AI.
 *
 * Returns a resolution suggestion if the block appears solvable,
 * or indicates that human intervention is needed.
 */
export async function attemptUnblock(task: TaskFile): Promise<UnblockResult> {
  // Find the most recent block reason
  const blockNote = [...(task.reviewNotes ?? [])]
    .reverse()
    .find((n) => n.fromStatus === 'in_progress' || n.content.toLowerCase().includes('block'));

  if (!blockNote) {
    return { resolved: false, requiresHuman: true, reason: 'No block reason found' };
  }

  try {
    const prompt = [
      'You are a scrum master AI assessing whether a blocked task can be unblocked automatically.',
      '',
      'A task is blocked. Determine if the blocker can be resolved by an AI agent re-attempting the task,',
      'or if it genuinely requires human intervention (e.g., credentials, external approval, physical access).',
      '',
      `TASK TITLE: ${task.title}`,
      `TASK DESCRIPTION: ${(task.description ?? '').slice(0, 1500)}`,
      `BLOCK REASON: ${blockNote.content}`,
      `BLOCKED SINCE: ${blockNote.timestamp}`,
      '',
      'Respond with EXACTLY one of these formats:',
      'RESOLVABLE: <brief explanation of why the agent can retry and what to do differently>',
      'REQUIRES_HUMAN: <brief explanation of why a human must intervene>',
    ].join('\n');

    const gen = await auxGenerateText({ prompt, maxOutputTokens: 200 }, { label: 'task-unblock' });
    if (!gen) {
      return { resolved: false, requiresHuman: true, reason: 'No model configured for AI assessment' };
    }
    const raw = gen.text.trim();

    if (raw.startsWith('RESOLVABLE:')) {
      const resolution = raw.replace('RESOLVABLE:', '').trim();
      // An empty RESOLVABLE (no actual guidance) is not a real resolution —
      // treat it as needing a human rather than silently "unblocking" with nothing.
      if (!resolution) {
        return { resolved: false, requiresHuman: true, reason: 'AI returned RESOLVABLE with no guidance' };
      }
      return { resolved: true, resolution };
    }

    return {
      resolved: false,
      requiresHuman: true,
      reason: raw.replace('REQUIRES_HUMAN:', '').trim() || 'AI determined human intervention needed',
    };
  } catch (err) {
    console.warn('[task-unblocker] AI assessment failed:', err);
    return { resolved: false, requiresHuman: true, reason: 'AI assessment failed' };
  }
}

/**
 * Assess whether a completed task is complex enough to require human review,
 * even when the review policy would normally skip it.
 */
export async function assessComplexity(task: TaskFile): Promise<boolean> {
  try {
    const prompt = [
      'You are assessing whether completed work needs human review.',
      'Answer YES if the task involves any of: security changes, data migrations,',
      'infrastructure changes, API contract changes, financial logic, PII handling,',
      'or anything that cannot be fully validated by automated tests.',
      'Answer NO if the task is straightforward and fully testable.',
      '',
      `TASK TITLE: ${task.title}`,
      `TASK DESCRIPTION: ${(task.description ?? '').slice(0, 1500)}`,
      `COMPLETION SUMMARY: ${(task.completionSummary ?? '').slice(0, 500)}`,
      '',
      'Respond with EXACTLY: YES or NO (one word only)',
    ].join('\n');

    const gen = await auxGenerateText({ prompt, maxOutputTokens: 10 }, { label: 'assess-complexity' });
    if (!gen) return true; // Conservative: require human review if no AI available
    return assessComplexityFromAnswer(gen.text.trim().toUpperCase());
  } catch (err) {
    console.warn('[task-unblocker] Complexity assessment failed:', err);
    return true; // Conservative fallback
  }
}

/**
 * Map the complexity-check model's raw answer to "does this task still require
 * human review?". Pure + fail-safe: ONLY a standalone "NO" (optionally with
 * trailing . or !) skips review; "NONE", "NOT SURE", "NO123", empty, and any
 * other/malformed output all still require review. Exported for unit testing.
 * Callers pass the already trimmed+uppercased answer.
 */
export function assessComplexityFromAnswer(upperTrimmedAnswer: string): boolean {
  const isStandaloneNo = /^NO[.!]?$/.test(upperTrimmedAnswer);
  return !isStandaloneNo;
}

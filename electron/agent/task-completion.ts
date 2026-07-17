/**
 * Task completion analysis and AI-powered summarization.
 *
 * Used by the orchestrator (and the agents reconciler) to decide what to do
 * after an agent's terminal session exits, and to optionally generate a short
 * human-readable summary of what the agent did.
 */

import type { AgentFile } from '../../shared/agent-types.js';
import type { KaiTaskStatus, TaskFile } from '../../shared/task-types.js';
import { auxGenerateText } from './generate-fallback.js';

export interface CompletionAnalysisConfig {
  /** When true, exit-code-zero runs go to human_review rather than done. */
  requireHumanReview: boolean;
  /** Agent IDs assigned as reviewers for this task. */
  reviewerAgentIds?: string[];
  /** Current retry count for the task. */
  retryCount?: number;
}

export interface CompletionResult {
  /** What status the task should transition to. */
  nextStatus: KaiTaskStatus;
  /** True when the exit code looked like a crash (>1 or negative). */
  wasCrash?: boolean;
  /** True when the exit code looked like a timeout (124). */
  wasTimeout?: boolean;
  /** When true, caller should restart the agent (timeout retry). */
  shouldRetry?: boolean;
  /** Reason string for blocked state. */
  blockedReason?: string;
}

/**
 * Decide the post-run task status based on an agent's terminal exit code.
 *
 * Convention:
 *   - exit === 124          → timeout: retry up to 2×, then block
 *   - exit > 1 or exit < 0  → crash → blocked
 *   - exit === 0            → success: reviewers → ai_review, else human_review or done
 *   - exit === 1            → soft failure → ai_review (retry candidate)
 */
export function analyzeCompletion(
  exitCode: number,
  _agent: AgentFile,
  _task: TaskFile,
  config: CompletionAnalysisConfig,
): CompletionResult {
  // Timeout: auto-retry up to 2 times, then block
  if (exitCode === 124) {
    const retryCount = config.retryCount ?? 0;
    if (retryCount < 2) {
      return { nextStatus: 'in_progress', wasTimeout: true, shouldRetry: true };
    }
    return { nextStatus: 'blocked', wasTimeout: true, blockedReason: `Timeout after ${retryCount + 1} attempts` };
  }

  // Unknown / non-numeric exit (signal-killed session, missing exit code): do
  // NOT fall through to the exit-1 soft-failure path (which would send a run
  // that never cleanly finished to review as a retry candidate). Block it so a
  // human sees it. Must come BEFORE the numeric comparisons — NaN fails every
  // comparison and would otherwise slip to the final ai_review return.
  if (!Number.isFinite(exitCode)) {
    return { nextStatus: 'blocked', wasCrash: true, blockedReason: 'Process ended with no exit code (killed?)' };
  }

  // Crash: immediately block
  if (exitCode > 1 || exitCode < 0) {
    return { nextStatus: 'blocked', wasCrash: true, blockedReason: `Process crashed (exit code ${exitCode})` };
  }

  // Success: route through review pipeline
  if (exitCode === 0) {
    // AI review takes priority when reviewers are assigned
    if (config.reviewerAgentIds && config.reviewerAgentIds.length > 0) {
      return { nextStatus: 'ai_review' };
    }
    if (config.requireHumanReview) {
      return { nextStatus: 'human_review' };
    }
    return { nextStatus: 'done' };
  }

  // Soft failure (exit 1): route to AI review for retry/analysis
  return { nextStatus: 'ai_review' };
}

/**
 * Use a fast model (Haiku) to summarize the last chunk of terminal output
 * in 1-3 sentences. Returns null on any error — summaries are non-critical.
 */
export async function generateCompletionSummary(
  terminalOutput: string,
  task: TaskFile,
  config: { matchingStrategy?: 'simple' | 'ai-scored' } = {},
): Promise<string | null> {
  if (!terminalOutput || terminalOutput.trim().length === 0) return null;

  // Only generate a summary when the matching strategy implies AI usage,
  // so users on 'simple' don't pay for unexpected Haiku calls.
  // Default behavior: try, but swallow all errors.
  const strategy = config.matchingStrategy ?? 'simple';
  if (strategy === 'simple') return null;

  try {
    const tail = terminalOutput.slice(-2000);

    const prompt = [
      `Task title: ${task.title}`,
      `Task description: ${task.description ?? ''}`,
      '',
      "Below is the tail of the agent's terminal output. Summarize what the agent",
      'accomplished (or failed to accomplish) in 1-3 short sentences. Be concrete:',
      'mention files changed, tests run, errors encountered. No filler.',
      '',
      '--- terminal output (tail) ---',
      tail,
      '--- end ---',
    ].join('\n');

    const gen = await auxGenerateText({ prompt, maxOutputTokens: 256 }, { label: 'completion-summary' });
    if (!gen) return null;

    const cleaned = (gen.text ?? '').trim();
    return cleaned.length > 0 ? cleaned : null;
  } catch (err) {
    console.warn('[task-completion] Failed to generate completion summary:', err);
    return null;
  }
}

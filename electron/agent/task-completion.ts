/**
 * Task completion analysis and AI-powered summarization.
 *
 * Used by the orchestrator (and the agents reconciler) to decide what to do
 * after an agent's terminal session exits, and to optionally generate a short
 * human-readable summary of what the agent did.
 */

import type { AgentFile } from '../../shared/agent-types.js';
import type { KaiTaskStatus, TaskFile } from '../../shared/task-types.js';

export interface CompletionAnalysisConfig {
  /** When true, exit-code-zero runs go to human_review rather than done. */
  requireHumanReview: boolean;
}

export interface CompletionResult {
  /** What status the task should transition to. */
  nextStatus: Exclude<KaiTaskStatus, 'todo' | 'in_progress'>;
  /** True when the exit code looked like a crash (>1 or negative). */
  wasCrash?: boolean;
  /** True when the exit code looked like a timeout (124). */
  wasTimeout?: boolean;
}

/**
 * Decide the post-run task status based on an agent's terminal exit code.
 *
 * Convention:
 *   - exit > 1 or exit < 0  → crash       → human_review
 *   - exit === 124          → timeout     → human_review (matches GNU `timeout`)
 *   - exit === 0 + review   → success but human review required → human_review
 *   - exit === 0 + !review  → clean success                     → done
 *   - exit === 1 (anything else nonzero) → ai_review (soft failure / retry candidate)
 */
export function analyzeCompletion(
  exitCode: number,
  _agent: AgentFile,
  _task: TaskFile,
  config: CompletionAnalysisConfig,
): CompletionResult {
  if (exitCode === 124) {
    return { nextStatus: 'human_review', wasTimeout: true };
  }

  if (exitCode > 1 || exitCode < 0) {
    return { nextStatus: 'human_review', wasCrash: true };
  }

  if (exitCode === 0) {
    return { nextStatus: config.requireHumanReview ? 'human_review' : 'done' };
  }

  // Anything else (typically exit 1) — surface for AI/human review.
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
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;

    const tail = terminalOutput.slice(-2000);

    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const { generateText } = await import('ai');

    const anthropic = createAnthropic({ apiKey });
    const model = anthropic('claude-3-5-haiku-latest');

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

    const { text } = await generateText({
      model,
      prompt,
      maxOutputTokens: 256,
    });

    const cleaned = (text ?? '').trim();
    return cleaned.length > 0 ? cleaned : null;
  } catch (err) {
    console.warn('[task-completion] Failed to generate completion summary:', err);
    return null;
  }
}

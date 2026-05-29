/**
 * AI-powered task unblocking for the autopilot scrum master.
 *
 * Reads the block reason from a task's reviewNotes and uses AI to determine
 * if the blocker can be resolved without human intervention.
 */

import type { TaskFile } from '../../shared/task-types.js';

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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { resolved: false, requiresHuman: true, reason: 'No API key for AI assessment' };
  }

  try {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const { generateText } = await import('ai');

    const anthropic = createAnthropic({ apiKey });
    const model = anthropic('claude-3-5-haiku-latest');

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

    const { text } = await generateText({
      model,
      prompt,
      maxOutputTokens: 200,
    });

    const raw = (text ?? '').trim();

    if (raw.startsWith('RESOLVABLE:')) {
      return {
        resolved: true,
        resolution: raw.replace('RESOLVABLE:', '').trim(),
      };
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
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return true; // Conservative: require human review if no AI available

  try {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const { generateText } = await import('ai');

    const anthropic = createAnthropic({ apiKey });
    const model = anthropic('claude-3-5-haiku-latest');

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

    const { text } = await generateText({
      model,
      prompt,
      maxOutputTokens: 10,
    });

    const answer = (text ?? '').trim().toUpperCase();
    return answer.startsWith('YES');
  } catch (err) {
    console.warn('[task-unblocker] Complexity assessment failed:', err);
    return true; // Conservative fallback
  }
}

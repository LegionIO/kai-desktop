/**
 * AI review — runs a fast, structured review of an agent's terminal session
 * to decide whether the work is ready for a human or needs another pass.
 *
 * Uses Claude 3.5 Haiku via the AI SDK for low-latency, low-cost analysis.
 * Returns a structured verdict the reconciliation loop can act on.
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';

const AI_REVIEW_SYSTEM_PROMPT = [
  'You are a senior code reviewer evaluating the output of an autonomous coding agent.',
  'You will be given (1) the task description and (2) the terminal output from the agent.',
  'Decide whether the agent appears to have completed the task successfully.',
  '',
  'Respond with ONLY a JSON object on a single line, no markdown or prose:',
  '{"passed": boolean, "summary": string, "issues": [string, ...] | null}',
  '',
  '- "passed": true if the task looks done and ready to ship, false if it needs more work.',
  '- "summary": one short sentence (<= 140 chars) describing the outcome.',
  '- "issues": list of concrete problems if any, otherwise null.',
].join('\n');

const REVIEW_MODEL = 'claude-3-5-haiku-latest';

/** Trim terminal output so the review prompt stays cheap. */
function truncateTerminalOutput(output: string, maxChars = 12000): string {
  if (output.length <= maxChars) return output;
  const head = output.slice(0, Math.floor(maxChars * 0.3));
  const tail = output.slice(output.length - Math.floor(maxChars * 0.7));
  return `${head}\n\n... [output truncated, ${output.length - maxChars} chars omitted] ...\n\n${tail}`;
}

export interface AIReviewResult {
  passed: boolean;
  summary: string;
  issues?: string[];
}

export interface AIReviewModelConfig {
  apiKey?: string;
}

/**
 * Run an AI review of an agent's work.
 *
 * @param taskDescription - The original task instructions / plan.
 * @param terminalOutput  - Captured stdout from the agent's PTY session.
 * @param modelConfig     - API credentials (falls back to ANTHROPIC_API_KEY env var).
 */
export async function runAIReview(
  taskDescription: string,
  terminalOutput: string,
  modelConfig: AIReviewModelConfig,
): Promise<AIReviewResult> {
  const anthropic = createAnthropic({
    apiKey: modelConfig.apiKey ?? process.env.ANTHROPIC_API_KEY,
  });

  const prompt = [
    '## Task',
    taskDescription.trim() || '(no description provided)',
    '',
    '## Terminal Output',
    '```',
    truncateTerminalOutput(terminalOutput),
    '```',
    '',
    'Return your verdict as the specified JSON object.',
  ].join('\n');

  try {
    const { text } = await generateText({
      model: anthropic(REVIEW_MODEL),
      system: AI_REVIEW_SYSTEM_PROMPT,
      prompt,
    });

    return parseReviewResponse(text);
  } catch (error) {
    // On failure, fall back to a conservative "needs human review" verdict
    // so we never silently mark broken work as done.
    return {
      passed: false,
      summary: `AI review failed: ${error instanceof Error ? error.message : String(error)}`,
      issues: ['AI reviewer was unable to evaluate the output.'],
    };
  }
}

function parseReviewResponse(text: string): AIReviewResult {
  // Find the first {...} block — the model occasionally wraps JSON in fences
  // despite the instructions.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return {
      passed: false,
      summary: 'AI reviewer returned a non-JSON response.',
      issues: ['Unparseable review output.'],
    };
  }

  const slice = text.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return {
      passed: false,
      summary: 'AI reviewer returned malformed JSON.',
      issues: ['Unparseable review output.'],
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      passed: false,
      summary: 'AI reviewer returned an unexpected shape.',
      issues: ['Unparseable review output.'],
    };
  }

  const obj = parsed as { passed?: unknown; summary?: unknown; issues?: unknown };
  const passed = obj.passed === true;
  const summary = typeof obj.summary === 'string' ? obj.summary : '';
  const issues = Array.isArray(obj.issues)
    ? obj.issues.filter((i): i is string => typeof i === 'string')
    : undefined;

  return {
    passed,
    summary,
    ...(issues && issues.length > 0 ? { issues } : {}),
  };
}

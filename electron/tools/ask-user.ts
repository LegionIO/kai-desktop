import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { createAlert, type AlertQuestion } from '../ipc/alert-store.js';
import { notifyAlertCreated } from '../ipc/alert-notify.js';

/**
 * Shared map where agent.ts stores user answers before the tool's execute runs.
 * Key: toolCallId, Value: user's answers keyed by question text.
 */
export const pendingQuestionAnswers = new Map<string, Record<string, string>>();

/** Bound on {@link pendingQuestionAnswers}. Answers are normally read+deleted by
 *  ask_user.execute, but a turn aborted/errored in the narrow window after the
 *  user answered and before execute re-runs orphans the entry (nothing else
 *  removes it). A FIFO cap bounds that leak — matching the other bounded maps in
 *  the codebase (loginAttempts, exitCodes). */
const MAX_PENDING_QUESTION_ANSWERS = 100;

/** Stash user answers under `toolCallId`, evicting the oldest entries so an
 *  orphaned (never-consumed) entry can't grow the map without bound. */
export function stashQuestionAnswers(toolCallId: string, answers: Record<string, string>): void {
  pendingQuestionAnswers.set(toolCallId, answers);
  while (pendingQuestionAnswers.size > MAX_PENDING_QUESTION_ANSWERS) {
    const oldest = pendingQuestionAnswers.keys().next().value;
    if (oldest === undefined) break;
    pendingQuestionAnswers.delete(oldest);
  }
}

const questionOptionSchema = z.object({
  label: z.string().describe('Short display text for the option (1-5 words)'),
  description: z.string().optional().describe('Explanation of what this option means'),
});

const questionSchema = z.object({
  question: z
    .string()
    .describe('The complete question to ask the user. Should be clear, specific, and end with a question mark.'),
  header: z.string().max(40).describe('Short tab label (max 40 chars), e.g. "Auth method", "Library", "File Location"'),
  options: z
    .array(questionOptionSchema)
    .min(2)
    .max(6)
    .describe(
      'Available choices (2-4 options preferred, up to 6 maximum). Each should be distinct. Do NOT include an "Other" option — one is provided automatically by the UI.',
    ),
  multiSelect: z
    .boolean()
    .optional()
    .default(false)
    .describe('Allow multiple selections. Use when choices are not mutually exclusive.'),
});

export function createAskUserTool(appHome?: string): ToolDefinition {
  return {
    name: 'ask_user',
    description: [
      'Ask the user a question with multiple-choice options.',
      'Use this when you need clarification, want user preferences, or need a decision before proceeding.',
      'Each question has a short header for tab display, the question text, and 2-4 options.',
      'The user can also type a custom "Other" response.',
      'You can ask up to 4 questions at once — each appears as a tab.',
      'The tool blocks until the user responds.',
    ].join(' '),
    inputSchema: z.object({
      questions: z.array(questionSchema).min(1).max(4).describe('Questions to ask (1-4)'),
    }),
    execute: async (input, context) => {
      // By the time execute runs, agent.ts has already stored the user's answers
      const answers = pendingQuestionAnswers.get(context.toolCallId);
      pendingQuestionAnswers.delete(context.toolCallId);

      if (!answers) {
        // Headless / automation run: no live user gated this call, so there are
        // no answers and blocking would be pointless. Fall back to a persistent
        // Alert (like request_review) so the user can answer later and the run
        // resumes. Requires a conversation to resume into + the alert store.
        if (context.isHeadless && appHome && context.conversationId) {
          const questions = (input as { questions?: AlertQuestion[] }).questions ?? [];
          const first = questions[0]?.question ?? 'A question';
          const alert = createAlert(appHome, {
            kind: 'question',
            title: first.length > 80 ? `${first.slice(0, 77)}…` : first,
            body: questions.map((q) => `• ${q.question}`).join('\n'),
            conversationId: context.conversationId,
            questions,
          });
          notifyAlertCreated(alert);
          return {
            suspended: true,
            alertId: alert.id,
            note: 'No live user to answer right now — raised an Alert. End your turn; the user will answer and their response comes back to you as a new message.',
          };
        }
        return { error: 'No user response received' };
      }

      return {
        success: true,
        answers,
      };
    },
  };
}

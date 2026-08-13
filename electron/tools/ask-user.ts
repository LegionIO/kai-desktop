import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { createAlert, listAlerts, type AlertQuestion } from '../ipc/alert-store.js';
import { notifyAlertCreated } from '../ipc/alert-notify.js';
import { traceDiagnostic } from '../diagnostics/debug-trace.js';

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

/**
 * The message the ask_user tool returns when its `execute` runs but no answers
 * were recorded. Distinct from a genuine dismiss (handled upstream in the gate,
 * which skips execution) — this only surfaces if execute runs with no stash,
 * which normally means the turn was cancelled/superseded before the answer was
 * consumed. Worded so the model doesn't mistake it for the user staying silent.
 */
export const ASK_USER_NO_ANSWER_ERROR =
  'No response was recorded for this question — it may have been cancelled or interrupted before the answer was consumed.';

/**
 * Pure decision for how the ask_user approval gate should resolve, given the
 * `registerPendingApproval` outcome and whether the turn controller was aborted.
 * Factored out of agent.ts's large stream closure so it is unit-testable.
 *
 * - `approved === true` → run the tool (`skip: false`); answers are stashed.
 * - `false` (genuine reject) or a non-aborted `'dismiss'` (user closed the card)
 *   → skip with a clear "dismissed" result.
 * - an ABORTED `'dismiss'` (turn cancelled/superseded/plan-restart while the
 *   question was open) → skip with a neutral "cancelled" result and do NOT emit
 *   the scary no-answer error. Any answer the user submitted in the race window
 *   is preserved in the bounded stash for a restarted turn to consume.
 */
export function resolveAskUserGateOutcome(
  approved: boolean | 'dismiss',
  aborted: boolean,
): { skip: false } | { skip: true; result: { isError: true; error: string }; reason: 'reject' | 'dismiss' | 'abort' } {
  if (approved === true) return { skip: false };
  if (aborted && approved === 'dismiss') {
    return {
      skip: true,
      reason: 'abort',
      result: { isError: true, error: 'The question was cancelled because the turn ended before it was answered.' },
    };
  }
  return {
    skip: true,
    reason: approved === false ? 'reject' : 'dismiss',
    result: { isError: true, error: 'The user dismissed the question without answering.' },
  };
}

/** Grace budget for {@link waitForRacedAnswer}: number of poll attempts and the
 *  delay between them. ~10 × 25ms ≈ 250ms comfortably covers an in-flight answer
 *  IPC message that lost the race to a synchronous controller abort, and is
 *  imperceptible to the user. Expressed as an ATTEMPT COUNT rather than a
 *  wall-clock deadline so it is immune to a frozen/mocked `Date.now()`. */
const RACED_ANSWER_ATTEMPTS = 10;
const RACED_ANSWER_POLL_MS = 25;

/**
 * Briefly wait for a user answer that raced a controller abort to land in the
 * stash under `key`. When `controller.abort()` fires, it settles the pending
 * approval SYNCHRONOUSLY; the awaiting gate then resumes as a microtask, which
 * can run BEFORE the user's already-sent `agent:answer-tool-question` IPC
 * message is processed. Without a grace window the gate sees no answer, skips,
 * and the answer is orphaned under the old tool-call id (a restart mints a new
 * one). Resolves as soon as the answer appears, or after `attempts` polls.
 *
 * Only meaningful on the abort path — a genuine user dismiss/reject has no
 * in-flight answer to wait for, so callers should not invoke this then.
 */
export async function waitForRacedAnswer(
  key: string,
  attempts: number = RACED_ANSWER_ATTEMPTS,
  stepMs: number = RACED_ANSWER_POLL_MS,
): Promise<Record<string, string> | undefined> {
  let answer = pendingQuestionAnswers.get(key);
  for (let i = 0; i < attempts && !answer; i++) {
    await new Promise((r) => setTimeout(r, stepMs));
    answer = pendingQuestionAnswers.get(key);
  }
  return answer;
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
          const title = first.length > 80 ? `${first.slice(0, 77)}…` : first;
          // Loop guard: if this run already has an open question alert with the
          // same title in this conversation, don't spawn another — a model that
          // keeps calling ask_user after suspending shouldn't flood the tab.
          const dup = listAlerts(appHome, true).find(
            (a) => a.kind === 'question' && a.conversationId === context.conversationId && a.title === title,
          );
          if (dup) {
            return {
              suspended: true,
              alertId: dup.id,
              note: 'An alert with this question is already open and awaiting the user. End your turn.',
            };
          }
          const alert = createAlert(appHome, {
            kind: 'question',
            title,
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
        // Interactive turn with no stashed answer: normally unreachable (the gate
        // in agent.ts skips execution on dismiss), so if we get here the answer
        // was lost to a race — trace it so the next occurrence is diagnosable.
        traceDiagnostic({
          scope: 'agent',
          event: 'question.answers-missing-at-execute',
          level: 'warn',
          conversationId: context.conversationId,
          toolName: 'ask_user',
          fields: {
            toolCallId: context.toolCallId,
            isHeadless: Boolean(context.isHeadless),
            hasConversationId: Boolean(context.conversationId),
          },
        });
        return { error: ASK_USER_NO_ANSWER_ERROR };
      }

      return {
        success: true,
        answers,
      };
    },
  };
}

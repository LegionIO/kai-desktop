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
 * In-flight ledger for answers CONSUMED by ask_user.execute but not yet committed
 * as a tool-result on the branch. execute() moves the answer here (instead of hard-
 * deleting) so that if the turn is superseded/aborted during the window between
 * execute returning and the tool-result being emitted (e.g. a slow PostToolUse hook
 * awaiting), the answer is NOT lost — a non-terminal abort recovers it and a genuine
 * commit clears it. Keyed by toolCallId; each entry is stamped with the OWNING run's
 * stream token so drain/drop is TOKEN-scoped: a superseded predecessor's cleanup
 * recovers/drops ITS OWN entries (not a later unrelated run's), and an explicit Stop
 * drops exactly the stopped token's entries — so a stale answer can't be resurrected
 * by, or attributed to, a different run (R100 finding-7 / R101 finding-2). Bounded.
 */
const inFlightAnswers = new Map<
  string,
  { conversationId?: string; owningToken?: string; answers: Record<string, string> }
>();
const MAX_IN_FLIGHT_ANSWERS = 100;

/** Move a consumed answer into the in-flight ledger (execute path). Removes it from
 *  pendingQuestionAnswers so a duplicate consume can't re-read it, but keeps it
 *  recoverable (under its owning token) until the tool-result commits. */
export function moveAnswerToInFlight(
  toolCallId: string,
  answers: Record<string, string>,
  conversationId?: string,
  owningToken?: string,
): void {
  inFlightAnswers.set(toolCallId, { conversationId, owningToken, answers });
  while (inFlightAnswers.size > MAX_IN_FLIGHT_ANSWERS) {
    const oldest = inFlightAnswers.keys().next().value;
    if (oldest === undefined) break;
    inFlightAnswers.delete(oldest);
  }
}

/** Clear an in-flight answer once its tool-result is committed/emitted (agent.ts's
 *  tool-result handler) — the answer is now on the branch, no recovery needed. */
export function clearInFlightAnswer(toolCallId: string): void {
  inFlightAnswers.delete(toolCallId);
}

/** Drain (and remove) the in-flight answers owned by a specific stream token — used
 *  by that run's cleanup on a NON-terminal abort to recover answers whose tool-result
 *  never committed. Token-scoped so a superseded predecessor recovers only ITS OWN
 *  entries, never a later run's (R101 finding-2). Entries with no owning token match
 *  only the `undefined` token (legacy / non-token callers). */
export function drainInFlightAnswersForToken(
  token: string | undefined,
): Array<{ toolCallId: string; answers: Record<string, string> }> {
  const out: Array<{ toolCallId: string; answers: Record<string, string> }> = [];
  for (const [toolCallId, entry] of inFlightAnswers) {
    if (entry.owningToken === token) out.push({ toolCallId, answers: entry.answers });
  }
  for (const { toolCallId } of out) inFlightAnswers.delete(toolCallId);
  return out;
}

/** Drop (discard, no recovery) the in-flight answers owned by a stream token — used
 *  on an explicit terminal Stop of that token, so a stopped answer is neither
 *  resurrected nor mis-attributed to a later run (R101 finding-2). */
export function dropInFlightAnswersForToken(token: string | undefined): void {
  for (const [toolCallId, entry] of [...inFlightAnswers]) {
    if (entry.owningToken === token) inFlightAnswers.delete(toolCallId);
  }
}

/** Drain ALL in-flight answers (test cleanup only). */
export function drainInFlightAnswers(
  conversationId?: string,
): Array<{ toolCallId: string; answers: Record<string, string> }> {
  const out: Array<{ toolCallId: string; answers: Record<string, string> }> = [];
  for (const [toolCallId, entry] of inFlightAnswers) {
    if (conversationId === undefined || entry.conversationId === conversationId) {
      out.push({ toolCallId, answers: entry.answers });
    }
  }
  for (const { toolCallId } of out) inFlightAnswers.delete(toolCallId);
  return out;
}

/**
 * Deliver an already-collected raced answer that its run finished before consuming
 * (ordinary completion with an in-flight delivery + no genuine successor — the
 * misdelivery-vs-orphan case). Wired by the alerts layer (initializeAlerts →
 * setRecoveredAnswerDeliverer). Delivers the answer to the ORIGINATING conversation
 * as a labeled new user turn (or, on
 * failure, raises a persistent Alert). Returns whether it was delivered inline.
 * `null` deliverer (not yet wired / no alerts) → caller keeps the stash copy.
 */
export type RecoveredAnswerDeliverer = (
  conversationId: string,
  questionTitle: string,
  answers: Record<string, string>,
) => Promise<{ delivered: boolean }>;

let recoveredAnswerDeliverer: RecoveredAnswerDeliverer | null = null;

/** Wire the recovered-answer delivery path (called once from initializeAlerts). */
export function setRecoveredAnswerDeliverer(fn: RecoveredAnswerDeliverer | null): void {
  recoveredAnswerDeliverer = fn;
}

/** The wired recovered-answer deliverer, or null when the alerts layer isn't up. */
export function getRecoveredAnswerDeliverer(): RecoveredAnswerDeliverer | null {
  return recoveredAnswerDeliverer;
}

/**
 * Router a non-Mastra runtime (Claude Agent SDK ask_user handler) calls when abort
 * settles an ask_user before its answer is consumed, so the answer takes the SAME
 * durable recovered-answer path the Mastra drop-sites use (inline labeled re-inject
 * for an already-arrived answer, else a TTL-bound tombstone so a LATE answer is
 * routed by agent:answer-tool-question). Wired by agent.ts (setAskUserRecoveryRouter)
 * to keep the runtime layer free of the ipc/agent import graph — mirrors
 * setRecoveredAnswerDeliverer. `null` router (not yet wired) → the caller keeps the
 * bounded stash copy as the last resort (prior behavior). R93.
 */
export type AskUserRecoveryRouter = (conversationId: string, answerKey: string, streamToken?: string) => void;

let askUserRecoveryRouter: AskUserRecoveryRouter | null = null;

/** Wire the raced/aborted ask_user recovery router (called once from agent.ts). */
export function setAskUserRecoveryRouter(fn: AskUserRecoveryRouter | null): void {
  askUserRecoveryRouter = fn;
}

/** The wired ask_user recovery router, or null when agent.ts hasn't wired it. */
export function getAskUserRecoveryRouter(): AskUserRecoveryRouter | null {
  return askUserRecoveryRouter;
}

/** Accessor a non-Mastra runtime uses to capture the CURRENT active stream token
 *  for a conversation while its stream is live, so an abort-driven recovery can
 *  classify the abort as terminal (Stop / dismiss) vs. recoverable supersession
 *  (R95). Wired by agent.ts (setActiveStreamTokenAccessor → getActiveStreamToken).
 *  `null` accessor → the caller passes no token and recovery is unconditional
 *  (prior behavior). */
export type ActiveStreamTokenAccessor = (conversationId: string) => string | undefined;

let activeStreamTokenAccessor: ActiveStreamTokenAccessor | null = null;

/** Wire the active-stream-token accessor (called once from agent.ts). */
export function setActiveStreamTokenAccessor(fn: ActiveStreamTokenAccessor | null): void {
  activeStreamTokenAccessor = fn;
}

/** The current active stream token for a conversation, or undefined (idle / not wired). */
export function getActiveStreamTokenForConversation(conversationId: string): string | undefined {
  return activeStreamTokenAccessor?.(conversationId);
}

/**
 * Seam for the Claude-SDK runtime to hand a plan-mode DISMISS back to MAIN.
 *
 * The SDK's `exit_plan_mode` MCP tool runs inside the query worker. On APPROVE
 * it already routes through the tool's own `execute`, which persists+broadcasts
 * `auto` via the MAIN executionMode persister (see the SETTLED DECISION on
 * MAIN-authoritative executionMode) and lets the query proceed to execute the
 * plan. But a DISMISS ("exit plan mode without accepting a plan") only returns
 * an MCP error — it never leaves plan mode and never stops the query.
 *
 * This seam closes that: on dismiss MAIN persists+broadcasts `auto`, marks the
 * turn terminal so a late raced answer/inject can't resurrect the planning turn,
 * and aborts the still-running SDK query (there is no plan to execute, so the
 * turn is done). Wired by agent.ts (setPlanModeDismissHandler).
 */
export type PlanModeDismissHandler = (conversationId: string, streamToken?: string) => void;

let planModeDismissHandler: PlanModeDismissHandler | null = null;

export function setPlanModeDismissHandler(fn: PlanModeDismissHandler | null): void {
  planModeDismissHandler = fn;
}

export function getPlanModeDismissHandler(): PlanModeDismissHandler | null {
  return planModeDismissHandler;
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

/**
 * Move a recovered raced answer from the stream-side id to the execute-side id
 * so the tool's execute() (which reads `context.toolCallId`, the exec id) finds
 * it. Critically a NO-OP when the two ids are equal: for ask_user, pairing is by
 * id-identity so `streamId === execToolCallId`, meaning the answer is ALREADY
 * under the key execute() reads — a naive copy-then-delete would delete the very
 * entry it just wrote and lose the answer. Only re-key + delete when the ids
 * genuinely differ.
 */
export function rekeyRacedAnswer(
  streamToolCallId: string,
  execToolCallId: string,
  answers: Record<string, string>,
): void {
  if (streamToolCallId === execToolCallId) return;
  stashQuestionAnswers(execToolCallId, answers);
  pendingQuestionAnswers.delete(streamToolCallId);
}

/**
 * Format a recovered ask_user answer (keyed by question text, as the renderer
 * submits it) into a user-turn message for re-injection when the original turn
 * aborted before it could consume the answer. Mirrors the alerts.ts
 * `formatAnswer` style ("- question → choice") so the model reads it as the
 * user answering the question it asked.
 */
export function formatRacedAnswerAsUserTurn(answers: Record<string, string>): string {
  const entries = Object.entries(answers ?? {});
  const lines = entries.length
    ? entries.map(([question, choice]) => `- ${question} → ${choice}`)
    : ['(no answer provided)'];
  return `[Answering your question]\n${lines.join('\n')}`;
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
      // By the time execute runs, agent.ts has already stored the user's answers.
      // Move (don't hard-delete) into the in-flight ledger so the answer survives a
      // supersession/abort during the window before the tool-result commits (e.g. a
      // slow PostToolUse hook). agent.ts clears it on tool-result emit and recovers
      // it on a non-terminal abort (R100 finding-7).
      const answers = pendingQuestionAnswers.get(context.toolCallId);
      pendingQuestionAnswers.delete(context.toolCallId);
      if (answers)
        moveAnswerToInFlight(
          context.toolCallId,
          answers,
          context.conversationId,
          // Stamp the OWNING run's token so drain/drop is token-scoped (R101 f-2).
          // execute runs INSIDE the live run, so the current active token is ours.
          context.conversationId ? getActiveStreamTokenForConversation(context.conversationId) : undefined,
        );

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

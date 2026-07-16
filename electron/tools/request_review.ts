import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { createAlert, type AlertQuestion } from '../ipc/alert-store.js';
import { notifyAlertCreated } from '../ipc/alert-notify.js';

/**
 * `request_review` — lets an agent (especially a headless AUTOMATION run) raise a
 * persistent Alert for the user instead of blocking on `ask_user` (which hangs
 * when nobody is watching). Three kinds:
 *   - `fyi`      → "flagging this for you" — informational; the run CONTINUES.
 *   - `question` → ask multiple-choice question(s); the run should WIND DOWN and
 *                  resume later when the user answers (answer re-injects as a new
 *                  turn into this conversation).
 *   - `approval` → ask permission for an action; resumes on approve/deny.
 *
 * The alert is persisted (alert-store) and surfaced via OS notification + the
 * Alerts tab by the IPC layer. `execute` returns a `suspend` flag so the run
 * loop can end cleanly for question/approval (there's no synchronous answer).
 */

const optionSchema = z.object({
  label: z.string().describe('Short display text for the option (1-5 words)'),
  description: z.string().optional().describe('What this option means'),
});

const questionSchema = z.object({
  question: z.string().describe('The full question to ask. Clear, specific, ends with a question mark.'),
  header: z.string().max(40).describe('Short label for the option tab (max 40 chars)'),
  options: z.array(optionSchema).min(2).max(6).describe('2-6 distinct choices (no "Other" — the UI adds one)'),
  multiSelect: z.boolean().optional().default(false).describe('Allow multiple selections'),
});

export function createRequestReviewTool(appHome: string): ToolDefinition {
  return {
    name: 'request_review',
    description: [
      'Flag something for the user to review, or ask them a question, WITHOUT blocking — use this instead of ask_user when running autonomously (e.g. an automation) where no one is watching to answer immediately.',
      'kind="fyi": leave an informational flag ("flagging this for you") and KEEP GOING.',
      'kind="question": ask multiple-choice question(s); END YOUR TURN afterward — the user will answer later and their answer is fed back to you as a new message to continue from.',
      'kind="approval": ask permission for a specific action; END YOUR TURN — you resume on their approve/deny.',
      'The alert is persisted, notifies the user, and appears in the Alerts tab. For question/approval you will NOT get an answer in this turn.',
    ].join(' '),
    inputSchema: z.object({
      kind: z.enum(['fyi', 'question', 'approval']).describe('fyi (non-blocking flag), question, or approval'),
      title: z.string().describe('Short title for the alert (shown in the notification + list)'),
      message: z.string().describe('The details: what you want reviewed / why you are asking'),
      questions: z
        .array(questionSchema)
        .min(1)
        .max(4)
        .optional()
        .describe('For kind="question": the multiple-choice question(s) to ask (1-4)'),
      approvalAction: z
        .string()
        .optional()
        .describe('For kind="approval": a short description of the action to approve/deny'),
      awaitAck: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'For kind="fyi" only: if true, the FYI stays OPEN in the Alerts tab until the user acknowledges/dismisses it (nags with a badge). Default false — an FYI is informational and auto-acknowledged (shown as a notification + in Alerts history, no action needed). Ignored for question/approval (always awaited).',
        ),
    }),
    execute: async (input, context) => {
      const { kind, title, message, questions, approvalAction, awaitAck } = input as {
        kind: 'fyi' | 'question' | 'approval';
        title: string;
        message: string;
        questions?: AlertQuestion[];
        approvalAction?: string;
        awaitAck?: boolean;
      };
      const conversationId = context.conversationId;
      if (!conversationId) {
        return { error: 'request_review requires a conversation context', isError: true };
      }
      if (kind === 'question' && (!questions || questions.length === 0)) {
        return { error: 'kind="question" requires at least one question', isError: true };
      }

      // An FYI that doesn't await an ack is created already-acknowledged: it shows
      // as a notification + in Alerts history but never sits 'open' (no badge, no
      // dismissal needed). question/approval are always 'open' (awaited).
      const fyiAutoAck = kind === 'fyi' && !awaitAck;
      const alert = createAlert(appHome, {
        kind,
        title,
        body: message,
        conversationId,
        ...(kind === 'question' && questions ? { questions } : {}),
        ...(kind === 'approval' && approvalAction ? { approvalAction } : {}),
        ...(fyiAutoAck ? { status: 'acknowledged' as const } : {}),
      });
      // Fire the OS notification + UI broadcast (no-op in tests / before the
      // alerts IPC layer has registered its handler).
      notifyAlertCreated(alert);

      // fyi is non-blocking: the run continues. question/approval have no
      // synchronous answer — signal the run to wind down (suspended pending user).
      const suspend = kind !== 'fyi';
      return {
        alerted: true,
        alertId: alert.id,
        kind,
        suspend,
        note:
          kind === 'fyi'
            ? 'Flagged for the user; continuing.'
            : 'Alert raised — end your turn now. The user will respond and their answer will come back to you as a new message.',
      };
    },
  };
}

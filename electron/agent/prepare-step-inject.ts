/**
 * Cooperative mid-turn injection for the Mastra runtime, via the AI SDK /
 * Mastra `prepareStep` hook.
 *
 * `prepareStep` runs before EACH step of a multi-step tool-use turn and may
 * return a `messages` override for that step. We use it to drain the
 * per-conversation inject queue (inject-queue.ts) at the step boundary and
 * append any queued user message(s) to the step's messages — so a follow-up
 * that arrived mid-turn is spliced into the SAME turn's context, with no abort,
 * and the model continues seeing it. When the queue is empty we return `{}` (no
 * override), so a conversation with no injects behaves exactly as before.
 *
 * See @mastra/core ToolLoopAgentProcessor.handlePrepareStep: it calls
 * settings.prepareStep({messages, steps, stepNumber}) and applies the result's
 * messages. Messages here are in Mastra's model-message shape; a queued inject
 * is appended as a plain `{ role:'user', content:text }`, which Mastra maps.
 */

import { drainInjects, type QueuedInject } from './inject-queue.js';

type ModelMessageLike = { role: string; content: unknown };

type PrepareStepArgs = {
  messages: ModelMessageLike[];
  steps?: unknown[];
  stepNumber?: number;
};

type PrepareStepResult = {
  messages?: ModelMessageLike[];
};

/** Main-process persistence hook for cooperative injects. Set by ipc/agent.ts.
 * Invoked at the ACTUAL prepareStep consumption boundary — after the prior
 * tool-step results have arrived — so rotating the persistence accumulator here
 * cannot strand an unresolved tool call. */
type InjectConsumedHandler = (conversationId: string, entries: QueuedInject[]) => void;
let injectConsumedHandler: InjectConsumedHandler | null = null;

export function setInjectConsumedHandler(handler: InjectConsumedHandler | null): void {
  injectConsumedHandler = handler;
}

/**
 * Build the prepareStep function for a conversation's Mastra turn. Returns
 * undefined-safe results: an empty object when nothing is queued, otherwise a
 * `messages` override with the queued user turn(s) appended in FIFO order.
 *
 * `onInjected` (optional) is invoked with the drained texts so the caller can
 * record that the injects were consumed by this turn (e.g. for the drain-at-end
 * fallback bookkeeping / logging). It must not throw.
 */
export function buildMastraPrepareStep(
  conversationId: string,
  onInjected?: (texts: string[]) => void,
  onInjectedEntries?: (entries: QueuedInject[]) => void,
): (args: PrepareStepArgs) => PrepareStepResult {
  return ({ messages }: PrepareStepArgs): PrepareStepResult => {
    const queued = drainInjects(conversationId);
    if (queued.length === 0) return {};
    const appended: ModelMessageLike[] = [...messages, ...queued.map((q) => ({ role: 'user', content: q.text }))];
    if (injectConsumedHandler) {
      try {
        injectConsumedHandler(conversationId, queued);
      } catch {
        // Persistence/display bookkeeping only — never break model stepping.
      }
    }
    if (onInjected) {
      try {
        onInjected(queued.map((q) => q.text));
      } catch {
        // bookkeeping only — never break the step
      }
    }
    if (onInjectedEntries) {
      try {
        onInjectedEntries(queued);
      } catch {
        // persistence bookkeeping only — never break the step
      }
    }
    return { messages: appended };
  };
}

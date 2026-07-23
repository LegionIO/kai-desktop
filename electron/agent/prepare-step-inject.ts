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
 * In-band marker queue: entries consumed by prepareStep for a conversation that
 * the fullStream wrapper has NOT yet surfaced as an in-order `inject-consumed`
 * stream event. Because prepareStep is a side-channel callback that races the
 * fullStream consumer, this lets the wrapper emit an ordered marker right before
 * the next step's chunks, so downstream persistence splits the branch at the
 * exact, race-free point (after the prior step's events, before the next).
 */
type ConsumedMarker = { entries: QueuedInject[]; stepNumber: number };
const injectConsumedMarkers = new Map<string, ConsumedMarker[]>();

/** Drain markers whose prior step (stepNumber) has been fully CONSUMED — i.e.
 * the caller has processed step events up to `consumedSteps`. prepareStep for
 * step N (0-based) runs AFTER step N-1's events, so a marker recorded at
 * stepNumber N is safe to emit once `consumedSteps >= N` (all of step N-1's
 * chunks, incl. its tool-result, are in the accumulator). Returns ready markers
 * as SEPARATE per-boundary batches (in step order) — the caller emits one
 * `inject-consumed` event per batch so each boundary commits at its own stream
 * position. Removes only the drained markers. */
export function drainInjectConsumedMarkers(conversationId: string, consumedSteps: number): QueuedInject[][] {
  const markers = injectConsumedMarkers.get(conversationId);
  if (!markers || markers.length === 0) return [];
  const ready: QueuedInject[][] = [];
  const remaining: ConsumedMarker[] = [];
  for (const m of markers) {
    if (m.stepNumber <= consumedSteps) ready.push(m.entries);
    else remaining.push(m);
  }
  if (remaining.length > 0) injectConsumedMarkers.set(conversationId, remaining);
  else injectConsumedMarkers.delete(conversationId);
  return ready;
}

/** Discard any pending in-band markers for a conversation (call at stream
 * start/end so a path that records but never drains — e.g. the synthetic-events
 * reasoning-gateway path, or a stream that ends before the next chunk — can't
 * leak user text or emit a stale marker on a later stream). */
export function clearInjectConsumedMarkers(conversationId: string): void {
  injectConsumedMarkers.delete(conversationId);
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
  return ({ messages, stepNumber }: PrepareStepArgs): PrepareStepResult => {
    const queued = drainInjects(conversationId);
    if (queued.length === 0) return {};
    const appended: ModelMessageLike[] = [...messages, ...queued.map((q) => ({ role: 'user', content: q.text }))];
    // Record an in-band marker TAGGED with this step number. prepareStep for step
    // N runs after step N-1's events, so the wrapper emits the marker only once it
    // has consumed step N-1 (all its chunks incl. tool-result) — a race-free split
    // even when the upstream pipeline buffers ahead.
    const stepNo = typeof stepNumber === 'number' ? stepNumber : Number.MAX_SAFE_INTEGER;
    const existing = injectConsumedMarkers.get(conversationId);
    if (existing) existing.push({ entries: [...queued], stepNumber: stepNo });
    else injectConsumedMarkers.set(conversationId, [{ entries: [...queued], stepNumber: stepNo }]);
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

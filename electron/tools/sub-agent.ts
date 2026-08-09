/**
 * Sub-Agent Tool
 *
 * Allows the parent agent to spawn a child agent that has access to the same tools
 * (including recursive sub-agents up to the configured depth limit).
 * Sub-agent conversations can be resumed after completion.
 */

import { z } from 'zod';
import { join } from 'path';
import { BrowserWindow } from 'electron';
import { broadcastToWebClients } from '../web-server/web-clients.js';
import {
  runSubAgent,
  getActiveSubAgentCount,
  reserveSubAgentSlot,
  releaseSubAgentSlot,
} from '../agent/sub-agent-runner.js';
import type { SubAgentEvent } from '../agent/sub-agent-runner.js';
import type { LLMModelConfig, ResolvedStreamConfig } from '../agent/model-catalog.js';
import { resolveModelForThread, resolveStreamConfig } from '../agent/model-catalog.js';
import type { AppConfig } from '../config/schema.js';
import type { ToolDefinition, ToolExecutionContext } from './types.js';
import { getSharedMemory } from '../agent/memory.js';
import { updateSubagentStatus } from '../agent/subagent-status.js';
import { traceDiagnostic } from '../diagnostics/debug-trace.js';

/** Follow-up message queues keyed by subAgentConversationId */
const followUpQueues = new Map<string, string[]>();
/**
 * Ordered messages awaiting hand-off to a resume, set SYNCHRONOUSLY at terminal
 * close (before resumable state becomes visible) so a message that arrives in
 * the gap is APPENDED here in order rather than starting its own out-of-order
 * resume. `sendSubAgentFollowUp` checks this before starting a fresh resume; the
 * deferred transfer drains it (in order) into a single resume.
 */
const pendingResumeQueues = new Map<string, string[]>();
/** Active sub-agent abort controllers keyed by subAgentConversationId */
const activeSubAgentControllers = new Map<string, AbortController>();
/**
 * Conversations whose finalizeSubAgentRun is IN FLIGHT (its terminal DB write is
 * still awaiting I/O). A DIFFERENT run's drain must NOT start a resume for such a
 * conversation — its own finalize (step 5) starts the resume once the terminal
 * write lands, so the terminal write can't race the resume's reopen write. Its
 * own step-5 drain runs after this set is cleared.
 */
const finalizingSubAgents = new Set<string>();
/**
 * Monotonic run-generation per subAgentConversationId. Each run/resume that
 * takes over a conversation bumps this and captures its own generation. Cleanup
 * and resumable-state deletion check "am I still the current generation?" —
 * robust ownership that (unlike controller-identity/presence) is correct even
 * when a successor resume has already started AND finished (removing its
 * controller) while an older run is still tearing down.
 */
const subAgentRunGeneration = new Map<string, number>();
// Bound the generation map: it grows one entry per unique sub-agent id over the process
// lifetime. Map preserves insertion order → re-insert on bump (recency) + evict the oldest
// over the cap. Never evict an id whose child is STILL LIVE (active controller, retained
// resumable state, or a pending-resume queue) — evicting a live generation would make its
// finalization's isCurrent() read undefined → rejected as stale → queued follow-ups
// discarded + status stuck `running`. Scan past live ids to the oldest DEAD one.
const SUBAGENT_RUN_GENERATION_MAX = 5000;
function isSubAgentGenerationEvictable(id: string): boolean {
  return (
    !activeSubAgentControllers.has(id) &&
    !subAgentState.has(id) &&
    !pendingResumeQueues.has(id) &&
    !followUpQueues.has(id)
  );
}
function nextRunGeneration(subAgentConversationId: string): number {
  const gen = (subAgentRunGeneration.get(subAgentConversationId) ?? 0) + 1;
  subAgentRunGeneration.delete(subAgentConversationId); // re-insert at the back (recency)
  subAgentRunGeneration.set(subAgentConversationId, gen);
  if (subAgentRunGeneration.size > SUBAGENT_RUN_GENERATION_MAX) {
    // Evict the oldest DEAD entries (skip still-live ids). Bounded scan; if every entry is
    // live (pathological — thousands of concurrent children), leave the map as-is.
    let removed = 0;
    for (const key of subAgentRunGeneration.keys()) {
      if (subAgentRunGeneration.size - removed <= SUBAGENT_RUN_GENERATION_MAX) break;
      if (key === subAgentConversationId) continue; // never evict the one we just bumped
      if (isSubAgentGenerationEvictable(key)) {
        subAgentRunGeneration.delete(key);
        removed++;
      }
    }
  }
  return gen;
}
/** Map parent toolCallId → subAgentConversationId for observer lookups */
const toolCallToSubAgent = new Map<string, string>();
/** Parent conversation id per ACTIVE sub-agent — used to enforce maxPerParent. */
const activeSubAgentParents = new Map<string, string>();
/** Persisted sub-agent conversation state for resumption */
const subAgentState = new Map<
  string,
  {
    messages: Array<{ role: string; content: unknown }>;
    config: AppConfig;
    modelConfig: LLMModelConfig;
    streamConfig?: ResolvedStreamConfig;
    profileKey?: string | null;
    modelKey?: string | null;
    tools: ToolDefinition[];
    dbPath: string;
    parentConversationId: string;
    parentToolCallId: string;
    /** The PARENT's conversation id (ctx.conversationId) — the maxPerParent
     *  admission key. Distinct from parentConversationId (a tool-call id used
     *  for event routing). Absent for legacy state → resume skips the per-parent
     *  bucket rather than registering under the wrong key. */
    parentThreadId?: string | null;
    depth: number;
    task: string;
    /** The run's FINAL (gated) system prompt — persisted so a resume reuses the
     *  same guardrail a UserPromptSubmit hook applied, instead of rebuilding an
     *  ungated prompt from config. Absent for legacy state → resume rebuilds. */
    systemPrompt?: string;
  }
>();

/**
 * Live-config accessor, registered by createSubAgentTool. Admission checks
 * (concurrency + per-parent caps) MUST read the CURRENT config, not the config
 * captured in a sub-agent's resumable state at its original completion — so a
 * later change to maxConcurrent/maxPerParent is honored on resume (a lowered cap
 * is enforced; a raised cap stops leaving follow-ups needlessly queued). Falls
 * back to a per-call config when unset (e.g. unit tests that never create a tool).
 */
let liveConfigProvider: (() => AppConfig) | null = null;

/** Current sub-agent config for admission, preferring the live provider over the
 *  (possibly stale) config captured in resumable state. */
function currentConfigFor(fallback: AppConfig): AppConfig {
  return liveConfigProvider ? liveConfigProvider() : fallback;
}

function broadcastEvent(event: SubAgentEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:stream-event', event);
  }
  broadcastToWebClients('agent:stream-event', event);
}

/** Classified terminal outcome shared by the initial-run and resume paths. */
type SubAgentTerminalOutcome = {
  aborted: boolean;
  failed: boolean;
  paused: boolean;
  failureSummary: string | null;
  /** WHY it paused (when `paused`): the agent requested input, exhausted its turn
   *  budget, or was deferred by a capacity cap. Drives an accurate persisted
   *  exitReason instead of always claiming it awaited input. */
  pausedReason?: 'awaiting-input' | 'turn-limit' | 'capacity';
};

/**
 * SHARED terminal finalization for BOTH the initial run and a resume, so the two
 * paths can never diverge (the source of the resume/runner lifecycle bugs).
 * Handles, in order:
 *  1. Atomic queue close — detach the follow-up queue synchronously and capture
 *     anything queued at close (so a concurrent send can't be accepted into a
 *     doomed queue).
 *  2. Resumable-state persistence — set `subAgentState` iff the run is resumable
 *     (not failed, not aborted); the caller supplies the built state object.
 *  3. DB status write — completed/failed/stopped as a real transition; a paused
 *     run writes NO status (stays 'running', FSM-legal) with a paused exitReason.
 *  4. Follow-up transfer — hand any messages queued at close to the resume path
 *     (only for a resumable, non-aborted outcome), deferred one macrotask.
 * Transport (ctx.onProgress vs broadcast) and the tool-result return stay at each
 * call site; only the identical bookkeeping is centralized here.
 */
async function finalizeSubAgentRun(opts: {
  subAgentConversationId: string;
  outcome: SubAgentTerminalOutcome;
  /** Resumable-state object to persist, or null when this run is not resumable. */
  resumableState: NonNullable<ReturnType<typeof subAgentState.get>> | null;
  /** When true (a RESUME), a failed outcome does NOT delete the prior resumable
   *  snapshot — the earlier history is still valid, and a denied/failed NEW
   *  follow-up shouldn't make the whole conversation un-resumable. Also writes the
   *  DB status as `paused` (resumable) rather than terminal `failed`. */
  preservePriorStateOnFailure?: boolean;
  /** When true (an INITIAL run), a failed outcome still PERSISTS the fresh gated
   *  resumable state (if provided) and seeds the handoff — so a follow-up accepted
   *  during the failing turn survives and a "retry" can reference the failed
   *  request — but the DB status stays terminal `failed` (the run genuinely
   *  failed; the card reads as an error, not paused). */
  persistFreshStateOnFailure?: boolean;
  /** The finalizing run's generation token. Every shared-state mutation below is
   *  gated on THIS run still being the current generation — so an older run that
   *  reaches finalization AFTER a successor resume has already taken over (bumping
   *  the generation during this function's awaited DB write) cannot clobber the
   *  successor's resumable state, pending queue, or DB status. */
  ownerGeneration: number;
  dbPath: string;
  config: AppConfig;
  /** Parent routing for user-visible broadcasts (e.g. surfacing stranded follow-ups on a
   *  non-resumable finalize). Optional — omitted callers just skip that broadcast. */
  routing?: { parentConversationId: string; parentToolCallId: string };
}): Promise<void> {
  const { subAgentConversationId, outcome, resumableState, ownerGeneration, dbPath, config } = opts;
  const isCurrent = (): boolean => subAgentRunGeneration.get(subAgentConversationId) === ownerGeneration;

  // If a successor generation has already taken over (e.g. a fast resume started
  // and bumped the generation before this older run reached finalization), this
  // run owns NOTHING: the successor is authoritative for queues, resumable state,
  // and DB status. Bail out entirely rather than clobber it.
  if (!isCurrent()) return;

  // Mark this conversation as finalizing for the duration of the terminal DB
  // write, so ANOTHER run's drainAdmissiblePendingResumes can't start this
  // conversation's resume mid-write (which would race the terminal write against
  // the resume's reopen write). This run's OWN step-5 drain starts the resume
  // once the write has landed and this flag is cleared.
  finalizingSubAgents.add(subAgentConversationId);

  // 1. Atomic queue close.
  const queuedAtClose = followUpQueues.get(subAgentConversationId);
  const strandedFollowUps = queuedAtClose ? [...queuedAtClose] : [];
  followUpQueues.delete(subAgentConversationId);

  const resumable = !outcome.failed && !outcome.aborted && resumableState !== null;
  // A failed run that supplied a fresh GATED snapshot persists the newer snapshot
  // (see step 2) — for BOTH a resume (preservePriorStateOnFailure) and an initial
  // run (persistFreshStateOnFailure). The gated history (user turn + explanation)
  // is what a later "retry" needs and keeps accepted follow-ups deliverable.
  const persistsStateOnFailure = Boolean(opts.preservePriorStateOnFailure) || Boolean(opts.persistFreshStateOnFailure);
  const failurePreservedFreshState =
    outcome.failed && !outcome.aborted && persistsStateOnFailure && resumableState !== null;

  // 2. Resumable-state persistence — done BEFORE seeding the handoff so we can key
  //    the handoff decision on whether the conversation is ACTUALLY resumable
  //    after finalization (i.e. subAgentState has an entry), not on a proxy.
  if (outcome.aborted) {
    // ABORT is a definitive stop: synchronously drop any prior/fresh resumable
    // snapshot so the conversation is NOT resumable. Otherwise a stale pre-resume
    // snapshot would leave remainsResumable true, seed a handoff, and accept a
    // follow-up during the awaited DB write that the caller's finally then
    // discards — silently losing it. Non-resumable ⇒ no handoff seeded ⇒ a send
    // returns ok:false and the composer keeps the text.
    subAgentState.delete(subAgentConversationId);
  } else if (resumable || failurePreservedFreshState) {
    // Persist the fresh gated snapshot (normal completion/pause, or a failed
    // run whose gated history — user turn + explanation — a "retry" needs).
    subAgentState.set(subAgentConversationId, resumableState as NonNullable<typeof resumableState>);
  } else if (outcome.failed && !persistsStateOnFailure) {
    // FAILED (non-abort) with NO fresh state to persist: drop any prior resumable
    // snapshot so a later message can't resume from stale history that omits the
    // failed follow-up. (A preserved resume-failure with NO fresh snapshot falls
    // through and keeps its prior snapshot untouched.)
    subAgentState.delete(subAgentConversationId);
  }

  // The conversation is resumable after finalization iff resumable state remains
  // (freshly set above, OR a prior snapshot preserved on an early resume failure).
  const remainsResumable = subAgentState.has(subAgentConversationId);

  // 3. FIFO handoff seed — BEFORE the DB await, so there is NO window where state
  //    is resumable but the handoff queue isn't seeded (a message arriving then
  //    would start its own out-of-order resume). sendSubAgentFollowUp appends here
  //    first; the deferred drain starts ONE ordered resume. Seed even an EMPTY
  //    queue so concurrent sends append here. Seeded whenever the conversation
  //    remains resumable — including an early resume failure that kept the prior
  //    snapshot, so follow-ups accepted (ok:true) while it was pending survive.
  if (remainsResumable) {
    const pending = pendingResumeQueues.get(subAgentConversationId) ?? [];
    pending.push(...strandedFollowUps);
    pendingResumeQueues.set(subAgentConversationId, pending);
  } else if (strandedFollowUps.length > 0) {
    // NON-resumable finalize (e.g. an initial run whose prompt gate denied/threw before any
    // gated snapshot existed) with follow-ups that were accepted (ok:true, composer cleared)
    // during the run. There is no resumable conversation to deliver them to — but the input
    // was the user's, so do NOT drop it SILENTLY. Emit a user-visible note (routed to the
    // parent) listing the undelivered messages so the user can resubmit, plus the diagnostic.
    traceDiagnostic({
      scope: 'agent',
      event: 'sub-agent.stranded-followups-dropped',
      conversationId: subAgentConversationId,
      toolName: 'sub_agent',
      fields: {
        subAgentConversationId,
        count: strandedFollowUps.length,
        outcome: outcome.aborted ? 'aborted' : outcome.failed ? 'failed' : 'other',
      },
    });
    // A user STOP is deliberate — don't nag about discarded follow-ups. Only surface when the
    // run ended by gate-denial/failure (not abort) and we have routing to reach the parent.
    if (!outcome.aborted && opts.routing) {
      const preview = strandedFollowUps.map((m) => (m.length > 80 ? `${m.slice(0, 80)}…` : m)).join(' | ');
      broadcastEvent({
        subAgentConversationId,
        parentConversationId: opts.routing.parentConversationId,
        parentToolCallId: opts.routing.parentToolCallId,
        conversationId: subAgentConversationId,
        type: 'sub-agent-status',
        status: 'failed',
        summary: `Sub-agent ended before delivering ${strandedFollowUps.length} follow-up message(s) — please resend: ${preview}`,
      } as SubAgentEvent);
    }
  }

  // 4. DB status write. Re-check ownership AFTER the (awaited) reopen ordering:
  //    if a successor resume took over during this run's teardown, it owns the DB
  //    status now — an older write here would either overwrite the successor's
  //    `running` with a stale terminal status or hit an FSM-illegal transition.
  try {
    const memory = getSharedMemory(config, dbPath);
    if (memory && isCurrent()) {
      // `paused` is a first-class FSM state (running → paused is legal and
      // resumable). A RESUME failure that preserves prior state is written as
      // `paused` (resumable) rather than terminal `failed`, so the still-valid
      // prior history remains resumable (the user still sees the failure via the
      // broadcast the caller emitted).
      // `paused` is a first-class FSM state (running → paused is legal AND
      // paused → running is legal, so it can be reopened). A FAILED run that
      // REMAINS RESUMABLE (fresh gated state persisted, or a resume that kept its
      // prior snapshot) is written as `paused` — NOT terminal `failed` — for BOTH
      // the initial-run and resume paths. Writing `failed` there would strand the
      // conversation: `failed` is terminal in VALID_TRANSITIONS, so the retry's
      // `failed → running` reopen would be rejected and the thread stuck. The user
      // still SEES the failure via the caller's error broadcast + the tool-result
      // isError; the DB status only governs resumability. A failure with NO
      // resumable state (nothing to reopen) is written as terminal `failed`.
      const failedButResumable = outcome.failed && !outcome.aborted && remainsResumable;
      const terminalStatus = outcome.aborted
        ? ('stopped' as const)
        : failedButResumable
          ? ('paused' as const)
          : outcome.failed
            ? ('failed' as const)
            : outcome.paused
              ? ('paused' as const)
              : ('completed' as const);
      await updateSubagentStatus(memory, subAgentConversationId, {
        status: terminalStatus,
        completedAt: new Date().toISOString(),
        exitReason: outcome.aborted
          ? 'user_aborted'
          : failedButResumable
            ? (outcome.failureSummary || 'Sub-agent failed.').slice(0, 500)
            : outcome.failed
              ? (outcome.failureSummary || 'Sub-agent failed.').slice(0, 500)
              : outcome.paused
                ? // Record the ACTUAL pause cause, not a blanket "awaiting input".
                  outcome.pausedReason === 'turn-limit'
                  ? 'paused_turn_limit'
                  : outcome.pausedReason === 'capacity'
                    ? 'paused_capacity'
                    : 'paused_awaiting_input'
                : 'task_complete',
      });
    }
  } catch (err) {
    console.error('[Subagent] Failed to update completion status:', err);
  } finally {
    // Terminal DB write is done (or failed) — this conversation is no longer
    // mid-finalization, so drains may now start its resume.
    finalizingSubAgents.delete(subAgentConversationId);
  }

  // 5. Deferred drain: start ONE resume with the whole ordered pending list
  //    (seeded in step 3 + anything appended concurrently, in order). Runs after
  //    the caller's teardown; race-free via generation-aware cleanup. Scheduled
  //    whenever the conversation remains resumable, even if nothing was stranded
  //    at close — a message may have been appended to the seeded (empty) handoff
  //    queue since. The callback re-checks the generation so an older run's
  //    deferred drain can't touch a successor's queue.
  if (remainsResumable) {
    setImmediate(() => {
      if (!isCurrent()) return; // a successor took over — it owns the queue now
      const queued = pendingResumeQueues.get(subAgentConversationId);
      if (!queued || queued.length === 0) {
        pendingResumeQueues.delete(subAgentConversationId);
        return;
      }
      if (!subAgentState.has(subAgentConversationId)) {
        pendingResumeQueues.delete(subAgentConversationId);
        return;
      }
      // If a resume can't be admitted right now (caps full — e.g. concurrency was
      // lowered while several agents run), LEAVE the messages retained AND surface
      // a `paused`/`capacity` status. Without the status a terminal card would read
      // as completed while accepted work sits armed in pendingResumeQueues and runs
      // later when capacity frees — hiding deferred work behind "done". The user's
      // next send appends here; a later slot-release drain retries admission.
      if (!isResumeAdmissible(subAgentConversationId, config)) {
        const st = subAgentState.get(subAgentConversationId);
        broadcastEvent({
          subAgentConversationId,
          parentConversationId: st?.parentThreadId ?? subAgentConversationId,
          parentToolCallId: st?.parentToolCallId ?? subAgentConversationId,
          conversationId: subAgentConversationId,
          type: 'sub-agent-status',
          status: 'paused',
          summary: 'Paused — waiting for sub-agent capacity to free up.',
          pausedReason: 'capacity',
        } as SubAgentEvent);
        return;
      }
      pendingResumeQueues.delete(subAgentConversationId);
      // First message starts the resume; the rest go into its queue
      // (sendSubAgentFollowUp preserves order).
      for (const m of queued) sendSubAgentFollowUp(subAgentConversationId, m);
    });
  }
}

/** Whether a resume for this conversation would pass admission (concurrency +
 *  per-parent caps) right now. Used to avoid draining stranded follow-ups into a
 *  doomed resume that would soft-reject and risk losing them. Thin boolean view
 *  over resumeAdmissionBlockReason so the two can never diverge. */
function isResumeAdmissible(subAgentConversationId: string, config: AppConfig): boolean {
  return resumeAdmissionBlockReason(subAgentConversationId, config) === null;
}

/** The human-readable reason a resume can't be admitted right now (concurrency
 *  or per-parent cap), or null if it CAN be admitted. Mirrors isResumeAdmissible
 *  so the soft-rejection message is consistent everywhere a cap hit is handled.
 *  Reads the CURRENT config (via liveConfigProvider) rather than the passed
 *  `fallbackConfig` — so a resume/retry honors live cap changes instead of the
 *  caps captured when the sub-agent originally completed. */
function resumeAdmissionBlockReason(subAgentConversationId: string, fallbackConfig: AppConfig): string | null {
  const subCfg = currentConfigFor(fallbackConfig).tools?.subAgents;
  const maxConcurrent = subCfg?.maxConcurrent ?? 4;
  const maxPerParent = subCfg?.maxPerParent ?? 2;
  if (getActiveSubAgentCount() >= maxConcurrent) {
    return `Maximum concurrent sub-agents (${maxConcurrent}) reached; try resuming again shortly.`;
  }
  const parentThreadId = subAgentState.get(subAgentConversationId)?.parentThreadId;
  if (parentThreadId) {
    let activeForParent = 0;
    for (const [saId, p] of activeSubAgentParents) {
      if (p === parentThreadId && saId !== subAgentConversationId) activeForParent += 1;
    }
    if (activeForParent >= maxPerParent) {
      return `Maximum sub-agents per parent (${maxPerParent}) reached; try resuming again shortly.`;
    }
  }
  return null;
}

/**
 * SHARED soft-rejection for a cap hit: RETAIN the follow-up in pendingResumeQueues
 * (FIFO, never lost) AND emit `paused` (resumable, never `failed`). Centralizes
 * the two halves of the soft-rejection contract so every cap-hit site both keeps
 * the message and surfaces a paused status that prompts a retry once capacity
 * frees (a later drainAdmissiblePendingResumes / user resend re-attempts it).
 * The message is appended even when the emit fails, so retention is never skipped.
 */
function retainFollowUpAsPaused(
  subAgentConversationId: string,
  message: string,
  reason: string,
  routing: { parentConversationId: string; parentToolCallId: string },
): void {
  const q = pendingResumeQueues.get(subAgentConversationId) ?? [];
  q.push(message);
  pendingResumeQueues.set(subAgentConversationId, q);
  broadcastEvent({
    subAgentConversationId,
    parentConversationId: routing.parentConversationId,
    parentToolCallId: routing.parentToolCallId,
    conversationId: subAgentConversationId,
    type: 'sub-agent-status',
    status: 'paused',
    summary: reason,
    // This pause is a CAPACITY deferral (a cap was full), NOT an awaiting-input
    // pause. Set the reason explicitly so the card shows a generic "Paused" — the
    // renderer preserves the prior reason when this is absent, which would keep a
    // formerly awaiting-input card mislabeled after a follow-up was accepted.
    pausedReason: 'capacity',
  } as SubAgentEvent);
}

/**
 * Slot-release retry trigger. Called after a run finalizes (a concurrency slot
 * just freed) to drain any conversation whose retained follow-ups are now
 * admissible. This is the trigger that makes capacity-full RETENTION correct: a
 * message held because caps were full is processed once capacity frees, rather
 * than stranded. Drains conversations one at a time, re-checking admission
 * before each (so a single freed slot doesn't over-admit). Deferred a macrotask
 * so it runs after the releasing run's own teardown.
 */
function drainAdmissiblePendingResumes(skipId?: string): void {
  setImmediate(() => {
    for (const [saId, queued] of [...pendingResumeQueues]) {
      if (saId === skipId) continue; // caller asked to exclude this conversation (avoid re-driving its own failed reopen)
      if (!queued || queued.length === 0) {
        pendingResumeQueues.delete(saId);
        continue;
      }
      const state = subAgentState.get(saId);
      if (!state) {
        // No resumable state (e.g. it was consumed/failed) — drop the orphaned
        // retained messages; there's nothing to resume into.
        pendingResumeQueues.delete(saId);
        continue;
      }
      // Skip a conversation whose OWN finalize is still in flight (terminal DB
      // write awaiting I/O). Starting its resume now would race its terminal write
      // against the resume's reopen write. Its own step-5 drain starts the resume
      // once its write lands — leave the queue retained for that.
      if (finalizingSubAgents.has(saId)) continue;
      if (!isResumeAdmissible(saId, state.config)) continue; // still full — leave retained
      pendingResumeQueues.delete(saId);
      for (const m of queued) sendSubAgentFollowUp(saId, m);
    }
  });
}

/**
 * Correct lifecycle state when an abort is observed AFTER finalization. The three
 * run paths (initial success, initial catch, resume) all snapshot `aborted` before
 * finalizeSubAgentRun's awaited DB write; a stop landing during that write would
 * otherwise leave the run persisted/displayed as paused/completed while cleanup
 * silently drops its resumable state. This is called with the LIVE abort flag after
 * finalization: if the run is aborted AND still owned by this generation AND still
 * resumable (state/queue present — a failure kept as the FSM-resumable `paused`),
 * it purges the resumable state + pending queue and rewrites the status to
 * `stopped` (paused/completed → stopped is FSM-legal), broadcasting it to clients.
 * A non-resumable failure has nothing to cancel and is already terminal `failed`.
 * Returns true when a correction was applied.
 */
async function correctIfAbortedAfterFinalize(opts: {
  subAgentConversationId: string;
  aborted: boolean;
  ownerGeneration: number;
  config: AppConfig;
  dbPath: string;
  routing: { parentConversationId: string; parentToolCallId: string };
}): Promise<boolean> {
  const { subAgentConversationId, aborted, ownerGeneration, config, dbPath, routing } = opts;
  if (!aborted) return false;
  const stillCurrent = subAgentRunGeneration.get(subAgentConversationId) === ownerGeneration;
  const hadResumable =
    subAgentState.has(subAgentConversationId) || pendingResumeQueues.has(subAgentConversationId);
  if (!stillCurrent || !hadResumable) return false;
  subAgentState.delete(subAgentConversationId);
  pendingResumeQueues.delete(subAgentConversationId);
  try {
    const memory = getSharedMemory(config, dbPath);
    if (memory)
      await updateSubagentStatus(memory, subAgentConversationId, {
        status: 'stopped',
        completedAt: new Date().toISOString(),
        exitReason: 'user_aborted',
      });
  } catch (err) {
    console.error('[Subagent] Failed to record post-finalization stop:', err);
  }
  broadcastEvent({
    subAgentConversationId,
    parentConversationId: routing.parentConversationId,
    parentToolCallId: routing.parentToolCallId,
    conversationId: subAgentConversationId,
    type: 'sub-agent-status',
    status: 'stopped',
    summary: 'Stopped.',
  } as SubAgentEvent);
  return true;
}

/**
 * Re-attempt any retained pending resumes. Called when the sub-agent concurrency
 * caps CHANGE at runtime (e.g. the user raises maxConcurrent/maxPerParent) — a
 * message retained because a cap was full would otherwise never retry, since no
 * slot-release callback fires while the blocking run stays active. Idempotent and
 * cheap: it re-checks admission per conversation and only drains admissible ones.
 */
export function retryPendingSubAgentResumes(): void {
  drainAdmissiblePendingResumes();
}

/** Send a follow-up to a sub-agent by its parent toolCallId (for observer use) */
export function sendSubAgentFollowUpByToolCall(toolCallId: string, message: string): boolean {
  const saId = toolCallToSubAgent.get(toolCallId);
  if (!saId) return false;
  return sendSubAgentFollowUp(saId, message);
}

/** Send a follow-up message to a sub-agent (running, paused, or completed) */
export function sendSubAgentFollowUp(subAgentConversationId: string, message: string): boolean {
  // If a terminal-close hand-off is pending, APPEND here to preserve FIFO order
  // (the deferred drain will start a single resume with the whole ordered list).
  // Prevents a message arriving in the close→drain gap from starting its own
  // out-of-order resume ahead of already-stranded messages.
  // BUT if the run's controller is ABORTED, the abort cleanup (cleanupAbortedRun ~476,
  // or the non-resumable deferred drain) DELETES pendingResumeQueues — appending here
  // would return success yet lose the message after the caller cleared its input. Reject
  // on abort (keep composer text; resend once it settles). A NORMAL finalize is fine: its
  // handoff is drained, so accepting into `pending` is correct.
  const pending = pendingResumeQueues.get(subAgentConversationId);
  if (pending) {
    if (activeSubAgentControllers.get(subAgentConversationId)?.signal.aborted) {
      return false;
    }
    pending.push(message);
    // If NO run is currently active for this conversation, nothing will drain the pending
    // queue on its own (a resume-reopen failure retains messages here WITHOUT scheduling a
    // drain, to avoid auto-retry-looping a persistent DB failure). A fresh follow-up is an
    // EXPLICIT retry intent, so kick a deferred drain now — it re-attempts the reopen/resume
    // (and if the reopen fails again, retains without re-draining, so no tight loop).
    if (!activeSubAgentControllers.has(subAgentConversationId)) {
      queueMicrotask(() => drainAdmissiblePendingResumes());
    }
    return true;
  }

  // If running, push to the active queue — but ONLY if the run's controller is still live.
  // Between a Stop (controller.abort()) and the run's teardown (finalizeSubAgentRun, which
  // deletes the queue at line ~189 and drops resumable state at ~210), followUpQueues still
  // holds an entry; pushing here would return success yet the aborting run discards the
  // queue at finalization → the message is silently lost after the caller cleared its input.
  // When the controller is aborted (or the run is already finalizing), REJECT (return false)
  // so the caller keeps the composer text and can resend once the sub-agent settles to a
  // resumable state — matching finalizeSubAgentRun's abort contract (non-resumable ⇒ ok:false,
  // text retained). Do NOT fall through to resume here: subAgentState still holds the
  // about-to-be-deleted snapshot, so a resume would race the teardown.
  const queue = followUpQueues.get(subAgentConversationId);
  if (queue) {
    const controllerAborted = activeSubAgentControllers.get(subAgentConversationId)?.signal.aborted;
    if (controllerAborted || finalizingSubAgents.has(subAgentConversationId)) {
      return false;
    }
    queue.push(message);
    return true;
  }

  // Otherwise, if resumable state exists, resume the conversation — but only if
  // admission (concurrency/per-parent caps) currently allows it. If full, RETAIN
  // the message in pendingResumeQueues (not lost) rather than starting a resume
  // that would soft-reject; a later drain (when capacity frees) processes it.
  const state = subAgentState.get(subAgentConversationId);
  if (state) {
    const blockReason = resumeAdmissionBlockReason(subAgentConversationId, state.config);
    if (blockReason) {
      // Soft rejection: retain the message (FIFO) AND emit `paused` so the caller
      // sees a resumable status and a later drain/resend re-attempts admission.
      // Route to the parent CONVERSATION id (parentThreadId) so parent-scoped
      // consumers see the transition; keep the tool-call id for tool routing.
      retainFollowUpAsPaused(subAgentConversationId, message, blockReason, {
        parentConversationId: state.parentThreadId ?? subAgentConversationId,
        parentToolCallId: state.parentToolCallId,
      });
      return true;
    }
    resumeSubAgent(subAgentConversationId, message, state);
    return true;
  }

  return false;
}

/**
 * Resume a completed/paused sub-agent with a new message. Thin wrapper over the
 * SAME `runSubAgent` engine + shared `finalizeSubAgentRun` used by the initial
 * run, so the resume and initial paths cannot diverge. The runner is seeded with
 * the persisted (already-gated) history + the new follow-up (gated by the runner,
 * scoped to that one message), and drives the full control/turn loop with correct
 * abort/error/paused/completed classification.
 */
async function resumeSubAgent(
  subAgentConversationId: string,
  message: string,
  state: NonNullable<ReturnType<typeof subAgentState.get>>,
): Promise<void> {
  const {
    messages,
    config,
    modelConfig,
    streamConfig,
    profileKey,
    modelKey,
    tools,
    dbPath,
    parentConversationId,
    parentToolCallId,
    parentThreadId,
    depth,
    task,
    systemPrompt: persistedSystemPrompt,
  } = state;

  const localController = new AbortController();
  // Admission check FIRST, before takeover. A resume must respect the same caps
  // as an initial run (maxConcurrent + maxPerParent). A cap hit here is TRANSIENT
  // — it must NOT mark the run failed or destroy resumable state. This branch is
  // normally shielded by sendSubAgentFollowUp's synchronous precheck, but is kept
  // defensive: on a cap hit we RETAIN the message (FIFO) AND emit `paused` (via
  // the shared soft-rejection helper), leaving the snapshot intact so a later
  // drain (once capacity frees) or user resend retries admission.
  const admissionReason = resumeAdmissionBlockReason(subAgentConversationId, config);
  if (admissionReason) {
    // Route to the parent CONVERSATION id (parentThreadId) so parent-scoped
    // consumers see the paused/capacity transition; keep the tool-call id for
    // tool routing.
    retainFollowUpAsPaused(subAgentConversationId, message, admissionReason, {
      parentConversationId: parentThreadId ?? subAgentConversationId,
      parentToolCallId,
    });
    broadcastEvent({
      subAgentConversationId,
      // Route to the parent CONVERSATION id (matching the retained paused status just above);
      // the bare local `parentConversationId` is the tool-call id, which parent-scoped consumers
      // would discard — leaving them without the terminal `done` for this blocked resume.
      parentConversationId: parentThreadId ?? parentConversationId,
      parentToolCallId,
      conversationId: subAgentConversationId,
      type: 'done',
    });
    return;
  }

  // Admission passed — reserve the concurrency slot SYNCHRONOUSLY, before any
  // await (the DB reopen below). This closes the TOCTOU where two concurrent
  // resumes both read an admissible count and then both took over past the cap.
  // runSubAgent is told the slot is pre-reserved so it neither re-checks the cap
  // nor double-counts; we release it in this function's finally.
  reserveSubAgentSlot();

  // Take over the conversation: bump the run generation so an older run's
  // teardown (still finalizing) can't clobber this resume's runtime/state.
  const resumeGeneration = nextRunGeneration(subAgentConversationId);
  activeSubAgentControllers.set(subAgentConversationId, localController);
  followUpQueues.set(subAgentConversationId, []);
  if (parentThreadId) activeSubAgentParents.set(subAgentConversationId, parentThreadId);
  // AWAIT the reopen (completed/paused → running) BEFORE starting the run, so a
  // fast terminal finalization can't read the stale status and be FSM-rejected,
  // and a late running-write can't overwrite the terminal one. The caller
  // (sendSubAgentFollowUp) intentionally does not await resumeSubAgent, so this
  // only orders the reopen ahead of THIS run's own finalization.
  // Reopen (paused/completed → running), clearing the prior run's terminal metadata so a
  // now-running thread doesn't carry a stale completedAt/exitReason. updateSubagentStatus
  // RETURNS false on any failure (read/write error, thread-not-found, or illegal FSM
  // transition) — it does NOT throw — so check the RESULT, not a catch.
  const memory = getSharedMemory(config, dbPath);
  const reopened = memory
    ? await updateSubagentStatus(memory, subAgentConversationId, {
        status: 'running',
        completedAt: null,
        exitReason: null,
      })
    : true; // no shared memory (no persistence) → nothing to reopen; proceed
  if (!reopened) {
    // The DB status is still `paused`/`completed`. Proceeding would run the turn against that
    // stale status, and its terminal finalization (running → completed/failed) would be
    // FSM-REJECTED → stale status reappears. Abort the resume — but handle two hazards the
    // naive "retain the one message" path missed:
    //  (1) FOLLOW-UP LOSS: another message (B) may have been accepted into followUpQueues
    //      while this reopen awaited; cleanupRuntime deletes that queue. Capture ALL queued
    //      follow-ups (this run's `message` FIRST, then the queued ones in order) so none
    //      are lost, and RETAIN them for a later drain (retryPendingSubAgentResumes) — not
    //      just the first, and with an actual drain scheduled.
    //  (2) STOP RACE: if a Stop aborted this run during the awaited reopen, the user
    //      cancelled it — do NOT retain (that would auto-resume a stopped instruction). Drop.
    console.error('[Subagent] Failed to reopen status on resume — aborting resume (thread stays paused)');
    const queuedFollowUps = followUpQueues.get(subAgentConversationId) ?? [];
    const allPending = [message, ...queuedFollowUps];
    cleanupRuntime(subAgentConversationId, resumeGeneration);
    releaseSubAgentSlot();
    if (localController.signal.aborted) {
      // Stopped mid-reopen — the user cancelled. Make the thread definitively non-resumable:
      // drop the pending queue AND the retained resumable snapshot (cleanupRuntime preserves
      // subAgentState, so a later follow-up would otherwise restart the stopped work), and
      // broadcast `stopped` so the UI reflects it.
      pendingResumeQueues.delete(subAgentConversationId);
      subAgentState.delete(subAgentConversationId);
      broadcastEvent({
        subAgentConversationId,
        parentConversationId: parentThreadId ?? subAgentConversationId,
        parentToolCallId,
        conversationId: subAgentConversationId,
        type: 'sub-agent-status',
        status: 'stopped',
        summary: 'Stopped.',
      } as SubAgentEvent);
      // Persist the DURABLE `stopped` status too — the broadcast above is UI-only; without this
      // the on-disk metadata stays at its pre-reopen value (paused/completed), so the thread
      // reappears resumable/incorrect after a restart. paused/completed → stopped is FSM-legal.
      // Best-effort with a bounded retry (updateSubagentStatus returns false on failure, swallows
      // internally), mirroring stopSubAgent's terminal write.
      if (memory) {
        const writeStopped = async (remaining: number): Promise<void> => {
          const ok = await updateSubagentStatus(memory, subAgentConversationId, {
            status: 'stopped',
            completedAt: new Date().toISOString(),
            exitReason: 'stopped',
          });
          if (!ok && remaining > 0) setTimeout(() => void writeStopped(remaining - 1), 500);
        };
        void writeStopped(5);
      }
      // We released a concurrency slot above; another paused agent may now be admissible.
      // This conv is fully removed from pending, so the drain won't re-hit our failed reopen.
      queueMicrotask(() => drainAdmissiblePendingResumes());
      return;
    }
    // Retain ALL follow-ups (FIFO) for a later admission-gated drain. Do NOT drain NOW —
    // an immediate retry would re-enter the same failing reopen (tight loop on a persistent
    // DB error). The retained queue drains on the next natural trigger (a capacity-free
    // drainAdmissiblePendingResumes, or the user resending); the `paused` broadcast makes the
    // state visible meanwhile.
    const pending = pendingResumeQueues.get(subAgentConversationId) ?? [];
    pending.unshift(...allPending); // preserve order at the front
    pendingResumeQueues.set(subAgentConversationId, pending);
    broadcastEvent({
      subAgentConversationId,
      parentConversationId: parentThreadId ?? subAgentConversationId,
      parentToolCallId,
      conversationId: subAgentConversationId,
      type: 'sub-agent-status',
      status: 'paused',
      summary: 'Paused — could not reopen; retry to resume.',
      pausedReason: 'capacity',
    } as SubAgentEvent);
    // We released a concurrency slot above; drain OTHER paused agents that were waiting on
    // capacity — but do NOT re-drive THIS conv (its pending was just retained; re-attempting
    // its reopen now would tight-loop on a persistent failure — see round 115). Drain the
    // others directly, skipping this conversation.
    queueMicrotask(() => drainAdmissiblePendingResumes(subAgentConversationId));
    return;
  }

  // Terminal classification, mirroring the wrapper. Resumable state is built
  // from the runner's gated history (finalGatedMessages), not accumulated text.
  let runFailed = false;
  let runPaused = false;
  let runPausedReason: 'awaiting-input' | 'turn-limit' | 'capacity' | undefined;
  let lastFailureSummary: string | null = null;
  let finalGatedMessages: Array<{ role: string; content: unknown }> | null = null;
  let finalGatedSystemPrompt: string | undefined = persistedSystemPrompt;

  try {
    const stream = runSubAgent({
      subAgentConversationId,
      // Real parent CONVERSATION id for lifecycle-event routing (parentThreadId), so the CLI
      // reducer sees resumed-run notes too. parentToolCallId stays the tool-call id (GUI match).
      // (The resumable STATE's parentConversationId field intentionally holds the tool-call id
      // per the resume-routing convention — that's separate from these live event params.)
      parentConversationId: parentThreadId ?? parentConversationId,
      parentToolCallId,
      task,
      depth,
      config,
      modelConfig,
      ...(streamConfig ? { streamConfig } : {}),
      profileKey: profileKey ?? null,
      modelKey: modelKey ?? null,
      tools,
      dbPath,
      abortSignal: localController.signal,
      // The slot was reserved synchronously above; tell the runner so it does not
      // re-check the cap or double-count the concurrency counter.
      slotPreReserved: true,
      // Seed from the persisted (gated) history; the runner gates only the new
      // follow-up (scoped) and drives the full turn loop.
      resumeMessages: messages,
      resumeFollowUp: message,
      // Reuse the persisted GATED system prompt (a hook's guardrail from the prior
      // run) rather than rebuilding an ungated one from config.
      ...(persistedSystemPrompt !== undefined ? { resumeSystemPrompt: persistedSystemPrompt } : {}),
      getFollowUp: async () => {
        const queue = followUpQueues.get(subAgentConversationId);
        if (!queue || queue.length === 0) return null;
        return queue.shift() ?? null;
      },
      peekFollowUp: () => {
        const queue = followUpQueues.get(subAgentConversationId);
        return Boolean(queue && queue.length > 0);
      },
      onFinalMessages: (msgs) => {
        finalGatedMessages = msgs;
      },
      onFinalSystemPrompt: (sp) => {
        finalGatedSystemPrompt = sp;
      },
    });

    for await (const event of stream) {
      if (event.type === 'sub-agent-status') {
        if (event.status === 'failed') {
          runFailed = true;
          lastFailureSummary = event.summary ?? 'Sub-agent failed.';
        } else if (event.status === 'paused') {
          runPaused = true;
          runPausedReason = event.pausedReason ?? runPausedReason;
        }
      } else if (event.type === 'error') {
        runFailed = true;
        lastFailureSummary = ('error' in event && event.error ? String(event.error) : '') || 'Sub-agent error.';
      }
      // The runner already broadcasts every event to renderer/web clients; a
      // resume has no parent tool-call context to forward progress into.
    }
  } catch (error) {
    runFailed = true;
    lastFailureSummary = error instanceof Error ? error.message : String(error);
    // Emit a `type: 'error'` event FIRST so the renderer appends the exception to
    // the thread as visible content (the reducer's applyError path) — a bare
    // `sub-agent-status` summary is NOT surfaced for an existing thread, so the
    // user would otherwise see only an "Error" label with no cause. Mirrors the
    // runner's own error emit (and the pre-refactor resume path).
    broadcastEvent({
      subAgentConversationId,
      // Terminal lifecycle events must reach PARENT-scoped consumers (the CLI reducer scopes by
      // parent conversation id); the local `parentConversationId` here holds the TOOL-CALL id
      // (see the resumable-state note above), so route via parentThreadId — matching the resumed-
      // run status emit below and the paused/done emits. Using the bare tool-call id would make
      // parent-scoped clients discard this failure and leave the agent shown as still running.
      parentConversationId: parentThreadId ?? parentConversationId,
      parentToolCallId,
      conversationId: subAgentConversationId,
      type: 'error',
      error: lastFailureSummary,
    } as SubAgentEvent);
    broadcastEvent({
      subAgentConversationId,
      parentConversationId: parentThreadId ?? parentConversationId,
      parentToolCallId,
      conversationId: subAgentConversationId,
      type: 'sub-agent-status',
      status: 'failed',
      summary: lastFailureSummary,
    } as SubAgentEvent);
  } finally {
    const aborted = localController.signal.aborted;
    // Build resumable state from the runner's GATED history (never a raw
    // reconstruction — this is already DLP-gated, so it is safe to persist even
    // on failure). Crucially, persist it EVEN WHEN the resumed turn FAILED: the
    // gated history contains the new user turn + explanation, which a follow-up
    // like "retry" needs to see. Only an abort or a null gated history (runner
    // never surfaced messages) makes the run non-resumable — in the null case we
    // fall back to preserving the prior snapshot (preservePriorStateOnFailure).
    const gatedHistory = finalGatedMessages as Array<{ role: string; content: unknown }> | null;
    const resumableState =
      !aborted && gatedHistory !== null
        ? {
            messages: [...gatedHistory],
            config,
            modelConfig,
            ...(streamConfig ? { streamConfig } : {}),
            profileKey: profileKey ?? null,
            modelKey: modelKey ?? null,
            tools,
            dbPath,
            parentConversationId,
            parentToolCallId,
            parentThreadId: parentThreadId ?? null,
            depth,
            task,
            ...(finalGatedSystemPrompt !== undefined ? { systemPrompt: finalGatedSystemPrompt } : {}),
          }
        : null;

    await finalizeSubAgentRun({
      subAgentConversationId,
      outcome: {
        aborted,
        failed: runFailed,
        paused: runPaused,
        failureSummary: lastFailureSummary,
        ...(runPausedReason ? { pausedReason: runPausedReason } : {}),
      },
      resumableState,
      // A resume failure keeps the prior (still-valid) resumable snapshot; the
      // conversation remains resumable rather than becoming terminally failed.
      preservePriorStateOnFailure: true,
      ownerGeneration: resumeGeneration,
      dbPath,
      config,
      routing: { parentConversationId, parentToolCallId },
    });

    // Generation-aware teardown: only clears runtime if THIS resume is still the
    // current generation (a newer resume may have taken over).
    const stillOwns = subAgentRunGeneration.get(subAgentConversationId) === resumeGeneration;
    // An abort known AT ENTRY was already made non-resumable by finalize (it deletes
    // state on outcome.aborted); dropping it again here is a harmless no-op.
    if (aborted && stillOwns) {
      subAgentState.delete(subAgentConversationId);
      pendingResumeQueues.delete(subAgentConversationId);
    }
    // A stop that landed DURING finalize's awaited DB write is not reflected in the
    // captured `aborted`; correct it now (purge state + rewrite status to stopped).
    await correctIfAbortedAfterFinalize({
      subAgentConversationId,
      aborted: localController.signal.aborted && !aborted,
      ownerGeneration: resumeGeneration,
      config,
      dbPath,
      // Broadcast-only routing — route the `stopped` transition to the parent conversation id
      // (parentThreadId) so parent-scoped consumers accept it; bare parentConversationId is the
      // tool-call id and would be discarded.
      routing: { parentConversationId: parentThreadId ?? parentConversationId, parentToolCallId },
    });
    cleanupRuntime(subAgentConversationId, resumeGeneration);

    // Emit `done` ONLY if we're still the current generation — a successor resume
    // that already took over will emit its own terminal events; an older run's
    // late `done` would otherwise finalize the thread out from under it.
    if (stillOwns) {
      broadcastEvent({
        subAgentConversationId,
        // Terminal `done` for a resumed run — route to the parent CONVERSATION id so
        // parent-scoped consumers (CLI reducer) finalize the thread; the bare local
        // `parentConversationId` is the tool-call id and would be discarded by them.
        parentConversationId: parentThreadId ?? parentConversationId,
        parentToolCallId,
        conversationId: subAgentConversationId,
        type: 'done',
      });
    }
    // Release the slot reserved before the run started (runSubAgent did not
    // manage the counter because slotPreReserved was set). Do this BEFORE the
    // drain below so the freed capacity is visible to admissible retries.
    releaseSubAgentSlot();
    // A concurrency slot just freed — retry any conversation whose retained
    // follow-ups became admissible.
    drainAdmissiblePendingResumes();
  }
}

/** Stop a running sub-agent — OR cancel a paused/capacity-deferred one that has
 *  no live controller (its follow-up was retained pending capacity, or it's a
 *  resumable paused/completed thread). In the no-controller case we must purge the
 *  retained resumable state + pending-resume queue so a later drain can't launch
 *  the queued instruction (with side effects) after the user stopped/removed the
 *  thread. Returns true when a stop was effected. */
export function stopSubAgent(subAgentConversationId: string): boolean {
  const controller = activeSubAgentControllers.get(subAgentConversationId);
  if (controller) {
    controller.abort();
    return true;
  }
  // No live run. If there's retained resumable state or a pending-resume queue,
  // this is a paused/capacity-deferred thread — cancel it definitively so it can
  // never be auto-resumed, and tell clients it's stopped.
  const retainedState = subAgentState.get(subAgentConversationId);
  const hadState = subAgentState.delete(subAgentConversationId);
  const hadPending = pendingResumeQueues.delete(subAgentConversationId);
  if (!hadState && !hadPending) return false;
  // Route the stop to the ACTUAL parent so parent-scoped consumers (e.g. the CLI's
  // formatSubAgentStatusNote, which filters by parent conversation id) see the
  // transition. `parentConversationId` on this event is the parent's CONVERSATION
  // id — which in retained state is `parentThreadId` (ctx.conversationId), NOT the
  // state's `parentConversationId` field (that holds a tool-call id for routing).
  // Keep `parentToolCallId` for tool-call routing. Fall back to the child id only
  // when retained state lacks the parent thread (pending-only edge case).
  const stopParentConversationId = retainedState?.parentThreadId ?? subAgentConversationId;
  const stopParentToolCallId = retainedState?.parentToolCallId ?? subAgentConversationId;
  broadcastEvent({
    subAgentConversationId,
    parentConversationId: stopParentConversationId,
    parentToolCallId: stopParentToolCallId,
    conversationId: subAgentConversationId,
    type: 'sub-agent-status',
    status: 'stopped',
    summary: 'Stopped.',
  } as SubAgentEvent);
  // Best-effort terminal DB write (paused/completed → stopped is FSM-legal), using the
  // config/dbPath captured in the retained state. updateSubagentStatus RETURNS false on
  // failure (it swallows internally). The in-memory resumable state was already dropped
  // above, so if this write fails the thread would reappear on disk as `paused` yet no
  // longer be resumable — retry (bounded) to close that window rather than fire-and-forget.
  if (retainedState) {
    const memory = getSharedMemory(retainedState.config, retainedState.dbPath);
    if (memory) {
      const writeStopped = async (remaining: number): Promise<void> => {
        const ok = await updateSubagentStatus(memory, subAgentConversationId, {
          status: 'stopped',
          completedAt: new Date().toISOString(),
          exitReason: 'user_aborted',
        });
        if (!ok && remaining > 0) {
          setTimeout(() => void writeStopped(remaining - 1), 500);
        } else if (!ok) {
          console.error(`[Subagent] Failed to persist stopped status for ${subAgentConversationId} after retries`);
        }
      };
      void writeStopped(5).catch((err) => console.error('[Subagent] Failed to record stop of paused sub-agent:', err));
    }
  }
  return true;
}

/** Get all active sub-agent conversation IDs */
export function getActiveSubAgentIds(): string[] {
  return Array.from(activeSubAgentControllers.keys());
}

/**
 * Decide which profile/model a sub-agent runs under, given the tool call's
 * explicit `profile`/`model` and the parent turn's inherited keys. Precedence:
 *   1. explicit `profile`            → that profile (may be '__none__' to force none)
 *   2. explicit `model`              → single model, no profile ('__none__')
 *   3. subAgents.defaultModel override → the Settings "Default Model Override"
 *      is an explicit user choice, so it beats implicit parent inheritance
 *   4. inherit parent profile         → parentProfileKey
 *   5. inherit parent model           → parentModelKey
 *   6. global default (single model)
 * Returns keys shaped for `resolveStreamConfig` (threadProfileKey '__none__'
 * skips profiles; threadModelKey pins a single model). Exported for tests.
 */
export function resolveSubAgentModelSelection(input: {
  profile?: string;
  model?: string;
  parentProfileKey: string | null;
  parentModelKey: string | null;
  defaultModel: string | null;
}): { threadProfileKey: string | null; threadModelKey: string | null } {
  const { profile, model, parentProfileKey, parentModelKey, defaultModel } = input;
  if (profile !== undefined) {
    return { threadProfileKey: profile, threadModelKey: null };
  }
  if (model !== undefined) {
    return { threadProfileKey: '__none__', threadModelKey: model };
  }
  // Explicit Settings override wins over implicit parent inheritance.
  if (defaultModel) {
    return { threadProfileKey: '__none__', threadModelKey: defaultModel };
  }
  if (parentProfileKey != null && parentProfileKey !== '' && parentProfileKey !== '__none__') {
    return { threadProfileKey: parentProfileKey, threadModelKey: null };
  }
  return { threadProfileKey: '__none__', threadModelKey: parentModelKey };
}

export function createSubAgentTool(
  getConfig: () => AppConfig,
  appHome: string,
  currentDepth: number,
  parentTools?: ToolDefinition[],
): ToolDefinition {
  // Register the live-config accessor so module-level admission checks (resume /
  // retry-drain) read the CURRENT caps rather than a sub-agent's stale captured
  // config. Idempotent; the newest registration wins (config getters are stable).
  liveConfigProvider = getConfig;
  return {
    name: 'sub_agent',
    description: [
      'Spawn a sub-agent to handle a task autonomously. The sub-agent has access to all the same tools',
      '(shell, file operations, search, etc.) and can work independently on the assigned task.',
      'Use this when you want to delegate a self-contained task that can run in parallel or needs focused attention.',
      'The sub-agent will return its complete response when finished.',
      '',
      'You can send follow-up instructions to guide the sub-agent after it completes a turn.',
      `Current nesting depth: ${currentDepth}.`,
    ].join(' '),
    inputSchema: z.object({
      task: z
        .string()
        .describe('The task/instruction for the sub-agent. Be specific and clear about what you want accomplished.'),
      model: z
        .string()
        .optional()
        .describe(
          'Model key to pin a single model for the sub-agent (no fallback). Omit to inherit the current profile/model.',
        ),
      profile: z
        .string()
        .optional()
        .describe(
          'Profile key to run the sub-agent under (uses that profile\'s primary + fallback chain). Omit to inherit the current turn\'s profile; pass "__none__" to force a single model with no profile.',
        ),
      context: z
        .string()
        .optional()
        .describe('Additional context from the current conversation that the sub-agent needs.'),
    }),
    execute: async (input: unknown, ctx: ToolExecutionContext): Promise<unknown> => {
      const { task, model, profile, context } = input as {
        task: string;
        model?: string;
        profile?: string;
        context?: string;
      };
      const config = getConfig();
      const subAgentConfig = config.tools?.subAgents ?? {
        enabled: true,
        maxDepth: 3,
        maxConcurrent: 4,
        maxPerParent: 2,
      };

      const maxDepth = subAgentConfig.maxDepth ?? 3;
      if (currentDepth >= maxDepth) {
        return { isError: true, error: `Sub-agent depth limit reached (max: ${maxDepth}).` };
      }
      if (getActiveSubAgentCount() >= (subAgentConfig.maxConcurrent ?? 4)) {
        return {
          isError: true,
          error: `Maximum concurrent sub-agents (${subAgentConfig.maxConcurrent ?? 4}) reached.`,
        };
      }
      // Enforce the per-parent cap: how many sub-agents THIS conversation already
      // has running. Uses the synchronously-registered activeSubAgentParents map so
      // the check is race-free with the registration below (no await between).
      const maxPerParent = subAgentConfig.maxPerParent ?? 2;
      const parentId = ctx.conversationId;
      if (parentId) {
        let activeForParent = 0;
        for (const p of activeSubAgentParents.values()) {
          if (p === parentId) activeForParent += 1;
        }
        if (activeForParent >= maxPerParent) {
          return {
            isError: true,
            error: `Maximum sub-agents per parent (${maxPerParent}) reached.`,
          };
        }
      }

      // Resolve which profile/model the sub-agent runs under (see the helper).
      const { threadProfileKey, threadModelKey } = resolveSubAgentModelSelection({
        profile,
        model,
        parentProfileKey: ctx.parentProfileKey ?? null,
        parentModelKey: ctx.parentModelKey ?? null,
        defaultModel: subAgentConfig.defaultModel ?? null,
      });

      // Resolve the profile-aware chain. fallbackEnabled whenever a real profile
      // is active (not the '__none__' sentinel / single-model path).
      const profileActive = threadProfileKey !== null && threadProfileKey !== '__none__';
      const streamConfig: ResolvedStreamConfig | null = resolveStreamConfig(config, {
        threadModelKey,
        threadProfileKey,
        fallbackEnabled: profileActive,
      });

      // Primary model entry (for the single-model path + display/telemetry).
      const modelEntry = streamConfig?.primaryModel ?? resolveModelForThread(config, threadModelKey);
      if (!modelEntry) {
        return { isError: true, error: 'No model available for sub-agent.' };
      }

      const subAgentConversationId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const dbPath = join(appHome, 'data', 'memory.db');

      followUpQueues.set(subAgentConversationId, []);
      const localController = new AbortController();
      const runGeneration = nextRunGeneration(subAgentConversationId);
      activeSubAgentControllers.set(subAgentConversationId, localController);
      toolCallToSubAgent.set(ctx.toolCallId, subAgentConversationId);
      if (parentId) activeSubAgentParents.set(subAgentConversationId, parentId);
      traceDiagnostic({
        scope: 'agent',
        event: 'sub-agent.spawn',
        conversationId: ctx.conversationId,
        toolName: 'sub_agent',
        // Metadata only — do NOT include the raw task. This fires BEFORE the
        // UserPromptSubmit DLP gate, so with content tracing enabled the raw
        // (possibly-to-be-redacted) task would otherwise be persisted. The
        // gated task is surfaced later as a sub-agent-user-message.
        fields: { parentToolCallId: ctx.toolCallId, subAgentConversationId, taskChars: task.length },
      });

      if (ctx.abortSignal?.aborted) {
        cleanupRuntime(subAgentConversationId, runGeneration);
        return { isError: true, error: 'Parent operation was cancelled.' };
      }

      const parentAbortHandler = (): void => {
        localController.abort();
      };
      ctx.abortSignal?.addEventListener('abort', parentAbortHandler, { once: true });

      const baseTools = parentTools ?? [];
      const subAgentTools = baseTools
        .filter((t) => t.name !== 'sub_agent')
        .concat(
          currentDepth + 1 < maxDepth ? [createSubAgentTool(getConfig, appHome, currentDepth + 1, baseTools)] : [],
        );

      // Captured from the runner's onFinalMessages/onFinalSystemPrompt. Declared
      // BEFORE the try so the catch can also build resumable recovery state — the
      // runner's finally fires these even when it throws, so on an exception the
      // catch still has the SAFE (gated) history to persist for retry.
      let finalGatedMessages: Array<{ role: string; content: unknown }> | null = null;
      let finalGatedSystemPrompt: string | undefined;

      try {
        let fullResponse = '';
        let toolsUsed: string[] = [];
        // Set when the runner emits a terminal `failed`/`error` status (e.g. a
        // UserPromptSubmit hook denied the prompt, or a concurrency-limit error).
        // `runFailed` is the authoritative flag (an empty/omitted failure summary
        // must NOT be mistaken for success via a truthiness check); the summary
        // string carries the reason for display.
        let runFailed = false;
        // Set when the run ends PAUSED (awaiting-input timeout): terminal but
        // resumable — reported as a distinct paused result, not completed.
        let runPaused = false;
        let runPausedReason: 'awaiting-input' | 'turn-limit' | 'capacity' | undefined;
        let lastFailureSummary: string | null = null;

        // Don't echo the raw task here — a UserPromptSubmit DLP hook (run inside
        // runSubAgent) may redact/deny it. The sanitized task is broadcast by the
        // runner as a sub-agent-user-message after gating.
        ctx.onProgress?.({
          stream: 'stdout',
          delta: `[Sub-agent started]\n`,
          output: `[Sub-agent started]\n`,
          bytesSeen: 0,
          truncated: false,
          stopped: false,
          subAgentConversationId,
        });

        // Set initial status to 'running' and link to parent
        try {
          const memory = getSharedMemory(config, dbPath);
          if (memory) {
            await updateSubagentStatus(memory, subAgentConversationId, {
              status: 'running',
              parentThreadId: ctx.conversationId,
            });
          }
        } catch (err) {
          console.error('[Subagent] Failed to set initial status:', err);
        }

        // finalGatedMessages / finalGatedSystemPrompt are declared before the try
        // (so the catch can also read them); the runner populates them via
        // onFinalMessages / onFinalSystemPrompt below.
        const stream = runSubAgent({
          subAgentConversationId,
          // parentConversationId = the REAL parent CONVERSATION id (ctx.conversationId), so
          // parent-scoped consumers (the CLI reducer's formatSubAgentStatusNote filters on the
          // parent conv id) see normal running/completed/failed lifecycle notes. The GUI matches
          // sub-agents by parentToolCallId (SubAgentInline), so keep that = ctx.toolCallId.
          // (Was ctx.toolCallId for BOTH, which hid the CLI lifecycle notes.)
          parentConversationId: ctx.conversationId ?? ctx.toolCallId,
          parentToolCallId: ctx.toolCallId,
          task,
          context,
          depth: currentDepth + 1,
          config,
          modelConfig: modelEntry.modelConfig,
          ...(streamConfig ? { streamConfig } : {}),
          profileKey: threadProfileKey,
          modelKey: threadModelKey,
          tools: subAgentTools,
          dbPath,
          abortSignal: localController.signal,
          getFollowUp: async () => {
            const queue = followUpQueues.get(subAgentConversationId);
            if (!queue || queue.length === 0) return null;
            return queue.shift() ?? null;
          },
          peekFollowUp: () => {
            const queue = followUpQueues.get(subAgentConversationId);
            return Boolean(queue && queue.length > 0);
          },
          onControlSignal: (action, message) => {
            // Surface the sub-agent's control-tool declaration on the parent's
            // sub_agent tool-progress the MOMENT it fires, so the parent tool
            // observer sees complete/failed immediately and won't nudge in the
            // window before the runner's turn-loop status emit. The observer
            // latches `declaredComplete` off this `subAgentSignal`.
            ctx.onProgress?.({
              stream: 'stdout',
              delta: '',
              output: `[Signal: ${action}] ${message ?? ''}\n`,
              bytesSeen: fullResponse.length,
              truncated: false,
              stopped: false,
              subAgentConversationId,
              subAgentSignal: action,
            });
          },
          onFinalMessages: (msgs) => {
            finalGatedMessages = msgs;
          },
          onFinalSystemPrompt: (sp) => {
            finalGatedSystemPrompt = sp;
          },
        });

        for await (const event of stream) {
          if (event.type === 'model-fallback') {
            // Mid-stream fallback restarts the sub-agent response on the next
            // model — drop the failed partial so the tool result returned to the
            // parent is the successful retry only, not a failed-prefix + success
            // concatenation. (The runner resets its own buffer + provider tools.)
            fullResponse = '';
          } else if (event.type === 'text-delta' && 'text' in event && event.text) {
            fullResponse += event.text;
            ctx.onProgress?.({
              stream: 'stdout',
              delta: event.text,
              output: fullResponse.slice(-4000),
              bytesSeen: fullResponse.length,
              truncated: fullResponse.length > 4000,
              stopped: false,
              subAgentConversationId,
            });
          } else if (event.type === 'tool-call' && 'toolName' in event) {
            const toolName = event.toolName ?? 'unknown';
            if (!toolsUsed.includes(toolName) && toolName !== 'sub_agent_control') toolsUsed.push(toolName);
            ctx.onProgress?.({
              stream: 'stdout',
              delta: `[Sub-agent using tool: ${toolName}]\n`,
              output: `[Sub-agent using tool: ${toolName}]\n`,
              bytesSeen: fullResponse.length,
              truncated: false,
              stopped: false,
              subAgentConversationId,
            });
          } else if (event.type === 'error') {
            // A runner-level error (e.g. the concurrency cap tripped inside
            // runSubAgent after the wrapper's own check passed). Terminal failure:
            // mark the run failed so it is NOT persisted as resumable state with a
            // reconstructed raw task, and NOT reported as completed.
            runFailed = true;
            lastFailureSummary = ('error' in event && event.error ? String(event.error) : '') || 'Sub-agent error.';
            ctx.onProgress?.({
              stream: 'stderr',
              delta: `[Error] ${lastFailureSummary}\n`,
              output: `[Error] ${lastFailureSummary}\n`,
              bytesSeen: fullResponse.length,
              truncated: false,
              stopped: false,
              subAgentConversationId,
              subAgentSignal: 'failed',
            });
          } else if (event.type === 'sub-agent-status') {
            const isTerminal =
              event.status === 'completed' ||
              event.status === 'failed' ||
              event.status === 'stopped' ||
              event.status === 'paused';
            if (event.status === 'failed') {
              runFailed = true;
              lastFailureSummary = event.summary ?? 'Sub-agent failed.';
            }
            if (event.status === 'paused') {
              // Terminal-but-RESUMABLE: the sub-agent timed out awaiting input.
              // NOT a failure (leave runFailed false → resumable state persisted),
              // NOT a completion. Recorded so the wrapper returns a paused result.
              runPaused = true;
              runPausedReason = event.pausedReason ?? runPausedReason;
            }
            // Forward the status text as progress. Attach a subAgentSignal ONLY for
            // TERMINAL statuses (completed/failed/stopped/paused) so the observer
            // latches declaredComplete and stops acting on a finishing/paused
            // sub-agent during persistence. Non-terminal statuses (running/
            // awaiting-input) carry NO signal — deriving one from a plumbing
            // `running` (emitted while the runner drains a post-completion
            // follow-up) would clear the latch and reopen the nag loop. The
            // authoritative non-terminal signals come from onControlSignal.
            const terminalSignal =
              event.status === 'completed'
                ? ('complete' as const)
                : event.status === 'failed'
                  ? ('failed' as const)
                  : event.status === 'stopped'
                    ? ('stopped' as const)
                    : event.status === 'paused'
                      ? ('paused' as const)
                      : undefined;
            ctx.onProgress?.({
              stream: 'stdout',
              delta: `[Status: ${event.status}] ${event.summary ?? ''}\n`,
              output: `[Status: ${event.status}] ${event.summary ?? ''}\n`,
              bytesSeen: fullResponse.length,
              truncated: false,
              stopped: false,
              subAgentConversationId,
              ...(isTerminal ? { subAgentSignal: terminalSignal } : {}),
            });
          }
        }

        // Build resumable state STRICTLY from the runner's GATED message history.
        // A raw task/context reconstruction could replay UNREDACTED content on a
        // later resume (bypassing the UserPromptSubmit DLP gate), so when the
        // runner never surfaced gated messages (null) the run is NOT resumable —
        // we do not fabricate history. An intentionally EMPTY gated history ([])
        // is a valid redaction result and remains resumable. Persist gated history
        // EVEN ON FAILURE (it's already DLP-gated, so safe): this keeps the
        // conversation resumable so a follow-up accepted during the failing turn
        // (IPC returned ok:true) is handed off rather than silently lost, and a
        // later "retry" can see the failed request. Only an abort makes it
        // non-resumable (the caller's finally clears aborted state).
        const gatedHistory = finalGatedMessages as Array<{ role: string; content: unknown }> | null;
        const resumableState =
          !localController.signal.aborted && gatedHistory !== null
            ? {
                messages: [...gatedHistory],
                config,
                modelConfig: modelEntry.modelConfig,
                ...(streamConfig ? { streamConfig } : {}),
                profileKey: threadProfileKey,
                modelKey: threadModelKey,
                tools: subAgentTools,
                dbPath,
                parentConversationId: ctx.toolCallId,
                parentToolCallId: ctx.toolCallId,
                parentThreadId: parentId ?? null,
                depth: currentDepth + 1,
                task,
                ...(finalGatedSystemPrompt !== undefined ? { systemPrompt: finalGatedSystemPrompt } : {}),
              }
            : null;

        // SHARED terminal finalization (atomic queue close, resumable-state
        // persistence, DB status write, follow-up transfer to resume). Identical
        // code path to the resume engine — no divergence.
        await finalizeSubAgentRun({
          subAgentConversationId,
          outcome: {
            aborted: localController.signal.aborted,
            failed: runFailed,
            paused: runPaused,
            failureSummary: lastFailureSummary,
            ...(runPausedReason ? { pausedReason: runPausedReason } : {}),
          },
          resumableState,
          // On failure, still persist the fresh gated state + seed the handoff so
          // a follow-up accepted during the failing turn isn't lost and a "retry"
          // works — but keep the DB status terminal `failed` (honest error card).
          persistFreshStateOnFailure: true,
          ownerGeneration: runGeneration,
          dbPath,
          config,
          routing: {
            parentConversationId: ctx.conversationId ?? subAgentConversationId,
            parentToolCallId: ctx.toolCallId ?? subAgentConversationId,
          },
        });

        // Re-check abort AFTER finalization: the user/parent may have stopped this
        // agent while finalizeSubAgentRun awaited its DB write. If it's now aborted
        // and still resumable, cancel it (purge state + rewrite status to stopped).
        await correctIfAbortedAfterFinalize({
          subAgentConversationId,
          aborted: localController.signal.aborted,
          ownerGeneration: runGeneration,
          config,
          dbPath,
          // routing is used only for the `stopped` BROADCAST — route it to the parent
          // conversation id so parent-scoped consumers accept it (the tool-call id would be
          // discarded, leaving a stopped agent shown as running). The status DB write keys on
          // subAgentConversationId, unaffected.
          routing: { parentConversationId: ctx.conversationId ?? ctx.toolCallId, parentToolCallId: ctx.toolCallId },
        });

        // A terminal `failed`/`error` run (e.g. a UserPromptSubmit hook denied
        // the prompt, or a runner-level error) must surface to the parent as an
        // error, not a completed run.
        if (runFailed && !localController.signal.aborted) {
          return {
            isError: true,
            subAgentConversationId,
            error: lastFailureSummary || 'Sub-agent failed.',
            response: fullResponse,
            toolsUsed,
            depth: currentDepth + 1,
            status: 'failed',
          };
        }

        // An aborted run returned partial/interrupted work — surface it as an
        // error so the parent agent doesn't treat a cancelled sub-agent as a
        // successful completion. (Any resumable state cached before the abort is
        // dropped in the finally block.)
        if (localController.signal.aborted) {
          return {
            isError: true,
            subAgentConversationId,
            error: 'Sub-agent was stopped before completing its task.',
            response: fullResponse,
            toolsUsed,
            depth: currentDepth + 1,
            status: 'stopped',
          };
        }

        // A PAUSED run (awaiting-input timeout) is terminal-but-resumable — report
        // it distinctly so the parent doesn't treat it as a successful completion
        // and the UI doesn't show "Completed". Resumable state was persisted above
        // (runPaused leaves runFailed false).
        if (runPaused) {
          return {
            subAgentConversationId,
            response: fullResponse,
            toolsUsed,
            depth: currentDepth + 1,
            status: 'paused',
          };
        }

        return {
          subAgentConversationId,
          response: fullResponse,
          toolsUsed,
          depth: currentDepth + 1,
          status: 'completed',
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        // Broadcast a terminal status + done so the renderer (live-status
        // authoritative) doesn't leave the thread stuck 'running'. An abort is
        // 'stopped'; any other exception is 'failed'.
        const aborted = localController.signal.aborted;
        // Emit a `type: 'error'` event FIRST so the exception is appended to the
        // thread as visible content (a bare status summary isn't surfaced for an
        // existing thread). Skip for an abort (that's a clean stop, not an error).
        if (!aborted) {
          broadcastEvent({
            subAgentConversationId,
            // Route terminal lifecycle events to the PARENT CONVERSATION id so parent-scoped
            // consumers (the CLI reducer) accept them — matching the success finalize routing
            // (ctx.conversationId) and the live-status emits. The tool-call id is only the
            // resumable-STATE routing field, not a lifecycle-broadcast scope; using it here would
            // make parent-scoped clients discard the failure and show the agent as still running.
            parentConversationId: ctx.conversationId ?? ctx.toolCallId,
            parentToolCallId: ctx.toolCallId,
            conversationId: subAgentConversationId,
            type: 'error',
            error: errMsg,
          } as SubAgentEvent);
        }
        broadcastEvent({
          subAgentConversationId,
          parentConversationId: ctx.conversationId ?? ctx.toolCallId,
          parentToolCallId: ctx.toolCallId,
          conversationId: subAgentConversationId,
          type: 'sub-agent-status',
          status: aborted ? 'stopped' : 'failed',
          summary: aborted ? 'Stopped.' : errMsg,
        } as SubAgentEvent);
        // The runner's `finally` still calls onFinalMessages even when it throws,
        // so finalGatedMessages holds the SAFE (DLP-gated) history at the throw
        // point. Persist it as resumable (like the non-throw failure path) so a
        // follow-up accepted during the failing run isn't lost and a "retry" can
        // reference the failed request. Only an abort is non-resumable (the caller
        // wants a clean stop). Never a raw reconstruction (null gated → null state).
        const gatedHistory = finalGatedMessages as Array<{ role: string; content: unknown }> | null;
        const catchResumableState =
          !aborted && gatedHistory !== null
            ? {
                messages: [...gatedHistory],
                config,
                modelConfig: modelEntry.modelConfig,
                ...(streamConfig ? { streamConfig } : {}),
                profileKey: threadProfileKey,
                modelKey: threadModelKey,
                tools: subAgentTools,
                dbPath,
                parentConversationId: ctx.toolCallId,
                parentToolCallId: ctx.toolCallId,
                parentThreadId: parentId ?? null,
                depth: currentDepth + 1,
                task,
                ...(finalGatedSystemPrompt !== undefined ? { systemPrompt: finalGatedSystemPrompt } : {}),
              }
            : null;
        // Shared finalization. Persist the gated recovery state on a non-abort
        // failure (persistFreshStateOnFailure) so accepted follow-ups survive; an
        // abort clears state and stops cleanly.
        await finalizeSubAgentRun({
          subAgentConversationId,
          outcome: { aborted, failed: !aborted, paused: false, failureSummary: errMsg },
          resumableState: catchResumableState,
          persistFreshStateOnFailure: true,
          ownerGeneration: runGeneration,
          dbPath,
          config,
          routing: {
            parentConversationId: ctx.conversationId ?? subAgentConversationId,
            parentToolCallId: ctx.toolCallId ?? subAgentConversationId,
          },
        });

        // Re-check abort AFTER finalization (the `aborted` above was snapshotted
        // before the awaited DB write). If a stop landed during the write and the
        // conversation is still resumable, cancel it (purge + rewrite to stopped).
        await correctIfAbortedAfterFinalize({
          subAgentConversationId,
          aborted: localController.signal.aborted,
          ownerGeneration: runGeneration,
          config,
          dbPath,
          // Broadcast-only routing — send the `stopped` transition to the parent conversation id
          // so parent-scoped consumers accept it (tool-call id would be discarded).
          routing: { parentConversationId: ctx.conversationId ?? ctx.toolCallId, parentToolCallId: ctx.toolCallId },
        });
        broadcastEvent({
          subAgentConversationId,
          // Match the terminal error/failed routing above: parent-scoped consumers that accepted
          // the failure must also see the matching `done`, so route to the parent conversation id.
          parentConversationId: ctx.conversationId ?? ctx.toolCallId,
          parentToolCallId: ctx.toolCallId,
          conversationId: subAgentConversationId,
          type: 'done',
        });

        return {
          isError: true,
          subAgentConversationId,
          error: errMsg,
          depth: currentDepth + 1,
          status: aborted ? 'stopped' : 'error',
        };
      } finally {
        ctx.abortSignal?.removeEventListener('abort', parentAbortHandler);
        // Ownership: we're still the owner iff our generation is the latest
        // issued (a successor resume bumps it). The generation counter is never
        // deleted, so this comparison stays valid across teardown.
        const stillOwnsRuntime = subAgentRunGeneration.get(subAgentConversationId) === runGeneration;
        cleanupRuntime(subAgentConversationId, runGeneration);
        // Preserve subAgentState for resumption of a CLEANLY completed run — but
        // if this run was aborted, drop any resumable state cached before the
        // abort landed (an aborted run has incomplete/ungated history and must
        // never be resumable). GENERATION-AWARE: only drop it if THIS run is
        // still the current generation — if a concurrent resume took over, that
        // resume owns the (freshly rebuilt) state and this run must not delete it.
        if (localController.signal.aborted && stillOwnsRuntime) {
          subAgentState.delete(subAgentConversationId);
        }
        // (Follow-up transfer to the resume path is handled by
        // finalizeSubAgentRun, shared with the resume engine.)
        // A concurrency slot just freed — retry any conversation whose retained
        // follow-ups became admissible.
        drainAdmissiblePendingResumes();
      }
    },
  };
}

/** Clean up runtime state (queue + controller + toolCall mapping) but preserve
 *  conversation state. GENERATION-AWARE: pass the run's own generation token.
 *  The queue/controller/parent-slot are deleted ONLY if this run is still the
 *  CURRENT generation for the conversation — so if a resume (triggered by a
 *  follow-up during this run's terminal persistence) has already taken over
 *  (bumping the generation), this finishing run's cleanup does NOT clobber the
 *  resume's fresh runtime. This is correct even if the successor already
 *  finished and removed its controller (a controller-presence check would
 *  mis-read that as "unowned"). The per-spawn toolCall→subAgent mapping is
 *  always dropped (a resume doesn't re-register it). */
function cleanupRuntime(subAgentConversationId: string, ownerGeneration?: number): void {
  const current = subAgentRunGeneration.get(subAgentConversationId);
  // Own the runtime iff we ARE the latest-issued generation. Note: the
  // generation counter is NEVER deleted here — it must stay monotonic so a later
  // resume gets a strictly-higher number. Deleting it would let a resume reuse
  // an old value, and a stale older run's teardown could then match and clobber
  // the newer run. `undefined` current means no run ever registered (defensive).
  const ownsRuntime = ownerGeneration === undefined || current === undefined || current === ownerGeneration;
  if (ownsRuntime) {
    followUpQueues.delete(subAgentConversationId);
    activeSubAgentControllers.delete(subAgentConversationId);
    activeSubAgentParents.delete(subAgentConversationId);
  }
  for (const [toolCallId, saId] of toolCallToSubAgent) {
    if (saId === subAgentConversationId) toolCallToSubAgent.delete(toolCallId);
  }
}

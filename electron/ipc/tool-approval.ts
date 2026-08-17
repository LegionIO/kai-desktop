/**
 * Shared tool-approval infrastructure.
 *
 * Both the Mastra streaming pipeline (in agent.ts) and the Claude Agent SDK
 * MCP bridge (in claude-agent-runtime.ts) need to:
 *   1. Register a pending approval for a tool call
 *   2. Broadcast events to all renderer windows
 *
 * This module owns the `pendingToolApprovals` map so both code paths can
 * register entries and the existing IPC handlers (agent:approve-tool,
 * agent:reject-tool, agent:dismiss-tool, agent:answer-tool-question) can
 * resolve them.
 */

import { BrowserWindow } from 'electron';
import { broadcastToWebClients } from '../web-server/web-clients.js';
import type { StreamEvent } from '../agent/mastra-agent.js';
import { traceDiagnostic } from '../diagnostics/debug-trace.js';

// ---------------------------------------------------------------------------
// Pending tool approvals
// ---------------------------------------------------------------------------

/**
 * Categorical reason recorded when an approval settles. Threaded explicitly so
 * the trace records the true source: an `ask_user` answer settles as `answered`
 * (not a bare `approve`), a generic tool approval as `approve`, an abort as
 * `abort`, and a colliding-id fail-closed eviction as `duplicate-evict`.
 */
export type ApprovalSettleSource = 'answered' | 'approve' | 'reject' | 'dismiss' | 'abort' | 'duplicate-evict';

/** Resolver stored per pending approval. `source` (optional) lets the IPC
 *  handler that settles the entry name the true reason for the trace; when
 *  omitted it is derived from the resolved value. */
type PendingApproval = { resolve: (approved: boolean | 'dismiss', source?: ApprovalSettleSource) => void };

/**
 * Map of toolCallId → resolver.
 *
 * When a tool call needs user approval (e.g. ask_user, confirm-writes mode),
 * the caller registers a pending entry and awaits the returned Promise.
 * The IPC handlers in agent.ts resolve the entry when the user responds.
 */
export const pendingToolApprovals = new Map<string, PendingApproval>();

/** Optional diagnostic context for an approval, so the (previously invisible)
 *  approve/reject/dismiss/abort lifecycle shows up in the diagnostic trace. */
export type ApprovalTraceContext = {
  conversationId?: string;
  toolName?: string;
  /** The renderer-facing id, when it differs from the map key (exec id). */
  execToolCallId?: string;
  /** Optional settle observer: invoked once with the CATEGORICAL settle source
   *  (answered / approve / reject / dismiss / abort / duplicate-evict) the instant
   *  the approval resolves. A caller (e.g. the SDK ask_user handler) uses this to
   *  distinguish a recoverable ABORT — turn torn down while an answer raced — from
   *  a deliberate reject/dismiss, so it only routes recovery for the former (R94). */
  onSettle?: (source: ApprovalSettleSource) => void;
};

/** Derive a categorical settle reason from the resolved value + abort flag,
 *  used only when the settler did not pass an explicit {@link ApprovalSettleSource}. */
function settleReason(value: boolean | 'dismiss', aborted: boolean): ApprovalSettleSource {
  if (aborted) return 'abort';
  if (value === true) return 'approve';
  if (value === false) return 'reject';
  return 'dismiss';
}

/**
 * Register a pending approval for a tool call and return a Promise that
 * resolves when the user approves, rejects, or dismisses.
 *
 * If an `abortSignal` is provided, aborting it will reject with 'dismiss'.
 *
 * ⚠️ The resolved value is `true` (approved), `false` (rejected), or the string
 * `'dismiss'` (dismissed/aborted). `'dismiss'` is TRUTHY — callers MUST gate on
 * `decision === true`, never a bare `if (decision)`, or a dismissal/abort would
 * be treated as approval and execute the tool. (All current callers do this.)
 *
 * `trace` is optional diagnostic context; when the trace scope is enabled the
 * awaiting + settle lifecycle (with a categorical reason) is recorded so a lost
 * answer / spurious dismiss is diagnosable after the fact.
 */
export function registerPendingApproval(
  toolCallId: string,
  abortSignal?: AbortSignal,
  trace?: ApprovalTraceContext,
): Promise<boolean | 'dismiss'> {
  // A duplicate toolCallId would overwrite the map entry and orphan the prior
  // waiter's resolver forever (its Promise never settles → the earlier tool
  // call hangs). Settle any existing entry fail-closed (deny) before replacing.
  // Pass the explicit `duplicate-evict` source so the prior waiter's own settle
  // closure records exactly ONE settled event with that reason (not a spurious
  // extra `reject` on top of a separately-logged eviction).
  const existing = pendingToolApprovals.get(toolCallId);
  if (existing) {
    existing.resolve(false, 'duplicate-evict');
    pendingToolApprovals.delete(toolCallId);
  }
  traceDiagnostic({
    scope: 'agent',
    event: 'approval.awaiting',
    conversationId: trace?.conversationId,
    toolName: trace?.toolName,
    fields: { toolCallId, execToolCallId: trace?.execToolCallId },
  });
  return new Promise<boolean | 'dismiss'>((resolve) => {
    // Wrap the stored resolver so EVERY resolution path (user approve/reject via
    // the IPC handler, abort, or duplicate-eviction) tears down the abort
    // listener + map entry exactly once. The abort listener was previously
    // {once:true} with no removal on the normal (approve/reject) path, so it
    // stayed attached to the (turn-scoped, reused per tool call) abortSignal
    // until the signal aborted — accumulating one listener per approved tool call.
    let settled = false;
    const onAbort = (): void => settle('dismiss', 'abort');
    const settle = (value: boolean | 'dismiss', source?: ApprovalSettleSource): void => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener('abort', onAbort);
      pendingToolApprovals.delete(toolCallId);
      const reason = source ?? settleReason(value, false);
      traceDiagnostic({
        scope: 'agent',
        event: 'approval.settled',
        // A fail-closed eviction / abort is worth flagging; a normal settle isn't.
        level: reason === 'duplicate-evict' ? 'warn' : undefined,
        conversationId: trace?.conversationId,
        toolName: trace?.toolName,
        fields: {
          toolCallId,
          reason,
          aborted: reason === 'abort',
          execToolCallId: trace?.execToolCallId,
        },
      });
      try {
        trace?.onSettle?.(reason);
      } catch {
        /* observer must never break the settle path */
      }
      resolve(value);
    };

    // The stored resolver forwards the explicit settle source (e.g. `answered`
    // from agent:answer-tool-question, `duplicate-evict` from an eviction) so the
    // trace records the true reason rather than one derived only from the value.
    pendingToolApprovals.set(toolCallId, { resolve: (value, source) => settle(value, source) });

    if (abortSignal) {
      if (abortSignal.aborted) {
        settle('dismiss', 'abort');
      } else {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Event broadcasting
// ---------------------------------------------------------------------------

/**
 * Optional tagger installed by agent.ts. Given a raw stream event, it returns
 * the event with `serverPersisted: true` when the conversation's active stream
 * is a main-process-persisted (CLI/headless) turn — so a GUI watching that turn
 * renders live but does NOT persist a partial branch (which would duplicate/
 * fork against the authoritative main-process write). Identity when not owned.
 */
let serverPersistTagger: ((event: StreamEvent) => StreamEvent) | null = null;

/** Register the server-persist tagger (called once from agent.ts). */
export function setServerPersistTagger(fn: (event: StreamEvent) => StreamEvent): void {
  serverPersistTagger = fn;
}

/**
 * Broadcast a stream event to all renderer windows and web clients.
 *
 * This is the low-level broadcast — it sends the event to every
 * BrowserWindow and every connected web client. It does NOT include
 * usage-tracking side effects (those live in agent.ts). Approval events for a
 * CLI/headless-owned turn are tagged `serverPersisted` so a watching GUI won't
 * persist a partial branch.
 */
export function broadcastStreamEventRaw(event: StreamEvent): void {
  const tagged = serverPersistTagger ? serverPersistTagger(event) : event;
  // Per-recipient guarded fan-out: one window's send throwing must not abort delivery
  // to the rest or propagate to the caller — a raw loop that threw here could drop the
  // event on the run-owning renderer and leave a turn stuck (R106 finding-1).
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed?.() && !win.webContents?.isDestroyed?.()) {
        win.webContents.send('agent:stream-event', tagged);
      }
    } catch {
      /* window disappeared between check and send; keep fanning out */
    }
  }
  try {
    broadcastToWebClients('agent:stream-event', tagged);
  } catch {
    /* best-effort remote fan-out */
  }
}

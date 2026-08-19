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
import { redactBrowserToolArgsForExposure } from '../../shared/browser.js';

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

/**
 * Map of toolCallId → resolver.
 *
 * When a tool call needs user approval (e.g. ask_user, confirm-writes mode),
 * the caller registers a pending entry and awaits the returned Promise.
 * The IPC handlers in agent.ts resolve the entry when the user responds.
 */
export type ToolApprovalAuthority = 'any-renderer' | 'native-browser';

/** A pending approval that belongs to a Browser-authorized text or Realtime
 * turn. Realtime owners supply their own liveness check because they are not
 * represented in agent.ts's activeStreams map. */
export type ToolApprovalStreamOwner = {
  conversationId: string;
  streamToken: string;
  isCurrent?: () => boolean;
};

export type ToolApprovalPrivateDetails = {
  browserInput: unknown;
};

/** A pending approval. `resolve` accepts an optional CATEGORICAL settle `source`
 *  (R94, ask_user-race) so the IPC handler that settles the entry can name the
 *  true reason for the trace (answered vs approve vs abort vs duplicate-evict);
 *  when omitted it is derived from the resolved value. Also carries main's
 *  Browser/Realtime authority + streamOwner + one-shot pop-out plumbing. */
export type PendingToolApproval = {
  resolve: (approved: boolean | 'dismiss', source?: ApprovalSettleSource) => void;
  authority: ToolApprovalAuthority;
  streamOwner?: ToolApprovalStreamOwner;
  /** Exact Browser input shown only through the authority-checked native
   * approval-details IPC. Never include this value in stream events, logs,
   * persistence, observer output, or web-client broadcasts. */
  privateDetails?: ToolApprovalPrivateDetails;
  /** One-shot capability for the dedicated approval pop-out created for this
   * exact approval id. Deleted with the pending entry on every settle path. */
  approvalWindowWebContentsId?: number;
};

export const pendingToolApprovals = new Map<string, PendingToolApproval>();

/** Compose the conversation-scoped key for {@link pendingToolApprovals} and {@link approvalAuthorityById}
 *  (R192). Provider tool-call ids (e.g. `call_1`) are unique only WITHIN one provider response — a
 *  custom/local provider reuses `call_1` across conversations — so two concurrent conversations would
 *  collide in a globally raw-id-keyed map and the second registration would fail-close-evict the first's
 *  LIVE approval. Prefixing with the conversationId disambiguates. Falls back to the raw id when
 *  conversationId is absent (headless/legacy) so behavior is unchanged there. The renderer-facing WIRE id
 *  stays the raw toolCallId; each IPC/authority lookup composes this key from the conversationId at hand.
 *  Mirrors makeAnswerKey in ask-user.ts (same `::` scheme). */
export function approvalKey(conversationId: string | undefined, toolCallId: string): string {
  return conversationId ? `${conversationId}::${toolCallId}` : toolCallId;
}

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

/** DURABLE record of an approval's Browser/Realtime authority, keyed by toolCallId, that OUTLIVES
 *  the pending entry (R174). A browser-authorized ask_user's pending entry is DELETED on abort, but
 *  the raced-answer stash/recovery path still processes a late answer for that id — it must enforce
 *  the SAME authority so a non-primary web surface can't inject an answer into a browser-authorized
 *  successor/recovery turn. Bounded FIFO; entries are short-lived (one turn's recovery window). */
type ApprovalAuthorityRecord = Pick<PendingToolApproval, 'authority' | 'streamOwner' | 'approvalWindowWebContentsId'>;
const approvalAuthorityById = new Map<string, ApprovalAuthorityRecord>();
const APPROVAL_AUTHORITY_MAP_MAX = 500;
/** Returns the recorded authority for a toolCallId whose pending entry may already be gone (abort). */
export function getRecordedApprovalAuthority(toolCallId: string): ApprovalAuthorityRecord | undefined {
  return approvalAuthorityById.get(toolCallId);
}
function recordApprovalAuthority(toolCallId: string, record: ApprovalAuthorityRecord): void {
  // ALWAYS drop any prior record for this id FIRST (R175): tool-call ids are only unique within one
  // provider response — a custom/local provider can reuse `call_1`, so a NEW approval under a reused
  // id must not inherit the PRIOR one's Browser authority (which would wrongly reject a legitimate
  // non-primary answer to the new, non-browser approval).
  approvalAuthorityById.delete(toolCallId);
  // Only record when authority actually matters (native-browser OR a resolved streamOwner) — a
  // plain any-renderer approval has nothing to enforce after its pending entry is gone.
  if (record.authority !== 'native-browser' && !record.streamOwner) return;
  approvalAuthorityById.set(toolCallId, record);
  // FIFO-evict the oldest EVICTABLE record when over cap — but NEVER evict one whose approval is
  // still PENDING (R177): evicting a live browser-owned entry would leave the pendingless recovery
  // path with no authority to enforce, re-opening the R174 hole (a web client that saw the tool-call
  // id could then answer a browser-owned ask_user). Walk oldest→newest and drop the first entry that
  // is NOT a live pending approval; if every over-cap entry is pending (pathological — 500+ concurrent
  // browser approvals), leave the map slightly over cap rather than evict a live one.
  while (approvalAuthorityById.size > APPROVAL_AUTHORITY_MAP_MAX) {
    let evicted = false;
    for (const key of approvalAuthorityById.keys()) {
      if (!pendingToolApprovals.has(key)) {
        approvalAuthorityById.delete(key);
        evicted = true;
        break;
      }
    }
    if (!evicted) break; // all over-cap entries are live-pending; don't evict a live authority record
  }
}

/** Dismiss only native Browser policy prompts for one assistant owner. Generic
 * approvals remain live while the owning text/Realtime turn itself is current. */
export function dismissPendingNativeBrowserApprovalsForOwner(conversationId: string, browserOwnerId: string): void {
  for (const pending of pendingToolApprovals.values()) {
    const owner = pending.streamOwner;
    if (
      pending.authority === 'native-browser' &&
      owner?.conversationId === conversationId &&
      owner.streamToken === browserOwnerId
    ) {
      pending.resolve('dismiss');
    }
  }
}

type ApprovalOwnerResolver = (
  conversationId: string,
  browserOwnerId: string,
  authority: ToolApprovalAuthority,
) => ToolApprovalStreamOwner | undefined;

let approvalOwnerResolver: ApprovalOwnerResolver | null = null;
let rawApprovalWindowOpener: ((event: StreamEvent) => void) | null = null;
let rawApprovalWindowCloser: ((toolCallId: string) => void) | null = null;
let primaryApprovalWindowResolver: (() => BrowserWindow | null) | null = null;

/** Bind approval ownership to agent.ts without importing it here (which would
 * create an IPC/runtime cycle). */
export function setToolApprovalOwnerResolver(resolver: ApprovalOwnerResolver | null): void {
  approvalOwnerResolver = resolver;
}

/** Install the pop-out opener for approvals emitted through the low-level raw
 * broadcaster (Browser, MCP bridge, and Claude SDK tool paths). */
export function setRawApprovalWindowOpener(opener: ((event: StreamEvent) => void) | null): void {
  rawApprovalWindowOpener = opener;
}

/** Install the matching pop-out closer. Resolution can happen through abort,
 * duplicate eviction, Realtime teardown, or authority revocation without
 * passing through agent.ts's renderer IPC handlers. */
export function setRawApprovalWindowCloser(closer: ((toolCallId: string) => void) | null): void {
  rawApprovalWindowCloser = closer;
}

/** Browser-control prompts contain private page/action metadata. Route them
 * only to Kai's primary renderer and the exact one-shot approval pop-out. */
export function setPrimaryApprovalWindowResolver(resolver: (() => BrowserWindow | null) | null): void {
  primaryApprovalWindowResolver = resolver;
}

/** Grant the dedicated window created for this exact pending request authority
 * to resolve it. Returns false if registration has not happened yet, making a
 * broadcast-before-register regression fail closed. */
export function authorizePendingApprovalWindow(
  toolCallId: string,
  webContentsId: number,
  conversationId?: string,
): boolean {
  const key = approvalKey(conversationId, toolCallId);
  const pending = pendingToolApprovals.get(key);
  if (!pending || !Number.isSafeInteger(webContentsId) || webContentsId <= 0) return false;
  pending.approvalWindowWebContentsId = webContentsId;
  // Mirror onto the DURABLE authority record (R175) so a raced answer from the authorized pop-out is
  // still accepted after abort deletes the pending entry (the pendingless branch would otherwise only
  // accept the primary window, losing an answer submitted while the one-shot capability was valid).
  const record = approvalAuthorityById.get(key);
  if (record) record.approvalWindowWebContentsId = webContentsId;
  return true;
}

/** Look up a pending approval from a stream EVENT, honoring the conversation-scoped key (R192):
 *  compose conversationId::toolCallId, falling back to the raw id. Used by the broadcast-routing
 *  guards, which only have the event (whose toolCallId is the renderer-facing raw id). */
function lookupPendingByEvent(event: StreamEvent): PendingToolApproval | undefined {
  if (!event.toolCallId) return undefined;
  const composite = event.conversationId
    ? pendingToolApprovals.get(approvalKey(event.conversationId, event.toolCallId))
    : undefined;
  return composite ?? pendingToolApprovals.get(event.toolCallId);
}

/** Web clients cannot own the native Browser sidebar. Hide both Browser tool
 * approvals and generic question/plan approvals belonging to a Browser-
 * authorized stream; the IPC resolver separately enforces the same boundary. */
export function mayBroadcastApprovalToWebClients(event: StreamEvent): boolean {
  if (event.type !== 'tool-approval-required') return true;
  const approvalArgs =
    event.args && typeof event.args === 'object' && !Array.isArray(event.args)
      ? (event.args as Record<string, unknown>)
      : null;
  if (approvalArgs?.approvalKind === 'browser-control') return false;
  return !event.toolCallId || !lookupPendingByEvent(event)?.streamOwner;
}

/** Return the only Electron renderer ids allowed to receive a Browser-owned
 * approval, or null when the event is unrestricted. Both stream broadcasters
 * use this so generic question/plan approvals cannot leak through one path. */
export function resolveApprovalBroadcastWindowIds(event: StreamEvent): Set<number> | null {
  if (event.type !== 'tool-approval-required') return null;
  const approvalArgs =
    event.args && typeof event.args === 'object' && !Array.isArray(event.args)
      ? (event.args as Record<string, unknown>)
      : null;
  const pendingApproval = lookupPendingByEvent(event);
  const restricted =
    pendingApproval?.authority === 'native-browser' ||
    Boolean(pendingApproval?.streamOwner) ||
    approvalArgs?.approvalKind === 'browser-control';
  if (!restricted) return null;

  const authorizedWindowIds = new Set<number>();
  try {
    const primary = primaryApprovalWindowResolver?.();
    if (primary && !primary.isDestroyed() && !primary.webContents.isDestroyed()) {
      authorizedWindowIds.add(primary.webContents.id);
    }
  } catch {
    // Missing primary authority fails closed; an exact pop-out may still be authorized.
  }
  if (pendingApproval?.approvalWindowWebContentsId) {
    authorizedWindowIds.add(pendingApproval.approvalWindowWebContentsId);
  }
  return authorizedWindowIds;
}

export type ToolApprovalRegistrationContext = {
  conversationId?: string;
  browserOwnerId?: string;
  privateDetails?: ToolApprovalPrivateDetails;
};

/**
 * Register a pending approval for a tool call and return a Promise that
 * resolves when the user approves, rejects, or dismisses.
 *
 * If an `abortSignal` is provided, aborting a registered approval resolves it
 * with 'dismiss'. A signal already aborted at registration throws synchronously
 * so callers cannot broadcast UI for an approval that was never registered.
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
  authority: ToolApprovalAuthority = 'any-renderer',
  context?: ToolApprovalRegistrationContext,
  trace?: ApprovalTraceContext,
): Promise<boolean | 'dismiss'> {
  // Callers synchronously broadcast the approval UI immediately after this
  // function returns. Fail synchronously when cancellation already happened so
  // they cannot publish a prompt whose map entry was removed before the UI was
  // created. Once registration returns, the following broadcast is in the same
  // main-process turn and cannot race a later AbortController.abort().
  if (abortSignal?.aborted) {
    throw new Error('Tool approval was canceled before it could be registered.');
  }
  const hasExplicitBrowserOwner =
    typeof context?.conversationId === 'string' &&
    context.conversationId.length > 0 &&
    typeof context.browserOwnerId === 'string' &&
    context.browserOwnerId.length > 0;
  let streamOwner: ToolApprovalStreamOwner | undefined;
  if (hasExplicitBrowserOwner) {
    try {
      streamOwner = approvalOwnerResolver?.(context.conversationId!, context.browserOwnerId!, authority);
    } catch {
      streamOwner = undefined;
    }
  }
  // Browser policy prompts are capabilities of one exact text/Realtime run.
  // Target capture can await; if that owner was revoked during the await, do
  // not create an unowned native prompt after the revoker already swept the
  // pending map. Throw synchronously so the caller cannot broadcast a stale
  // approval card before observing the failure.
  if (authority === 'native-browser' && hasExplicitBrowserOwner && !streamOwner) {
    throw new Error('Browser approval is no longer authorized for this assistant turn.');
  }
  // The pending map is CONVERSATION-SCOPED (R192): key by conversationId::toolCallId so two concurrent
  // conversations reusing the same provider tool-call id (call_1) don't collide — the duplicate-evict
  // below would otherwise fail-close a FOREIGN conversation's live approval. The renderer-facing wire id
  // stays the raw toolCallId; every IPC/authority lookup composes this same key from its conversationId.
  const key = approvalKey(context?.conversationId, toolCallId);
  // A duplicate key would overwrite the map entry and orphan the prior
  // waiter's resolver forever (its Promise never settles → the earlier tool
  // call hangs). Settle any existing entry fail-closed (deny) before replacing.
  // Pass the explicit `duplicate-evict` source so the prior waiter's own settle
  // closure records exactly ONE settled event with that reason (not a spurious
  // extra `reject` on top of a separately-logged eviction). Because the key is now
  // conversation-scoped, this only evicts a genuine SAME-conversation same-id duplicate.
  const existing = pendingToolApprovals.get(key);
  if (existing) {
    existing.resolve(false, 'duplicate-evict');
    pendingToolApprovals.delete(key);
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
      pendingToolApprovals.delete(key);
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
      try {
        rawApprovalWindowCloser?.(toolCallId);
      } catch {
        // Approval settlement must not depend on an optional window surface.
      }
      resolve(value);
    };

    // The stored resolver (`settle`) forwards the explicit settle source (e.g. `answered` from
    // agent:answer-tool-question, `duplicate-evict` from an eviction) so the trace records the true
    // reason rather than one derived only from the value. Carries main's Browser/Realtime authority
    // + streamOwner + privateDetails.
    pendingToolApprovals.set(key, {
      resolve: settle,
      authority,
      ...(streamOwner ? { streamOwner } : {}),
      ...(context?.privateDetails ? { privateDetails: context.privateDetails } : {}),
    });
    // Record the authority DURABLY (R174) so the raced-answer recovery path can enforce it even
    // after abort deletes the pending entry above. Keyed by the SAME conversation-scoped key (R192).
    recordApprovalAuthority(key, { authority, streamOwner });

    // An already-aborted signal was rejected synchronously at the top of registerPendingApproval,
    // so here we only need to attach the listener for a future abort.
    abortSignal?.addEventListener('abort', onAbort, { once: true });
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
  const exposedEvent: StreamEvent =
    event.type === 'tool-call'
      ? { ...event, args: redactBrowserToolArgsForExposure(event.toolName, event.args) }
      : event;
  const tagged = serverPersistTagger ? serverPersistTagger(exposedEvent) : exposedEvent;
  if (event.type === 'tool-approval-required' && event.toolCallId) {
    // Callers register synchronously BEFORE broadcasting. That lets the opener
    // attach its exact webContents id to the pending entry before a renderer can
    // answer, closing both the response-before-registration race and the generic
    // Browser-approval bypass of the dedicated-window path.
    try {
      rawApprovalWindowOpener?.(event);
    } catch {
      // Approval remains available inline; never fail the tool because the
      // optional pop-out could not be created.
    }
  }
  const authorizedWindowIds = resolveApprovalBroadcastWindowIds(event);
  // Per-recipient guarded fan-out: one window's send throwing must not abort delivery to the rest
  // or propagate to the caller — a raw loop that threw here could drop the event on the run-owning
  // renderer and leave a turn stuck (R106 finding-1).
  for (const win of BrowserWindow.getAllWindows()) {
    if (authorizedWindowIds && !authorizedWindowIds.has(win.webContents.id)) continue;
    try {
      if (!win.isDestroyed?.() && !win.webContents?.isDestroyed?.()) {
        win.webContents.send('agent:stream-event', tagged);
      }
    } catch {
      /* window disappeared between check and send; keep fanning out */
    }
  }
  // Web clients cannot own or render the native Browser sidebar. Do not expose
  // an actionable-looking Browser approval card on a surface that is forbidden
  // from resolving it; the main-process resolver independently enforces the
  // same authority if a client invokes the raw channel anyway.
  if (mayBroadcastApprovalToWebClients(event)) {
    try {
      broadcastToWebClients('agent:stream-event', tagged);
    } catch {
      /* best-effort remote fan-out */
    }
  }
}

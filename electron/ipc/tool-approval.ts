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
import { redactBrowserToolArgsForExposure } from '../../shared/browser.js';

// ---------------------------------------------------------------------------
// Pending tool approvals
// ---------------------------------------------------------------------------

/**
 * Map of toolCallId → promise resolver.
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

export type PendingToolApproval = {
  resolve: (approved: boolean | 'dismiss') => void;
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

export type ToolApprovalPrivateDetails = {
  browserInput: unknown;
};

export const pendingToolApprovals = new Map<string, PendingToolApproval>();

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
export function authorizePendingApprovalWindow(toolCallId: string, webContentsId: number): boolean {
  const pending = pendingToolApprovals.get(toolCallId);
  if (!pending || !Number.isSafeInteger(webContentsId) || webContentsId <= 0) return false;
  pending.approvalWindowWebContentsId = webContentsId;
  return true;
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
  return !event.toolCallId || !pendingToolApprovals.get(event.toolCallId)?.streamOwner;
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
  const pendingApproval = event.toolCallId ? pendingToolApprovals.get(event.toolCallId) : undefined;
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
 */
export function registerPendingApproval(
  toolCallId: string,
  abortSignal?: AbortSignal,
  authority: ToolApprovalAuthority = 'any-renderer',
  context?: ToolApprovalRegistrationContext,
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
  // A duplicate toolCallId would overwrite the map entry and orphan the prior
  // waiter's resolver forever (its Promise never settles → the earlier tool
  // call hangs). Settle any existing entry fail-closed (deny) before replacing.
  const existing = pendingToolApprovals.get(toolCallId);
  if (existing) {
    existing.resolve(false);
    pendingToolApprovals.delete(toolCallId);
  }
  return new Promise<boolean | 'dismiss'>((resolve) => {
    // Wrap the stored resolver so EVERY resolution path (user approve/reject via
    // the IPC handler, abort, or duplicate-eviction) tears down the abort
    // listener + map entry exactly once. The abort listener was previously
    // {once:true} with no removal on the normal (approve/reject) path, so it
    // stayed attached to the (turn-scoped, reused per tool call) abortSignal
    // until the signal aborted — accumulating one listener per approved tool call.
    let settled = false;
    const onAbort = (): void => settle('dismiss');
    const settle = (value: boolean | 'dismiss'): void => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener('abort', onAbort);
      pendingToolApprovals.delete(toolCallId);
      try {
        rawApprovalWindowCloser?.(toolCallId);
      } catch {
        // Approval settlement must not depend on an optional window surface.
      }
      resolve(value);
    };

    pendingToolApprovals.set(toolCallId, {
      resolve: settle,
      authority,
      ...(streamOwner ? { streamOwner } : {}),
      ...(context?.privateDetails ? { privateDetails: context.privateDetails } : {}),
    });

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
  for (const win of BrowserWindow.getAllWindows()) {
    if (authorizedWindowIds && !authorizedWindowIds.has(win.webContents.id)) continue;
    win.webContents.send('agent:stream-event', tagged);
  }
  // Web clients cannot own or render the native Browser sidebar. Do not expose
  // an actionable-looking Browser approval card on a surface that is forbidden
  // from resolving it; the main-process resolver independently enforces the
  // same authority if a client invokes the raw channel anyway.
  if (mayBroadcastApprovalToWebClients(event)) {
    broadcastToWebClients('agent:stream-event', tagged);
  }
}

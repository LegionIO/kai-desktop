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
export const pendingToolApprovals = new Map<string, { resolve: (approved: boolean | 'dismiss') => void }>();

/**
 * Register a pending approval for a tool call and return a Promise that
 * resolves when the user approves, rejects, or dismisses.
 *
 * If an `abortSignal` is provided, aborting it will reject with 'dismiss'.
 */
export function registerPendingApproval(toolCallId: string, abortSignal?: AbortSignal): Promise<boolean | 'dismiss'> {
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
      resolve(value);
    };

    pendingToolApprovals.set(toolCallId, { resolve: settle });

    if (abortSignal) {
      if (abortSignal.aborted) {
        settle('dismiss');
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
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:stream-event', tagged);
  }
  broadcastToWebClients('agent:stream-event', tagged);
}

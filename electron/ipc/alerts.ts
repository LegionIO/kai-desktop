/**
 * Alerts IPC — the runtime layer over the pure `alert-store`.
 *
 * Automation (headless) runs raise alerts via the `request_review` tool or the
 * `ask_user` headless fallback. This module:
 *   - exposes `alerts:*` IPC (list/get/answer/decide/dismiss/unreadCount),
 *   - fires an OS notification + broadcasts `alerts:changed` when an alert is
 *     created (so the tab badge and optional front-most modal react live),
 *   - on answer/decide, re-injects the user's response as a NEW turn into the
 *     originating conversation (reusing the automation agent-run machinery via
 *     `resumeConversationWithMessage`) so the suspended run continues.
 *
 * Bridge parity: every channel here is mirrored in web-server.ts + preload.ts.
 */
import { BrowserWindow, Notification, type IpcMain } from 'electron';
import {
  createAlert,
  readAlert,
  listAlerts,
  openAlertCount,
  resolveAlert,
  dismissAlert,
  type Alert,
  type CreateAlertInput,
} from './alert-store.js';
import { resumeConversationWithMessage, type ActionDeps } from '../automations/actions.js';
import { setAlertCreatedHandler } from './alert-notify.js';
import { broadcastToWebClients } from '../web-server/web-clients.js';

/** Deps the alerts layer needs: where alerts live + how to resume a conversation. */
export interface AlertsDeps {
  appHome: string;
  /** Full automation ActionDeps so we can reuse `resumeConversationWithMessage`. */
  getActionDeps: () => ActionDeps;
  /** Whether the front-most-modal setting is on (config.automations.surfaceAlertsAsModal). */
  surfaceAsModal: () => boolean;
}

let deps: AlertsDeps | null = null;

/** Wire up the alerts layer. Called once from main.ts after the automation engine exists. */
export function initializeAlerts(d: AlertsDeps): void {
  deps = d;
  // Let the tools layer (request_review / ask_user fallback) trigger OS
  // notifications + UI broadcasts after it writes the alert store directly.
  setAlertCreatedHandler(notifyNewAlert);
}

/** Push an `alerts:changed` event to every window + web client (tab badge / modal host). */
function broadcastAlertsChanged(payload: { reason: 'created' | 'resolved' | 'dismissed'; alert?: Alert }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('alerts:changed', payload);
  }
  broadcastToWebClients('alerts:changed', payload);
}

/** Bring the main window front-most + focused (used when surfaceAlertsAsModal is on). */
function focusMainWindowForModal(): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // Briefly float it above other apps so a background automation alert is
  // immediately actionable, then release so it doesn't stay pinned.
  win.setAlwaysOnTop(true);
  setTimeout(() => {
    try {
      if (!win.isDestroyed()) win.setAlwaysOnTop(false);
    } catch {
      /* window gone */
    }
  }, 1500);
}

/**
 * Raise a new alert: persist it, notify the OS, broadcast to UIs, and (if the
 * setting is on and the alert needs an answer) surface a front-most modal.
 * This is the single entry point both `request_review` (via IPC-less direct
 * call is NOT used — the tool writes the store itself) and the ask_user
 * fallback funnel their notification through.
 */
export function raiseAlert(input: CreateAlertInput): Alert {
  if (!deps) throw new Error('alerts not initialized');
  const alert = createAlert(deps.appHome, input);
  notifyNewAlert(alert);
  return alert;
}

/** Fire the OS notification + broadcast + optional modal for an already-created alert.
 *  Exported as the hook `request_review` / the ask_user fallback call after they
 *  write the store directly (they live in the tools layer and can't import electron). */
export function notifyNewAlert(alert: Alert): void {
  const verb = alert.kind === 'fyi' ? 'Flagged for review' : alert.kind === 'approval' ? 'Approval needed' : 'Question';
  try {
    if (Notification.isSupported()) {
      new Notification({ title: `${verb}: ${alert.title}`, body: alert.body.slice(0, 240) }).show();
    }
  } catch {
    // Notifications can throw on some platforms/permission states — non-fatal.
  }
  broadcastAlertsChanged({ reason: 'created', alert });
  if (deps?.surfaceAsModal() && alert.kind !== 'fyi') {
    focusMainWindowForModal();
  }
}

/** Human-readable summary of a question answer, for re-injection as a user turn. */
function formatAnswer(alert: Alert, answer: Record<string, string>): string {
  const lines: string[] = [];
  const byHeader = new Map((alert.questions ?? []).map((q) => [q.header, q.question] as const));
  for (const [header, choice] of Object.entries(answer)) {
    const question = byHeader.get(header) ?? header;
    lines.push(`- ${question} → ${choice}`);
  }
  const body = lines.length ? lines.join('\n') : '(no answer provided)';
  return `[Answering your earlier question "${alert.title}"]\n${body}`;
}

function formatDecision(alert: Alert, decision: 'approve' | 'deny'): string {
  const action = alert.approvalAction ? ` for: ${alert.approvalAction}` : '';
  return decision === 'approve'
    ? `[Approved${action}] You may proceed.`
    : `[Denied${action}] Do not proceed; stop or choose a different course.`;
}

/** Append the user's response into the originating conversation and re-run the agent. */
async function resume(alert: Alert, userText: string): Promise<void> {
  if (!deps) throw new Error('alerts not initialized');
  await resumeConversationWithMessage(alert.conversationId, userText, deps.getActionDeps());
}

export function registerAlertsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('alerts:list', (_e, openOnly?: boolean) => {
    if (!deps) return [];
    return listAlerts(deps.appHome, !!openOnly);
  });

  ipcMain.handle('alerts:get', (_e, id: string) => {
    if (!deps) return null;
    return readAlert(deps.appHome, id);
  });

  ipcMain.handle('alerts:unreadCount', () => {
    if (!deps) return 0;
    return openAlertCount(deps.appHome);
  });

  ipcMain.handle('alerts:answer', async (_e, id: string, answer: Record<string, string>) => {
    if (!deps) return { ok: false, error: 'alerts not initialized' };
    if (!isValidAlertId(id)) return { ok: false, error: 'invalid alert id' };
    const clean = sanitizeAnswer(answer);
    if (!clean) return { ok: false, error: 'answer must be an object of { header: choice } strings' };
    // Enforce kind: only a `question` alert is answerable this way (an approval
    // must go through alerts:decide). Prevents cross-kind resolution.
    const existing = readAlert(deps.appHome, id);
    if (!existing) return { ok: false, error: 'alert not found' };
    if (existing.kind !== 'question') {
      return { ok: false, error: `alert ${id} is a "${existing.kind}", not a question` };
    }
    const resolved = resolveAlert(deps.appHome, id, clean);
    if (!resolved) return { ok: false, error: 'alert not open' };
    broadcastAlertsChanged({ reason: 'resolved', alert: resolved });
    // Resume in the background; don't make the UI wait on a full agent turn.
    void resume(resolved, formatAnswer(resolved, clean)).catch((err) => {
      console.error('[alerts] resume after answer failed:', err);
    });
    return { ok: true };
  });

  ipcMain.handle('alerts:decide', async (_e, id: string, decision: 'approve' | 'deny') => {
    if (!deps) return { ok: false, error: 'alerts not initialized' };
    if (!isValidAlertId(id)) return { ok: false, error: 'invalid alert id' };
    if (decision !== 'approve' && decision !== 'deny') {
      return { ok: false, error: "decision must be 'approve' or 'deny'" };
    }
    const existing = readAlert(deps.appHome, id);
    if (!existing) return { ok: false, error: 'alert not found' };
    if (existing.kind !== 'approval') {
      return { ok: false, error: `alert ${id} is a "${existing.kind}", not an approval` };
    }
    const resolved = resolveAlert(deps.appHome, id, decision);
    if (!resolved) return { ok: false, error: 'alert not open' };
    broadcastAlertsChanged({ reason: 'resolved', alert: resolved });
    void resume(resolved, formatDecision(resolved, decision)).catch((err) => {
      console.error('[alerts] resume after decision failed:', err);
    });
    return { ok: true };
  });

  ipcMain.handle('alerts:dismiss', (_e, id: string) => {
    if (!deps) return { ok: false, error: 'alerts not initialized' };
    if (!isValidAlertId(id)) return { ok: false, error: 'invalid alert id' };
    const dismissed = dismissAlert(deps.appHome, id);
    if (!dismissed) return { ok: false, error: 'alert not found' };
    broadcastAlertsChanged({ reason: 'dismissed', alert: dismissed });
    return { ok: true };
  });
}

/** Alert ids are UUIDs from randomUUID(); reject anything else (bounds + shape). */
function isValidAlertId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** Coerce an answer map to bounded `{ header: choice }` strings, or null if invalid.
 *  Guards against non-string/nested/oversized values reaching the store + resume prompt. */
function sanitizeAnswer(answer: unknown): Record<string, string> | null {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const entries = Object.entries(answer as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 20) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof k !== 'string' || k.length > 200) return null;
    if (typeof v !== 'string' || v.length > 2000) return null;
    out[k] = v;
  }
  return out;
}

/** Pure formatters + validators exposed for unit tests. */
export const __internal = { formatAnswer, formatDecision, isValidAlertId, sanitizeAnswer };

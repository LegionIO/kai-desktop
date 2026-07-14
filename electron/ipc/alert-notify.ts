/**
 * Tiny decoupling seam so the tools layer (`request_review`, ask_user fallback)
 * can trigger an alert OS-notification/broadcast WITHOUT importing electron.
 *
 * `electron/ipc/alerts.ts` registers the real handler on startup; the tools call
 * `notifyAlertCreated(alert)` after they write the alert store. If nothing is
 * registered yet (e.g. in a unit test), the call is a harmless no-op.
 */
import type { Alert } from './alert-store.js';

type AlertCreatedHandler = (alert: Alert) => void;

let handler: AlertCreatedHandler | null = null;

/** Called once by the alerts IPC layer at startup. */
export function setAlertCreatedHandler(fn: AlertCreatedHandler | null): void {
  handler = fn;
}

/** Fire the registered handler (OS notification + UI broadcast). No-op if unset. */
export function notifyAlertCreated(alert: Alert): void {
  try {
    handler?.(alert);
  } catch {
    // Notification failures must never break the tool that raised the alert.
  }
}

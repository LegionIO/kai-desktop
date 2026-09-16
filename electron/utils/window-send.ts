import { BrowserWindow } from 'electron';
import { broadcastToWebClients, hasRemoteConsumers } from '../web-server/web-clients.js';
import { hasRendererSubscribers } from './renderer-subscriptions.js';

export function safelySendToWindow(win: BrowserWindow, channel: string, data?: unknown): boolean {
  try {
    if (win.isDestroyed()) return false;

    const { webContents } = win;
    if (!webContents || webContents.isDestroyed() || webContents.isLoadingMainFrame()) {
      return false;
    }

    webContents.send(channel, data);
    return true;
  } catch {
    // Windows can disappear between checks and send calls during startup/shutdown.
    return false;
  }
}

export function broadcastToAllWindows(channel: string, data?: unknown): number {
  let sentCount = 0;
  // Best-effort window fan-out: enumeration can throw if the Electron BrowserWindow
  // module isn't available yet (very early bootstrap) — a broadcast must never abort
  // its caller (e.g. plugin loadAll publishing degraded state). Mirror the web-client
  // guard below.
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (safelySendToWindow(win, channel, data)) {
        sentCount += 1;
      }
    }
  } catch {
    /* window fan-out is best-effort */
  }
  // Best-effort remote fan-out: a throw here must not abort the caller after the
  // windows were already notified (R106 finding-1).
  try {
    broadcastToWebClients(channel, data);
  } catch {
    /* web-client fan-out is best-effort */
  }
  return sentCount;
}

/**
 * True when anything would actually consume a broadcast on `channel` — either a
 * renderer that explicitly subscribed, or any remote transport (web client / CLI
 * bridge sink).
 *
 * For use by HIGH-VOLUME channels only, as a guard before calling
 * `broadcastToAllWindows`. Each Electron broadcast deep-proxies its payload
 * across the contextBridge, so an unconsumed high-frequency event is pure
 * allocation churn in the renderer — enough of it exhausts the V8 heap.
 *
 * Fail-open by design: this returns true unless we positively know no renderer
 * subscribed. Only call it for a channel whose renderer-side subscribe/unsubscribe
 * is reported via `renderer-subscriptions`; for any other channel there is no
 * subscription state, `hasRendererSubscribers` is false, and gating on it would
 * wrongly drop events that a renderer receives through a plain `ipcRenderer.on`.
 */
export function hasAnyConsumer(channel: string): boolean {
  let remote = false;
  try {
    remote = hasRemoteConsumers();
  } catch {
    // Unknown remote state → assume a consumer exists rather than drop.
    remote = true;
  }
  return remote || hasRendererSubscribers(channel);
}

import { BrowserWindow } from 'electron';
import { broadcastToWebClients } from '../web-server/web-clients.js';

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

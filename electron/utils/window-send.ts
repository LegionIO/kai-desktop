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
  for (const win of BrowserWindow.getAllWindows()) {
    if (safelySendToWindow(win, channel, data)) {
      sentCount += 1;
    }
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

import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import { applyBrandUserAgent } from './utils/user-agent.js';
import { showMacDockWithPaddedIcon } from './utils/dock-icon.js';
import type { Alert } from './ipc/alert-store.js';

// Same app icon path as electron/main.ts + overlay-window.ts.
const APP_ICON = join(import.meta.dirname, '../build/icon.png');

/**
 * A dedicated pop-out window renders ANY actionable notification-tab item:
 *  - `tool-approval` — an interactive tool approval from a live chat
 *    (`ask_user` question form, or `exit_plan_mode`/generic approve-reject).
 *    Answered via the agent approve/reject/answer channels (resolves the awaiting
 *    turn in place).
 *  - `alert` — a persisted automation Alert (question/approval/fyi). Answered via
 *    the alerts channels (re-injects a new turn into the originating conversation).
 *
 * Both are keyed by a stable id and rendered by the same NotificationShell.
 */
export type NotificationWindowItem =
  | {
      source: 'tool-approval';
      /** The pending approval / ask_user id (the tool-approval-required toolCallId). */
      id: string;
      conversationId: string;
      toolName: string;
      /** Tool args — carries a `reason` (generic) or `questions` (ask_user). */
      args?: unknown;
    }
  | {
      source: 'alert';
      /** The alert id. */
      id: string;
      alert: Alert;
    };

/** Back-compat payload for the legacy approval-only entrypoint. */
export type ApprovalWindowRequest = {
  approvalId: string;
  conversationId: string;
  toolName: string;
  args?: unknown;
};

// The window that was focused just before we opened the pop-out (per id). On
// close we restore focus to it (only if it's still a live Kai window) instead of
// letting macOS auto-raise the main window — the user answered in the pop-out and
// doesn't want the main GUI to jump to the front.
const notificationPriorFocus = new Map<string, BrowserWindow | null>();
// Whether Kai was the frontmost APP (not just which Kai window) when the pop-out
// opened. If ANOTHER app (e.g. Chrome) was frontmost, answering + closing the
// pop-out should hand focus BACK to that app (app.hide on macOS) instead of
// leaving Kai raised. getFocusedWindow() only sees Kai's own windows, so we use
// app.isActive() captured at open (before the click/show fully activates Kai).
const notificationKaiWasFrontmost = new Map<string, boolean>();

// Deduped by item id — a repeat request for the same id focuses the existing
// window instead of opening a second one.
const notificationWindows = new Map<string, BrowserWindow>();
// The item payload per open window id, so the renderer can PULL it on mount
// (notif:get) rather than racing the push on ready-to-show (the renderer's React
// effect may not have subscribed yet when we send — that dropped the payload and
// left the window spinning forever).
const notificationItems = new Map<string, NotificationWindowItem>();

function loadNotificationRoute(win: BrowserWindow, query: Record<string, string>): void {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const rendererHtmlPath = join(import.meta.dirname, '../renderer/index.html');

  // Swallow load rejections: a load can fail/abort (ERR_ABORTED) if the window
  // is closed or navigated while loading — that must not surface as an unhandled
  // promise rejection. The window is cleaned up via its 'closed' handler.
  const onLoadErr = (err: unknown): void => {
    if (!win.isDestroyed()) {
      console.warn('[notification-window] failed to load route:', err instanceof Error ? err.message : err);
    }
  };
  if (rendererUrl) {
    const targetUrl = new URL(rendererUrl);
    for (const [key, value] of Object.entries(query)) {
      targetUrl.searchParams.set(key, value);
    }
    win.loadURL(targetUrl.toString()).catch(onLoadErr);
    return;
  }
  win.loadFile(rendererHtmlPath, { query }).catch(onLoadErr);
}

function safelySend(win: BrowserWindow, channel: string, data: unknown): void {
  try {
    if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  } catch {
    // Window/frame disposed between check and send — ignore.
  }
}

/**
 * Apply a renderer-reported content height (from the shell's ResizeObserver on
 * #notif-root) to the window that reported it, clamped to [MIN_H, 75% of the
 * work area]. Renderer-driven so we never race the content's layout/measure —
 * the shell reports its real height exactly when it settles (and again if it
 * changes, e.g. an ask_user tab switch). Width is left at the base (fixed).
 * Re-centers horizontally when height changes the position isn't needed, but we
 * keep the top offset.
 */
function applyReportedHeight(win: BrowserWindow, height: number): void {
  try {
    if (win.isDestroyed()) return;
    const display = screen.getDisplayMatching(win.getBounds());
    const [curW, curH] = win.getContentSize();
    const MIN_H = 120;
    const maxH = Math.floor(display.workArea.height * 0.75);
    const nextH = Math.min(Math.max(MIN_H, Math.ceil(height)), maxH);
    if (nextH === curH) return;
    win.setContentSize(curW, nextH);
  } catch {
    // best-effort — leave the current size
  }
}

/**
 * Open (or focus) the dedicated notification window for an item. Idempotent per
 * item id. show() (focus-grab) so the user can answer immediately; the main
 * window is never touched, and focus returns to the prior window on close.
 */
export function openNotificationWindow(item: NotificationWindowItem): BrowserWindow {
  // Store the payload so the renderer can pull it on mount (notif:get).
  notificationItems.set(item.id, item);
  // Remember what was focused before we steal focus, to restore it on close
  // (so answering doesn't leave the main Kai window raised). Only the FIRST open
  // for an id records it (a re-open shouldn't overwrite with our own window).
  if (!notificationPriorFocus.has(item.id)) {
    const prior = BrowserWindow.getFocusedWindow?.() ?? null;
    notificationPriorFocus.set(item.id, prior && !prior.isDestroyed?.() ? prior : null);
    // Was KAI the frontmost app right now (before show() activates it)? If not,
    // another app (Chrome, …) was — we'll hand focus back to it on close.
    let kaiFrontmost = false;
    try {
      // app.isActive() is macOS-only (present at runtime, not in the App type).
      const isActive = (app as unknown as { isActive?: () => boolean }).isActive;
      kaiFrontmost = typeof isActive === 'function' ? isActive.call(app) : prior !== null;
    } catch {
      kaiFrontmost = prior !== null;
    }
    notificationKaiWasFrontmost.set(item.id, kaiFrontmost);
  }
  const existing = notificationWindows.get(item.id);
  if (existing && !existing.isDestroyed()) {
    // Re-send the payload (renderer may have mounted late) and surface it.
    safelySend(existing, 'notif:request', item);
    if (!existing.isVisible()) existing.showInactive();
    return existing;
  }

  const preloadPath = join(import.meta.dirname, '../preload/index.mjs');
  const primary = screen.getPrimaryDisplay();
  const width = 460;
  // Alerts (esp. multi-question) need more room than a generic approve/reject.
  const height =
    item.source === 'alert' || (item.source === 'tool-approval' && item.toolName === 'ask_user') ? 420 : 300;
  // Top-center of the primary display — visible without covering the main
  // window's content area.
  const x = Math.round(primary.workArea.x + (primary.workArea.width - width) / 2);
  const y = Math.round(primary.workArea.y + 64);

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Kai — needs your input',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  applyBrandUserAgent(win.webContents);

  // Float above normal windows across Spaces so it's answerable without
  // switching to the main window.
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  loadNotificationRoute(win, { notif: '1', notifId: item.id });

  win.once('ready-to-show', () => {
    // FIFO surfacing: if another pop-out is already open + focused, don't steal
    // focus to this newer one — the user should answer the EARLIEST-raised first.
    // Show it (visible, on top) but inactive so the first pop-out keeps focus.
    const others = [...notificationWindows.values()].filter((w) => w !== win && !w.isDestroyed());
    const anotherFocused = others.some((w) => w.isFocused?.());
    if (anotherFocused) {
      win.showInactive();
    } else {
      win.show();
    }
    safelySend(win, 'notif:request', item);
    showMacDockWithPaddedIcon(APP_ICON);
    // Height is set by the renderer via notif:resize (ResizeObserver on
    // #notif-root) once its content has actually laid out — no measure-on-timer
    // race.
  });

  win.on('closed', () => {
    // Identity-guard the delete: only clear the map entry if it still points at
    // THIS window, so a late 'closed' from a replaced window can't evict a newer
    // window registered under the same id.
    if (notificationWindows.get(item.id) === win) {
      notificationWindows.delete(item.id);
      notificationItems.delete(item.id);
      // If the window was closed by some path other than closeNotificationWindow
      // (which already restores), still restore prior focus + clean up.
      if (notificationPriorFocus.has(item.id)) restorePriorFocus(item.id);
    }
  });

  notificationWindows.set(item.id, win);
  return win;
}

/**
 * After the pop-out closes, restore focus to whatever was focused before it
 * opened — rather than letting macOS auto-raise the main Kai window. If the prior
 * window is gone (or there was none), blur the main window that the OS may have
 * just raised so it doesn't stay in front. Runs on next tick so it overrides the
 * OS's post-destroy activation.
 */
function restorePriorFocus(id: string): void {
  const prior = notificationPriorFocus.get(id) ?? null;
  const kaiWasFrontmost = notificationKaiWasFrontmost.get(id) ?? true;
  notificationPriorFocus.delete(id);
  notificationKaiWasFrontmost.delete(id);
  setTimeout(() => {
    try {
      // If OTHER pop-out windows are still open (e.g. an approval + a question
      // popped together and the user just answered one), keep the notification
      // stack on top — focus the EARLIEST remaining pop-out (FIFO) so the user
      // works through them in the order they were raised, rather than restoring
      // the prior (main) window, which would sink the others behind it.
      const remaining = [...notificationWindows.values()].filter((w) => !w.isDestroyed());
      if (remaining.length > 0) {
        const next = remaining[0];
        if (BrowserWindow.getFocusedWindow?.() !== next) next.focus?.();
        return;
      }
      // Kai was NOT the frontmost app when the pop-out opened (the user was in
      // another app, e.g. Chrome). Hand focus back to that app instead of leaving
      // Kai raised — app.hide() (macOS) yields to the previously-active app.
      if (!kaiWasFrontmost && process.platform === 'darwin') {
        app?.hide?.();
        return;
      }
      if (prior && !prior.isDestroyed?.()) {
        // Only restore if it isn't already focused (avoid a redundant raise).
        if (BrowserWindow.getFocusedWindow?.() !== prior) prior.focus?.();
        return;
      }
      // No valid prior window: if the OS raised some Kai window as a side effect
      // of the close, blur it so answering the pop-out didn't pull the app front.
      const nowFocused = BrowserWindow.getFocusedWindow?.() ?? null;
      if (nowFocused && !nowFocused.isDestroyed?.()) nowFocused.blur?.();
    } catch {
      // best-effort
    }
  }, 0);
}

/** Close the notification window for an id once it's resolved/aborted. Idempotent. */
export function closeNotificationWindow(id: string): void {
  const win = notificationWindows.get(id);
  // Only manage focus if the POP-OUT WINDOW was actually the focused surface at
  // close time. When the user answers the INLINE card in the main GUI (which also
  // closes any pop-out via the dismissal-sync path), the pop-out was NOT focused —
  // restoring/blurring then would wrongly blur the main window they're using.
  const popoutWasFocused = Boolean(win && !win.isDestroyed() && win.isFocused?.());
  notificationWindows.delete(id);
  notificationItems.delete(id);
  if (win && !win.isDestroyed()) win.destroy();
  if (popoutWasFocused) restorePriorFocus(id);
  else {
    notificationPriorFocus.delete(id);
    notificationKaiWasFrontmost.delete(id);
  }
}

/** Close every notification window (app quit / conversation cancel). */
export function closeAllNotificationWindows(): void {
  for (const [id, win] of notificationWindows) {
    notificationWindows.delete(id);
    notificationItems.delete(id);
    notificationPriorFocus.delete(id);
    notificationKaiWasFrontmost.delete(id);
    if (!win.isDestroyed()) win.destroy();
  }
  notificationItems.clear();
}

export function hasNotificationWindow(id: string): boolean {
  const win = notificationWindows.get(id);
  return Boolean(win && !win.isDestroyed());
}

// ---------------------------------------------------------------------------
// Back-compat aliases (approval-only names) — kept for one release so existing
// call sites (ipc/agent.ts) + the `?approval=1` route keep working. New code
// should use the openNotificationWindow / closeNotificationWindow API.
// ---------------------------------------------------------------------------

export function openApprovalWindow(request: ApprovalWindowRequest): BrowserWindow {
  return openNotificationWindow({
    source: 'tool-approval',
    id: request.approvalId,
    conversationId: request.conversationId,
    toolName: request.toolName,
    args: request.args,
  });
}
export const closeApprovalWindow = closeNotificationWindow;
export const closeAllApprovalWindows = closeAllNotificationWindows;
export const hasApprovalWindow = hasNotificationWindow;

let closeIpcRegistered = false;
/**
 * Register the one IPC the notification window itself needs: a request from the
 * renderer to close its own window after it has posted the answer through the
 * existing agent approve/reject/answer or alerts channels. Call once at startup.
 */
export function registerNotificationWindowIpc(): void {
  if (closeIpcRegistered) return;
  closeIpcRegistered = true;
  const closeHandler = (_event: unknown, id: unknown): void => {
    if (typeof id === 'string' && id) closeNotificationWindow(id);
  };
  ipcMain.on('notif:close', closeHandler);
  // Back-compat channel (ApprovalShell during migration).
  ipcMain.on('approval:close', closeHandler);
  // Renderer pulls its item on mount — avoids the ready-to-show push racing the
  // renderer's not-yet-mounted subscription (which left the window spinning).
  ipcMain.handle('notif:get', (_event, id: unknown) =>
    typeof id === 'string' ? (notificationItems.get(id) ?? null) : null,
  );
  // Renderer reports its laid-out content height (ResizeObserver on #notif-root);
  // size the reporting window to it, clamped. Map sender → its BrowserWindow.
  ipcMain.on('notif:resize', (event, height: unknown) => {
    if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) applyReportedHeight(win, height);
  });
}
/** Back-compat alias. */
export const registerApprovalWindowIpc = registerNotificationWindowIpc;

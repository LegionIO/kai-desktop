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
      /** R252: the emitting run's nonce (streamToken/runGeneration). Two OVERLAPPING runs in the same
       *  conversation can each mint `call_1`; without the nonce they'd share one pop-out window and the later
       *  request would overwrite the earlier's payload / settling either would close the shared surface. */
      runNonce?: string;
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
  runNonce?: string;
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

/** Registry key for the pop-out maps (R193/R252). A `tool-approval` item's `id` is the provider tool-call id
 *  (e.g. `call_1`), unique only WITHIN one provider response — two concurrent conversations, OR two OVERLAPPING
 *  runs in the same conversation, can share it — so scope it by conversationId AND the run nonce when present.
 *  An `alert` item's id is a globally-unique alert id, used as-is. Mirrors the run-scoped key used for the
 *  pending-approval map (approvalKey). */
function notifKey(item: NotificationWindowItem): string {
  if (item.source !== 'tool-approval') return item.id;
  return notifKeyFromParts(item.id, item.conversationId, item.runNonce);
}
/** Compose the same key from raw parts, for lookups that only have the id (+ optional conversationId/runNonce). */
function notifKeyFromParts(id: string, conversationId?: string, runNonce?: string): string {
  if (conversationId && runNonce) return `${conversationId}::${runNonce}::${id}`;
  return conversationId ? `${conversationId}::${id}` : id;
}

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
  // All pop-out registries are keyed by the conversation-scoped notifKey (R193) so two concurrent
  // conversations sharing a raw tool-call id get distinct windows/payloads/focus records.
  const key = notifKey(item);
  // Store the payload so the renderer can pull it on mount (notif:get).
  notificationItems.set(key, item);
  // Remember what was focused before we steal focus, to restore it on close
  // (so answering doesn't leave the main Kai window raised). Only the FIRST open
  // for an id records it (a re-open shouldn't overwrite with our own window).
  if (!notificationPriorFocus.has(key)) {
    const prior = BrowserWindow.getFocusedWindow?.() ?? null;
    notificationPriorFocus.set(key, prior && !prior.isDestroyed?.() ? prior : null);
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
    notificationKaiWasFrontmost.set(key, kaiFrontmost);
  }
  const existing = notificationWindows.get(key);
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

  loadNotificationRoute(win, {
    notif: '1',
    notifId: item.id,
    ...(item.source === 'tool-approval' ? { notifConv: item.conversationId } : {}),
    // R253: carry the run nonce into the pop-out route so the renderer echoes it back on notif:get / close /
    // approval-resolve — the registry key is conversationId::runNonce::id, and with TWO overlapping windows the
    // nonce-less scan is ambiguous, so the renderer MUST supply the nonce to target its own window.
    ...(item.source === 'tool-approval' && item.runNonce ? { notifNonce: item.runNonce } : {}),
  });

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
    // window registered under the same key.
    if (notificationWindows.get(key) === win) {
      notificationWindows.delete(key);
      notificationItems.delete(key);
      // If the window was closed by some path other than closeNotificationWindow
      // (which already restores), still restore prior focus + clean up.
      if (notificationPriorFocus.has(key)) restorePriorFocus(key);
    }
  });

  notificationWindows.set(key, win);
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

/** R252: resolve the ACTUAL registry key for a tool-approval close/has, honoring the run-scoped key:
 *  run-scoped (conversationId + runNonce) → conversation-scoped → an UNAMBIGUOUS
 *  `${conversationId}::<nonce>::${id}` scan (so a nonce-less close still hits the single matching run-scoped
 *  window). Returns undefined when nothing matches. Only for tool-approval (conversationId present); an alert
 *  close passes no conversationId and uses the raw id directly. */
function resolveNotifKey(id: string, conversationId?: string, runNonce?: string): string | undefined {
  if (!conversationId) return notificationWindows.has(id) ? id : undefined;
  if (runNonce) {
    const k = notifKeyFromParts(id, conversationId, runNonce);
    if (notificationWindows.has(k)) return k;
  }
  const conv = notifKeyFromParts(id, conversationId);
  if (notificationWindows.has(conv)) return conv;
  const prefix = `${conversationId}::`;
  const suffix = `::${id}`;
  let match: string | undefined;
  let ambiguous = false;
  for (const key of notificationWindows.keys()) {
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    const middle = key.slice(prefix.length, key.length - suffix.length);
    if (middle.length === 0 || middle.includes('::')) continue;
    if (match !== undefined) {
      ambiguous = true;
      break;
    }
    match = key;
  }
  return ambiguous ? undefined : match;
}

/** Close the notification window for an id once it's resolved/aborted. Idempotent. For a tool-approval
 *  pass the `conversationId` (+ optional runNonce, R252) so the run-scoped key resolves. When conversationId is
 *  provided the key is EXACT / scoped (no raw fallback) — a scoped tool-approval close must never fall back to
 *  the raw namespace and match an unrelated ALERT whose UUID happens to equal the tool-call id (R195). The raw
 *  key is used only for a call WITHOUT conversationId (alerts, whose id is globally unique; legacy). */
export function closeNotificationWindow(id: string, conversationId?: string, runNonce?: string): void {
  const key = conversationId ? resolveNotifKey(id, conversationId, runNonce) : id;
  if (!key) return;
  const win = notificationWindows.get(key);
  // Only manage focus if the POP-OUT WINDOW was actually the focused surface at
  // close time. When the user answers the INLINE card in the main GUI (which also
  // closes any pop-out via the dismissal-sync path), the pop-out was NOT focused —
  // restoring/blurring then would wrongly blur the main window they're using.
  const popoutWasFocused = Boolean(win && !win.isDestroyed() && win.isFocused?.());
  notificationWindows.delete(key);
  notificationItems.delete(key);
  if (win && !win.isDestroyed()) win.destroy();
  if (popoutWasFocused) restorePriorFocus(key);
  else {
    notificationPriorFocus.delete(key);
    notificationKaiWasFrontmost.delete(key);
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

export function hasNotificationWindow(id: string, conversationId?: string, runNonce?: string): boolean {
  // Scoped (no raw fallback) so a scoped query can't match an unrelated raw/alert entry (R195); run-scoped
  // resolution with an unambiguous scan for a nonce-less caller (R252).
  const key = conversationId ? resolveNotifKey(id, conversationId, runNonce) : id;
  const win = key ? notificationWindows.get(key) : undefined;
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
    runNonce: request.runNonce,
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
  const closeHandler = (_event: unknown, id: unknown, conversationId?: unknown, runNonce?: unknown): void => {
    if (typeof id === 'string' && id) {
      closeNotificationWindow(
        id,
        typeof conversationId === 'string' ? conversationId : undefined,
        typeof runNonce === 'string' ? runNonce : undefined,
      );
    }
  };
  ipcMain.on('notif:close', closeHandler);
  // Back-compat channel (ApprovalShell during migration).
  ipcMain.on('approval:close', closeHandler);
  // Renderer pulls its item on mount — avoids the ready-to-show push racing the
  // renderer's not-yet-mounted subscription (which left the window spinning). The
  // pop-out route carries notifId + (for tool-approvals) notifConv + notifNonce so we resolve the
  // run-scoped key, falling back to conversation-scoped / raw (alerts / legacy) (R193/R253).
  ipcMain.handle('notif:get', (_event, id: unknown, conversationId?: unknown, runNonce?: unknown) => {
    if (typeof id !== 'string') return null;
    // Scoped (no raw fallback) so a scoped tool-approval pull can't return an unrelated alert whose id equals
    // the tool-call id (R195); run-scoped resolution with an unambiguous scan for a nonce-less caller (R253).
    const convId = typeof conversationId === 'string' && conversationId ? conversationId : undefined;
    const nonce = typeof runNonce === 'string' && runNonce ? runNonce : undefined;
    const key = convId ? resolveNotifKey(id, convId, nonce) : id;
    return key ? (notificationItems.get(key) ?? null) : null;
  });
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

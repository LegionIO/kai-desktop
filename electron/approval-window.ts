import { BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { applyBrandUserAgent } from './utils/user-agent.js';
import { showMacDockWithPaddedIcon } from './utils/dock-icon.js';

// TEMP debug instrumentation (approval window path). Remove once diagnosed.
const APPROVAL_DEBUG_LOG = join(import.meta.dirname, '../../debug-logs/approval.log');
function approvalDebug(msg: string): void {
  try {
    appendFileSync(APPROVAL_DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* best-effort */
  }
}
/** Focused-window title for logs; defensive (BrowserWindow may be a test mock). */
function focusedWindowTitle(): string {
  try {
    return BrowserWindow.getFocusedWindow?.()?.getTitle?.() ?? 'none';
  } catch {
    return 'unknown';
  }
}

// Same app icon path as electron/main.ts + overlay-window.ts.
const APP_ICON = join(import.meta.dirname, '../build/icon.png');

/** Payload the approval window renders. Mirrors the tool-approval-required event. */
export type ApprovalWindowRequest = {
  approvalId: string;
  conversationId: string;
  toolName: string;
  /** Tool args — may carry a human-readable `reason` and (for ask_user) questions. */
  args?: unknown;
};

/**
 * Open approval prompts in their own small always-on-top window so answering
 * one does not raise/disturb the main Kai window. Flag-gated by
 * `ui.approvals.dedicatedWindow`; the inline in-thread card remains the
 * baseline and still resolves the same pendingToolApprovals entry, so whichever
 * surface the user answers first wins (the main-process resolve is idempotent).
 *
 * Deduped by approvalId — a repeat request for the same id focuses the existing
 * window instead of opening a second one.
 */
const approvalWindows = new Map<string, BrowserWindow>();

function loadApprovalRoute(win: BrowserWindow, query: Record<string, string>): void {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const rendererHtmlPath = join(import.meta.dirname, '../renderer/index.html');

  // Swallow load rejections: a load can fail/abort (ERR_ABORTED) if the window
  // is closed or navigated while loading — that must not surface as an unhandled
  // promise rejection. The window is cleaned up via its 'closed' handler.
  const onLoadErr = (err: unknown): void => {
    if (!win.isDestroyed()) {
      console.warn('[approval-window] failed to load route:', err instanceof Error ? err.message : err);
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
 * Open (or focus) the dedicated approval window for a request. Returns the
 * window. Idempotent per approvalId.
 */
export function openApprovalWindow(request: ApprovalWindowRequest): BrowserWindow {
  const existing = approvalWindows.get(request.approvalId);
  if (existing && !existing.isDestroyed()) {
    // Re-send the payload (renderer may have mounted late) and surface it.
    safelySend(existing, 'approval:request', request);
    if (!existing.isVisible()) existing.showInactive();
    return existing;
  }

  const preloadPath = join(import.meta.dirname, '../preload/index.mjs');
  const primary = screen.getPrimaryDisplay();
  const width = 460;
  const height = 300;
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
    title: 'Kai — approval required',
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

  loadApprovalRoute(win, { approval: '1', approvalId: request.approvalId });
  approvalDebug(
    `open approvalId=${request.approvalId} conv=${request.conversationId} tool=${request.toolName} rendererUrl=${process.env.ELECTRON_RENDERER_URL ?? '(file)'} focusedBefore=${focusedWindowTitle()}`,
  );

  win.once('ready-to-show', () => {
    approvalDebug(`ready-to-show approvalId=${request.approvalId}`);
    // show() (not showInactive) so the user can answer immediately, but we never
    // touch the main window, so it stays where it was (minimized/behind).
    win.show();
    safelySend(win, 'approval:request', request);
    showMacDockWithPaddedIcon(APP_ICON);
  });

  win.on('closed', () => {
    approvalDebug(`closed approvalId=${request.approvalId}`);
    // Identity-guard the delete: only clear the map entry if it still points at
    // THIS window, so a late 'closed' from a replaced window can't evict a newer
    // window registered under the same approvalId.
    if (approvalWindows.get(request.approvalId) === win) {
      approvalWindows.delete(request.approvalId);
    }
  });

  approvalWindows.set(request.approvalId, win);
  return win;
}

/** Close the approval window for an id once it's resolved/aborted. Idempotent. */
export function closeApprovalWindow(approvalId: string): void {
  const win = approvalWindows.get(approvalId);
  approvalDebug(`closeApprovalWindow approvalId=${approvalId} found=${Boolean(win && !win.isDestroyed())}`);
  approvalWindows.delete(approvalId);
  if (win && !win.isDestroyed()) win.destroy();
}

/** Close every approval window (app quit / conversation cancel). */
export function closeAllApprovalWindows(): void {
  for (const [id, win] of approvalWindows) {
    approvalWindows.delete(id);
    if (!win.isDestroyed()) win.destroy();
  }
}

export function hasApprovalWindow(approvalId: string): boolean {
  const win = approvalWindows.get(approvalId);
  return Boolean(win && !win.isDestroyed());
}

let closeIpcRegistered = false;
/**
 * Register the one IPC the approval window itself needs: a request from the
 * renderer to close its own approval window after it has posted the answer
 * through the existing agent:approve/reject/answer channels. Call once at
 * startup. The answer channels themselves are already registered by ipc/agent.
 */
export function registerApprovalWindowIpc(): void {
  if (closeIpcRegistered) return;
  closeIpcRegistered = true;
  ipcMain.on('approval:close', (_event, approvalId: unknown) => {
    if (typeof approvalId === 'string' && approvalId) closeApprovalWindow(approvalId);
  });
}

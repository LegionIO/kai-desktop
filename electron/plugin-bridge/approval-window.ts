import { BrowserWindow, nativeTheme, screen } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BridgeApprovalPrompt } from '../../shared/bridge-approval.js';

const active = new WeakMap<BrowserWindow, BrowserWindow>();

/** A separate, sandboxed renderer owns consent. The primary renderer can ask
 * for a review, but neither its plugins nor general IPC can answer it. */
export function showBridgeApproval(
  parent: BrowserWindow,
  title: string,
  detail: string,
  theme: 'light' | 'dark' | 'system',
): Promise<boolean> {
  if (parent.isDestroyed()) return Promise.resolve(false);
  const existing = active.get(parent);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    // Never let a second request reuse the first request's decision.
    return Promise.resolve(false);
  }
  const area = screen.getDisplayMatching(parent.getBounds()).workArea;
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  const prompt: BridgeApprovalPrompt = { id: randomUUID(), title, detail, dark };
  const win = new BrowserWindow({
    parent,
    modal: true,
    width: Math.min(600, Math.floor(area.width * 0.9)),
    height: Math.min(detail.length > 600 ? 580 : 360, Math.floor(area.height * 0.8)),
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    title: 'Kai — Plugin Bridge approval',
    backgroundColor: dark ? '#181710' : '#faf9f5',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/bridge-approval.cjs'),
      partition: `kai-bridge-approval-${prompt.id}`,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  active.set(parent, win);
  const route = process.env.ELECTRON_RENDERER_URL
    ? new URL('bridge-approval/index.html', process.env.ELECTRON_RENDERER_URL).href
    : pathToFileURL(join(import.meta.dirname, '../renderer/bridge-approval/index.html')).href;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      active.delete(parent);
      parent.removeListener('closed', cancel);
      if (!win.isDestroyed()) win.destroy();
      resolve(approved);
    };
    const cancel = () => finish(false);
    const timeout = setTimeout(cancel, 5 * 60_000);
    timeout.unref();
    const assertOwner = (event: IpcMainInvokeEvent) => {
      if (
        settled ||
        win.isDestroyed() ||
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame ||
        event.senderFrame.url !== route
      )
        throw new Error('This approval belongs to a different window or has expired.');
    };
    // WebContents-scoped handlers are not reachable through primary-window,
    // browser, plugin, MCP or local-socket IPC.
    win.webContents.ipc.handle('bridge-approval:read', (event) => {
      assertOwner(event);
      return prompt;
    });
    win.webContents.ipc.handle('bridge-approval:decide', (event, id: unknown, approved: unknown) => {
      assertOwner(event);
      if (id !== prompt.id || typeof approved !== 'boolean') throw new Error('Invalid approval decision.');
      finish(approved);
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    win.webContents.on('will-navigate', (event) => {
      event.preventDefault();
      cancel();
    });
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.once('render-process-gone', cancel);
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    });
    parent.once('closed', cancel);
    win.once('closed', cancel);
    win.once('ready-to-show', () => {
      if (!settled) win.show();
    });
    void win.loadURL(route).catch(cancel);
  });
}

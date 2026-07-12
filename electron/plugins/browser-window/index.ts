import { join } from 'path';
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  MenuItem,
  session,
  shell,
  type Session,
  type WebContents,
} from 'electron';

import type { CodePaths } from '../../ota/types.js';
import type { PluginBrowserWindowOptions } from '../types.js';
import { getBrandUserAgent } from '../../utils/user-agent.js';
import { PB, type AuthSubmitPayload, type DownloadPayload, type ShortcutAction } from './ipc.js';

let codePaths: CodePaths | null = null;
let globalsRegistered = false;

const pluginBrowserWindows = new Set<BrowserWindow>();
const windowGuests = new Map<BrowserWindow, Set<number>>();
const guestIds = new Set<number>();
const downloadWiredSessions = new WeakSet<Session>();
const permissionWiredSessions = new WeakSet<Session>();
const zoomByPartition = new Map<string, number>();
const pendingAuth = new Map<number, { cb: (username?: string, password?: string) => void; owner: BrowserWindow }>();
let authReqCounter = 0;
let downloadIdCounter = 0;

const GUEST_ALLOWED_PERMISSIONS = ['clipboard-read', 'clipboard-sanitized-write'];

/**
 * Force safe webPreferences on an attaching <webview> guest and strip any tag
 * attributes that could re-enable Node or inject a preload. Called from the
 * chrome window's `will-attach-webview` handler (fires before the guest
 * webContents exists, so it cannot be bypassed by attributes on the tag).
 * Exported for direct unit testing of the hardening invariants.
 *
 * `webPreferences` and `params` are the mutable objects Electron hands the
 * `will-attach-webview` event; the loose typing mirrors that event's signature.
 */
export function hardenWebviewAttach(webPreferences: Record<string, unknown>, params: Record<string, unknown>): void {
  // A preload here would run inside the untrusted guest — never allow one.
  delete webPreferences.preload;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  // Strip tag attributes that would otherwise re-enable Node / inject a preload
  // on the guest regardless of the webPreferences above.
  delete params.nodeintegration;
  delete params.nodeintegrationinsubframes;
  delete params.preload;
  delete params.webpreferences;
}

function isHttpUrl(u: string): boolean {
  return typeof u === 'string' && /^https?:\/\//i.test(u);
}

export function initPluginBrowser(paths: CodePaths): void {
  codePaths = paths;
  registerGlobalHandlers();
}

export function openPluginBrowserWindow(options: PluginBrowserWindowOptions): void {
  if (!codePaths) {
    throw new Error('plugin browser not initialized (initPluginBrowser was not called)');
  }

  const { url, title = 'Browser', width = 1280, height = 900, partition, customUserAgent } = options;

  // Never share the app's default session with arbitrary guest content.
  const effectivePartition = partition || 'persist:kai-plugin-browser';
  const ses = session.fromPartition(effectivePartition);
  wireSessionDownloads(ses);
  if (!permissionWiredSessions.has(ses)) {
    permissionWiredSessions.add(ses);
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(GUEST_ALLOWED_PERMISSIONS.includes(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => GUEST_ALLOWED_PERMISSIONS.includes(permission));
  }

  const ua =
    customUserAgent === false ? undefined : typeof customUserAgent === 'string' ? customUserAgent : getBrandUserAgent();

  const win = new BrowserWindow({
    width,
    height,
    title,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true,
      session: ses,
      preload: join(codePaths.preload, 'plugin-browser.mjs'),
    },
  });

  pluginBrowserWindows.add(win);
  windowGuests.set(win, new Set());
  win.on('closed', () => {
    pluginBrowserWindows.delete(win);
    for (const id of windowGuests.get(win) ?? []) guestIds.delete(id);
    windowGuests.delete(win);
    for (const [authId, entry] of pendingAuth) {
      if (entry.owner === win) {
        pendingAuth.delete(authId);
        entry.cb();
      }
    }
  });

  win.webContents.on('before-input-event', makeKeyHandler(win));

  // Harden every <webview> the chrome page attaches: it renders UNTRUSTED web
  // pages, so force safe guest webPreferences and strip anything (a preload, or
  // an attacker-influenced nodeintegration attribute) that could hand the remote
  // page Node/RCE. The chrome page itself is app-authored, but this is the
  // defense-in-depth chokepoint Electron recommends for webview hosts — it fires
  // BEFORE the guest webContents is created, so it can't be bypassed by tag attrs.
  win.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    hardenWebviewAttach(
      webPreferences as unknown as Record<string, unknown>,
      params as unknown as Record<string, unknown>,
    );
  });

  win.webContents.on('did-attach-webview', (_event, guest) => {
    guestIds.add(guest.id);
    windowGuests.get(win)?.add(guest.id);
    guest.on('destroyed', () => {
      guestIds.delete(guest.id);
      windowGuests.get(win)?.delete(guest.id);
    });

    guest.setWindowOpenHandler(({ url: newUrl, disposition }) => {
      if (newUrl && newUrl !== 'about:blank') {
        sendToChrome(win, PB.openTab, { url: newUrl, background: disposition === 'background-tab' });
      }
      return { action: 'deny' };
    });

    guest.on('context-menu', (_e, params) => {
      buildGuestContextMenu(win, guest, params).popup({ window: win });
    });

    guest.on('before-input-event', makeKeyHandler(win));
  });

  const query: Record<string, string> = {
    url,
    home: 'about:blank',
    partition: effectivePartition,
    ua: ua ?? '',
  };

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    const target = new URL('browser-chrome/index.html', rendererUrl.endsWith('/') ? rendererUrl : rendererUrl + '/');
    for (const [k, v] of Object.entries(query)) target.searchParams.set(k, v);
    void win.loadURL(target.toString());
  } else {
    void win.loadFile(join(codePaths.renderer, 'browser-chrome/index.html'), { query });
  }
}

function sendToChrome(win: BrowserWindow, channel: string, payload: unknown): void {
  if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function ownerWindowOf(guest: WebContents): BrowserWindow | null {
  for (const [win, ids] of windowGuests) {
    if (ids.has(guest.id)) return win;
  }
  const host = guest.hostWebContents;
  return host ? BrowserWindow.fromWebContents(host) : null;
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts (#2): runs on chrome AND every guest webContents.
// preventDefault() blocks the global app menu accelerators so e.g. ⌘R reloads
// the active guest tab, not the chrome page.
// ---------------------------------------------------------------------------
function makeKeyHandler(win: BrowserWindow) {
  const isMac = process.platform === 'darwin';
  return (event: Electron.Event, input: Electron.Input): void => {
    if (input.type !== 'keyDown') return;
    const mod = isMac ? input.meta : input.control;
    if (!mod) return;

    let action: ShortcutAction | null = null;
    let arg: number | undefined;
    const key = input.key;

    if (input.alt) {
      if (key === 'i' || key === 'I') action = 'devtools';
    } else if (input.shift) {
      switch (key) {
        case 'T':
        case 't':
          action = 'reopen-tab';
          break;
        case 'R':
        case 'r':
          action = 'hard-reload';
          break;
        case 'G':
        case 'g':
          action = 'find-prev';
          break;
      }
    } else {
      switch (key) {
        case 'f':
        case 'F':
          action = 'find';
          break;
        case 'g':
        case 'G':
          action = 'find-next';
          break;
        case 't':
        case 'T':
          action = 'new-tab';
          break;
        case 'w':
        case 'W':
          action = 'close-tab';
          break;
        case 'l':
        case 'L':
          action = 'focus-url';
          break;
        case 'r':
        case 'R':
          action = 'reload';
          break;
        case '[':
          action = 'back';
          break;
        case ']':
          action = 'forward';
          break;
        case 'ArrowLeft':
          action = 'back';
          break;
        case 'ArrowRight':
          action = 'forward';
          break;
        case '=':
        case '+':
          action = 'zoom-in';
          break;
        case '-':
          action = 'zoom-out';
          break;
        case '0':
          action = 'zoom-reset';
          break;
        case '9':
          action = 'tab-last';
          break;
        default:
          if (key >= '1' && key <= '8') {
            action = 'tab-n';
            arg = Number(key) - 1;
          }
      }
    }

    if (!action) return;
    event.preventDefault();
    sendToChrome(win, PB.shortcut, { action, arg });
  };
}

// ---------------------------------------------------------------------------
// Context menu (#3)
// ---------------------------------------------------------------------------
function buildGuestContextMenu(win: BrowserWindow, guest: WebContents, p: Electron.ContextMenuParams): Menu {
  const menu = new Menu();
  const nav = guest.navigationHistory;

  menu.append(new MenuItem({ label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() }));
  menu.append(new MenuItem({ label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() }));
  menu.append(new MenuItem({ label: 'Reload', click: () => guest.reload() }));
  menu.append(new MenuItem({ type: 'separator' }));

  if (p.linkURL) {
    menu.append(
      new MenuItem({
        label: 'Open Link in New Tab',
        click: () => sendToChrome(win, PB.openTab, { url: p.linkURL, background: false }),
      }),
    );
    if (isHttpUrl(p.linkURL)) {
      menu.append(
        new MenuItem({
          label: 'Open Link in Default Browser',
          click: () => void shell.openExternal(p.linkURL),
        }),
      );
    }
    menu.append(new MenuItem({ label: 'Copy Link Address', click: () => clipboard.writeText(p.linkURL) }));
    menu.append(new MenuItem({ type: 'separator' }));
  }

  if (p.mediaType === 'image' && p.srcURL) {
    menu.append(new MenuItem({ label: 'Copy Image', click: () => guest.copyImageAt(p.x, p.y) }));
    menu.append(new MenuItem({ label: 'Save Image As…', click: () => guest.downloadURL(p.srcURL) }));
    menu.append(new MenuItem({ type: 'separator' }));
  }

  if (p.isEditable) {
    menu.append(new MenuItem({ label: 'Cut', role: 'cut', enabled: p.editFlags.canCut }));
    menu.append(new MenuItem({ label: 'Copy', role: 'copy', enabled: p.editFlags.canCopy }));
    menu.append(new MenuItem({ label: 'Paste', role: 'paste', enabled: p.editFlags.canPaste }));
    menu.append(new MenuItem({ label: 'Select All', role: 'selectAll' }));
    menu.append(new MenuItem({ type: 'separator' }));
  } else if (p.selectionText) {
    menu.append(new MenuItem({ label: 'Copy', role: 'copy' }));
    menu.append(new MenuItem({ type: 'separator' }));
  }

  menu.append(new MenuItem({ label: 'Inspect Element', click: () => guest.inspectElement(p.x, p.y) }));
  return menu;
}

// ---------------------------------------------------------------------------
// Downloads (#6)
// ---------------------------------------------------------------------------
function wireSessionDownloads(ses: Session): void {
  if (downloadWiredSessions.has(ses)) return;
  downloadWiredSessions.add(ses);

  ses.on('will-download', (_event, item, webContents) => {
    const owner = ownerWindowOf(webContents);
    if (!owner) return;

    const id = ++downloadIdCounter;
    const filename = item.getFilename();
    const total = item.getTotalBytes();

    item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), filename) });

    const send = (state: DownloadPayload['state']) =>
      sendToChrome(owner, PB.download, {
        id,
        filename,
        received: item.getReceivedBytes(),
        total,
        state,
        path: item.getSavePath(),
      });

    item.on('updated', () => send('progressing'));
    item.on('done', (_e, state) => send(state));
  });
}

// ---------------------------------------------------------------------------
// Global one-time handlers (#5, #6, #9, #10)
// ---------------------------------------------------------------------------
function registerGlobalHandlers(): void {
  if (globalsRegistered) return;
  globalsRegistered = true;

  const fromChrome = (e: Electron.IpcMainInvokeEvent): boolean => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return !!win && pluginBrowserWindows.has(win);
  };

  ipcMain.handle(PB.openExternal, (e, url: string) => {
    if (fromChrome(e) && isHttpUrl(url)) return shell.openExternal(url);
  });

  ipcMain.handle(PB.showInFolder, (e, path: string) => {
    if (fromChrome(e) && typeof path === 'string' && path.length > 0) shell.showItemInFolder(path);
  });

  ipcMain.handle(PB.zoomChanged, (e, { partition, level }: { partition: string; level: number }) => {
    if (fromChrome(e) && typeof partition === 'string') zoomByPartition.set(partition, level);
  });

  ipcMain.handle(PB.getZoom, (e, partition: string) => (fromChrome(e) ? (zoomByPartition.get(partition) ?? 0) : 0));

  ipcMain.handle(PB.authSubmit, (e, r: AuthSubmitPayload) => {
    const senderWin = BrowserWindow.fromWebContents(e.sender);
    const entry = pendingAuth.get(r.id);
    if (!entry || entry.owner !== senderWin) return;
    pendingAuth.delete(r.id);
    if (r.cancel) entry.cb();
    else entry.cb(r.username, r.password);
  });

  app.on('login', (event, webContents, _details, authInfo, callback) => {
    if (!guestIds.has(webContents.id)) return;
    event.preventDefault();
    const owner = ownerWindowOf(webContents);
    if (!owner) {
      callback();
      return;
    }
    const id = ++authReqCounter;
    pendingAuth.set(id, { cb: callback, owner });
    sendToChrome(owner, PB.authPrompt, {
      id,
      host: authInfo.host,
      realm: authInfo.realm,
      isProxy: authInfo.isProxy,
    });
  });
}

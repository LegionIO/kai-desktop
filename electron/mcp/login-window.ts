import { BrowserWindow } from 'electron';
import { showBrowserWindowOrigin } from '../browser/window-origin.js';
import type { McpOAuthService } from './oauth-service.js';

function isWebSignInUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

/** Human-only sign-in windows, separate from the agent's Browser tab registry. */
export class McpLoginWindows {
  private windows = new Map<string, BrowserWindow>();

  constructor(private readonly service: McpOAuthService) {}

  async open(loginId: string): Promise<void> {
    const { name, authorizationUrl } = this.service.loginWindowInfo(loginId);
    const existing = this.windows.get(loginId);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 620,
      height: 720,
      title: 'Sign in',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // In-memory, attempt-scoped cookies; no app preload or agent access.
        partition: `mcp-oauth-${loginId}`,
      },
    });
    this.windows.set(loginId, win);
    showBrowserWindowOrigin(win, { name: `${__BRAND_PRODUCT_NAME} MCP: ${name}` }, 'Sign in');
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    const preventDownload = (event: Electron.Event) => event.preventDefault();
    win.webContents.session.on('will-download', preventDownload);
    win.webContents.on('will-navigate', (event, url) => {
      if (!isWebSignInUrl(url)) event.preventDefault();
    });
    win.webContents.on('will-redirect', (event, url) => {
      if (!isWebSignInUrl(url)) event.preventDefault();
    });
    // Keep sign-in links in the protected window. Providers that require a
    // separate popup or an external browser can use the explicit fallback.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isWebSignInUrl(url)) void win.loadURL(url).catch(() => undefined);
      return { action: 'deny' };
    });
    const session = win.webContents.session;
    win.on('closed', () => {
      session.removeListener('will-download', preventDownload);
      void session.clearStorageData().catch(() => undefined);
      if (this.windows.get(loginId) === win) {
        this.windows.delete(loginId);
        this.service.cancelLogin(name);
      }
    });
    try {
      await win.loadURL(authorizationUrl);
    } catch {
      // Completion/cancellation can destroy the window while navigation is
      // pending. Otherwise leave the attempt available for the browser fallback.
      if (!this.windows.has(loginId)) return;
      this.close(loginId);
      throw new Error('Could not open the sign-in page. Try Open in system browser.');
    }
  }

  close(loginId: string): void {
    const win = this.windows.get(loginId);
    this.windows.delete(loginId);
    // Delete first: programmatic cleanup must not cancel an authorized attempt.
    if (win && !win.isDestroyed()) win.destroy();
  }
}

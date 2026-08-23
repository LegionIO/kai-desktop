import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import type {
  BrowserBookmark,
  BrowserBounds,
  BrowserCreateTabRequest,
  BrowserDataClearOptions,
  BrowserMenuAction,
  BrowserScreenshotRequest,
  BrowserTabCommand,
} from '../../shared/browser.js';
import { getBrowserManager, getExistingBrowserManager } from '../browser/service.js';
import { nativeCredentialAuthenticationAvailable } from '../browser/credential-vault.js';
import { parseBrowserPermissionDecision } from '../browser/input-validation.js';
import { scaleBrowserBoundsForZoom } from '../browser/session.js';

export function registerBrowserHandlers(
  ipcMain: IpcMain,
  getPrimaryWindow: () => BrowserWindow | null,
  isPrimaryRendererUrl: (url: string) => boolean,
): void {
  const isPrimaryMainFrame = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const primaryWindow = getPrimaryWindow();
    return (
      !!primaryWindow &&
      !primaryWindow.isDestroyed() &&
      !primaryWindow.webContents.isDestroyed() &&
      event.sender === primaryWindow.webContents &&
      event.senderFrame === primaryWindow.webContents.mainFrame &&
      isPrimaryRendererUrl(event.senderFrame.url)
    );
  };

  // This signal is intentionally absent from window.app. It is sent directly
  // by preload only after the replacement realm's context bridge is installed.
  ipcMain.on('browser:host-renderer-ready', (event: IpcMainEvent) => {
    if (!isPrimaryMainFrame(event)) return;
    getExistingBrowserManager()?.handleHostRendererReady();
  });

  const assertPrimaryRenderer = (event: IpcMainInvokeEvent) => {
    const browserManager = getExistingBrowserManager();
    if (!isPrimaryMainFrame(event)) {
      throw new Error("The in-app browser is available only to Kai's primary desktop window.");
    }
    const authorityGeneration = browserManager?.getHostRendererAuthorityGeneration();
    if (
      !browserManager ||
      authorityGeneration === undefined ||
      !browserManager.isHostRendererAuthorityCurrent(authorityGeneration)
    ) {
      throw new Error("The in-app browser is unavailable until Kai's primary renderer is ready.");
    }
    return { browserManager, authorityGeneration };
  };
  const handle = <Args extends unknown[], Result>(
    channel: string,
    listener: (...args: Args) => Result,
    options: { allowWhenDisabled?: boolean } = {},
  ): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const { browserManager, authorityGeneration } = assertPrimaryRenderer(event);
      if (!options.allowWhenDisabled) browserManager.assertEnabled();
      return browserManager.runHostRendererOperation(authorityGeneration, () => listener(...(args as Args)));
    });
  };
  const handleWithEvent = <Args extends unknown[], Result>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Result,
    options: { allowWhenDisabled?: boolean } = {},
  ): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const { browserManager, authorityGeneration } = assertPrimaryRenderer(event);
      if (!options.allowWhenDisabled) browserManager.assertEnabled();
      return browserManager.runHostRendererOperation(authorityGeneration, () => listener(event, ...(args as Args)));
    });
  };

  handle('browser:available', () => true, { allowWhenDisabled: true });
  handle('browser:get-state', (conversationId: string) => getBrowserManager().getState(conversationId));
  handle('browser:get-attention-state', () => getBrowserManager().getAttentionState());
  handle('browser:create-tab', (request: BrowserCreateTabRequest) => getBrowserManager().createTab(request));
  handle('browser:command-tab', (conversationId: string, tabId: string, command: BrowserTabCommand) =>
    getBrowserManager().commandTab(conversationId, tabId, command),
  );
  handle('browser:menu-action', (conversationId: string, action: BrowserMenuAction) =>
    getBrowserManager().menuAction(conversationId, action),
  );
  handle('browser:reorder-tabs', (conversationId: string, ids: string[]) =>
    getBrowserManager().reorderTabs(conversationId, ids),
  );
  handle('browser:navigate', (conversationId: string, tabId: string, input: string) =>
    getBrowserManager().navigate(conversationId, tabId, input),
  );
  handleWithEvent(
    'browser:mount',
    (event, conversationId: string, bounds: BrowserBounds | null) => {
      const browserManager = getBrowserManager();
      // Cleanup must remain available after Settings disables Browser so the
      // React panel can detach any retained native-view mount. Non-null mounts
      // still require the feature to be enabled.
      if (bounds !== null) browserManager.assertEnabled();
      return browserManager.mount(conversationId, scaleBrowserBoundsForZoom(bounds, event.sender.getZoomFactor()));
    },
    { allowWhenDisabled: true },
  );
  handle('browser:set-chrome-focus', (conversationId: string, focused: boolean) =>
    getBrowserManager().setChromeFocus(conversationId, focused),
  );
  handle(
    'browser:find',
    (conversationId: string, tabId: string, text: string, forward?: boolean, findNext?: boolean, requestId?: number) =>
      getBrowserManager().find(conversationId, tabId, text, forward, findNext, requestId),
  );
  handle('browser:stop-find', (conversationId: string, tabId: string) =>
    getBrowserManager().stopFind(conversationId, tabId),
  );
  handle('browser:set-zoom', (conversationId: string, tabId: string, level: number) => {
    if (!Number.isFinite(level)) {
      throw new Error('Browser zoom must be a finite number.');
    }
    return getBrowserManager().setZoom(conversationId, tabId, level);
  });
  handle('browser:capture-menu-preview', (conversationId: string, tabId: string, requestId: string) =>
    getBrowserManager().captureMenuPreview(conversationId, tabId, requestId),
  );
  handle('browser:cancel-menu-preview', (requestId: string) => getBrowserManager().cancelMenuPreview(requestId));
  handle('browser:screenshot', (conversationId: string, request: BrowserScreenshotRequest) => {
    if (!request || typeof request.documentToken !== 'string' || request.documentToken.length === 0) {
      throw new Error('Browser screenshots require the current page document token.');
    }
    return getBrowserManager().screenshot(conversationId, request);
  });
  handle('browser:pick-element', (conversationId: string, tabId: string, documentToken: string) => {
    if (typeof documentToken !== 'string' || documentToken.length === 0 || documentToken.length > 256) {
      throw new Error('Browser element picking requires the current page document token.');
    }
    return getBrowserManager().pickElement(conversationId, tabId, documentToken);
  });
  handle('browser:list-history', (conversationId: string, query?: string) =>
    getBrowserManager().listHistory(conversationId, query),
  );
  handle('browser:clear-history', (conversationId: string) => getBrowserManager().clearHistory(conversationId));
  handle('browser:list-bookmarks', (conversationId: string, query?: string) =>
    getBrowserManager().listBookmarks(conversationId, query),
  );
  handle('browser:add-bookmark', (conversationId: string, title: string, url: string, folder?: string) =>
    getBrowserManager().addBookmark(conversationId, title, url, folder),
  );
  handle('browser:update-bookmark', (conversationId: string, bookmark: BrowserBookmark) =>
    getBrowserManager().updateBookmark(conversationId, bookmark),
  );
  handle('browser:remove-bookmark', (conversationId: string, id: string) =>
    getBrowserManager().removeBookmark(conversationId, id),
  );
  handle('browser:reorder-bookmarks', (conversationId: string, ids: string[]) =>
    getBrowserManager().reorderBookmarks(conversationId, ids),
  );
  handle('browser:import-bookmarks', (conversationId: string) => getBrowserManager().importBookmarks(conversationId));
  handle('browser:export-bookmarks', (conversationId: string) => getBrowserManager().exportBookmarks(conversationId));
  handle('browser:list-downloads', (conversationId: string) => getBrowserManager().listDownloads(conversationId));
  handle('browser:show-download', (conversationId: string, downloadId: string) =>
    getBrowserManager().showDownload(conversationId, downloadId),
  );
  handle('browser:export-download', (conversationId: string, downloadId: string) =>
    getBrowserManager().exportDownload(conversationId, downloadId),
  );
  handle('browser:delete-download', (conversationId: string, downloadId: string) =>
    getBrowserManager().deleteDownload(conversationId, downloadId),
  );
  handle('browser:cancel-download', (conversationId: string, downloadId: string) =>
    getBrowserManager().cancelDownload(conversationId, downloadId),
  );
  handle('browser:list-site-permissions', (conversationId: string, origin: string) =>
    getBrowserManager().listSitePermissions(conversationId, origin),
  );
  handle('browser:reset-site-permissions', (conversationId: string, origin: string, permission?: string) =>
    getBrowserManager().resetSitePermissions(conversationId, origin, permission),
  );
  handle('browser:list-credentials', (conversationId: string, query?: string) =>
    getBrowserManager().listCredentials(conversationId, query),
  );
  handle('browser:credential-authentication-available', () => nativeCredentialAuthenticationAvailable());
  handle('browser:save-credential', (conversationId: string, origin: string, username: string, password: string) =>
    getBrowserManager().saveCredential(conversationId, origin, username, password),
  );
  handle(
    'browser:update-credential',
    (conversationId: string, credentialId: string, username: string, password: string) =>
      getBrowserManager().updateCredential(conversationId, credentialId, username, password),
  );
  handle('browser:delete-credential', (conversationId: string, id: string) =>
    getBrowserManager().deleteCredential(conversationId, id),
  );
  handle('browser:reveal-credential', (conversationId: string, id: string) =>
    getBrowserManager().revealCredential(conversationId, id),
  );
  handle('browser:copy-credential', (conversationId: string, id: string) =>
    getBrowserManager().copyCredential(conversationId, id),
  );
  handle('browser:respond-credential', (id: string, save: boolean) =>
    getBrowserManager().respondCredentialPrompt(id, save),
  );
  handle('browser:respond-auth', (id: string, username?: string, password?: string) =>
    getBrowserManager().respondAuthPrompt(id, username, password),
  );
  handle('browser:respond-permission', (id: string, decision: unknown) =>
    getBrowserManager().respondPermissionPrompt(id, parseBrowserPermissionDecision(decision)),
  );
  handle('browser:autofill', (conversationId: string, tabId: string, id?: string) =>
    getBrowserManager().autofill(conversationId, tabId, id),
  );
  handle('browser:data-summary', (conversationId?: string) => getBrowserManager().dataSummary(conversationId), {
    allowWhenDisabled: true,
  });
  handle('browser:clear-data', (options: BrowserDataClearOptions) => getBrowserManager().clearData(options), {
    allowWhenDisabled: true,
  });
}

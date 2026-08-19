import type { WebContents } from 'electron';

export type BrowserAwareEditCommand = 'cut' | 'copy' | 'paste';
export type BrowserAwareApplicationMenuCommand =
  | 'find'
  | 'reload'
  | 'hard-reload'
  | 'toggle-devtools'
  | 'zoom-reset'
  | 'zoom-in'
  | 'zoom-out';

export type BrowserMenuDispatcher = {
  dispatchClipboardCommand: (contents: WebContents, command: BrowserAwareEditCommand) => boolean;
  dispatchApplicationMenuCommand: (contents: WebContents, command: BrowserAwareApplicationMenuCommand) => boolean;
};

/** Electron MenuItem roles dispatch directly to the focused WebContents and
 * bypass before-input-event. Give BrowserManager the first chance to claim a
 * managed page so it can perform its asynchronous password-field scan. */
export function dispatchBrowserAwareEditCommand(
  contents: WebContents | null,
  dispatcher: Pick<BrowserMenuDispatcher, 'dispatchClipboardCommand'> | null,
  command: BrowserAwareEditCommand,
): boolean {
  if (!contents || contents.isDestroyed()) return false;
  if (dispatcher?.dispatchClipboardCommand(contents, command)) return true;
  contents[command]();
  return true;
}

/** Replace application-menu roles only for Browser-owned focus. The fallback
 * preserves native Kai renderer behavior for chat, settings, and other windows. */
export function dispatchBrowserAwareApplicationMenuCommand(
  contents: WebContents | null,
  dispatcher: Pick<BrowserMenuDispatcher, 'dispatchApplicationMenuCommand'> | null,
  command: BrowserAwareApplicationMenuCommand,
  fallback: (contents: WebContents, command: BrowserAwareApplicationMenuCommand) => void,
): boolean {
  if (!contents || contents.isDestroyed()) return false;
  if (dispatcher?.dispatchApplicationMenuCommand(contents, command)) return true;
  fallback(contents, command);
  return true;
}

import type { BrowserWindow } from 'electron';

/** Supplied by the host that opens the window, never by the remote page. */
export type BrowserWindowOrigin = {
  name: string;
  displayName?: string;
};

export function browserWindowOriginLabel(origin: BrowserWindowOrigin): string {
  return origin.displayName && origin.displayName !== origin.name
    ? `${origin.displayName} (${origin.name})`
    : origin.name;
}

/** Keep the opener visible even when an identity provider replaces the page title. */
export function showBrowserWindowOrigin(win: BrowserWindow, origin: BrowserWindowOrigin, title: string): void {
  win.setTitle(`${browserWindowOriginLabel(origin)} — ${title}`);
  // The BrowserWindow event controls the native title; the similarly named
  // WebContents event only reports the page title and cannot prevent the update.
  win.on('page-title-updated', (event) => event.preventDefault());
}

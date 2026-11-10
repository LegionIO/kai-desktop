import type { BrowserWindow } from 'electron';

const pending = new WeakSet<BrowserWindow>();

/** Electron emits browser-window-created before its native constructor has
 * finished. Destroying there crashes Electron 41; hide immediately and dispose
 * after that native stack unwinds. Explicit show calls use the same guard. */
export function suppressHeadlessWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  try {
    win.hide();
  } catch {
    // The originating window may already be closing.
  }
  if (pending.has(win)) return;
  pending.add(win);
  setImmediate(() => {
    pending.delete(win);
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      // Window teardown must not interrupt backend cleanup.
    }
  });
}

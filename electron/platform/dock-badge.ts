/**
 * Cross-platform dock / taskbar notification badge.
 *
 * A single seam so the rest of the app can push one "attention" badge value and
 * have it render on whatever the OS calls its app icon:
 *   - macOS: `app.dock.setBadge(text)` — a red pill on the Dock icon (text or count).
 *   - Windows: `BrowserWindow.setOverlayIcon(image, desc)` — a small overlay badge
 *     drawn onto the taskbar button. Numeric counts render a red circle+number;
 *     a non-empty non-numeric badge renders a plain red dot. Cleared with null.
 *   - Linux: `app.setBadgeCount(n)` — the Unity launcher count (numeric only; a
 *     text-only badge maps to count 1 as a presence indicator, 0 clears).
 *
 * All calls are best-effort and never throw into the caller. `style` mirrors the
 * in-app `ui.dockBadgeStyle` so a text badge collapses to a dot when the user
 * prefers it (macOS shows the count/dot; the OS pill can't hold long text).
 */
import { app, nativeImage } from 'electron';
import type { BrowserWindow } from 'electron';

export type DockBadgeStyle = 'dot' | 'truncate' | 'full';

export interface DockBadgeValue {
  /** Aggregate numeric count (0 = no numeric badge). */
  count: number;
  /** True when a non-numeric ("text") badge is present somewhere. */
  hasText: boolean;
  /** Render preference for a text badge (numeric always shows as a count). */
  style: DockBadgeStyle;
}

/** macOS Dock badge string: a count wins; else a dot for a text badge; else ''. */
function macBadgeText(value: DockBadgeValue): string {
  if (value.count > 0) return value.count > 99 ? '99+' : String(value.count);
  if (value.hasText) return value.style === 'dot' ? '●' : '•';
  return '';
}

/** A small red overlay-icon PNG for the Windows taskbar (count or a dot). */
function windowsOverlayImage(value: DockBadgeValue): Electron.NativeImage | null {
  if (value.count <= 0 && !value.hasText) return null;
  const label = value.count > 0 ? (value.count > 99 ? '99+' : String(value.count)) : '';
  const fontSize = label.length >= 3 ? 12 : 15;
  // 32×32 red circle; centered white count when numeric, empty (dot) otherwise.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <circle cx="16" cy="16" r="15" fill="#e11d48"/>
    ${label ? `<text x="16" y="17" font-family="Arial,Helvetica,sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${label}</text>` : ''}
  </svg>`;
  try {
    const img = nativeImage.createFromDataURL(
      `data:image/svg+xml;base64,${Buffer.from(svg, 'utf-8').toString('base64')}`,
    );
    return img.isEmpty() ? null : img;
  } catch {
    return null;
  }
}

/**
 * Apply the aggregate badge to the OS app icon. `win` is the primary window
 * (needed for the Windows taskbar overlay); pass null to only drive the macOS
 * Dock / Linux launcher count.
 */
export function setDockBadge(win: BrowserWindow | null, value: DockBadgeValue): void {
  try {
    if (process.platform === 'darwin') {
      if (app.dock) app.dock.setBadge(macBadgeText(value));
      return;
    }
    if (process.platform === 'win32') {
      if (!win || win.isDestroyed()) return;
      const img = windowsOverlayImage(value);
      const desc = value.count > 0 ? `${value.count} notifications` : value.hasText ? 'notifications' : '';
      win.setOverlayIcon(img, desc);
      return;
    }
    // Linux (Unity launcher): numeric only. A text-only badge → 1 as presence.
    if (typeof app.setBadgeCount === 'function') {
      app.setBadgeCount(value.count > 0 ? value.count : value.hasText ? 1 : 0);
    }
  } catch {
    // Best-effort: a badge failure must never disrupt the app.
  }
}

/** Clear any dock/taskbar badge. */
export function clearDockBadge(win: BrowserWindow | null): void {
  setDockBadge(win, { count: 0, hasText: false, style: 'dot' });
}

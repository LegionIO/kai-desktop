import { randomBytes } from 'node:crypto';
import { BrowserWindow, clipboard, globalShortcut, nativeImage, screen } from 'electron';
import { formatAppShotRef, type AppShotMeta, type AppShotPayload } from '../../shared/app-shots.js';
import type { AppConfig } from '../config/schema.js';
import { getFallbackAdapter, getPlatformAdapter } from '../platform/index.js';
import type { NativePlatformAdapter } from '../platform/types.js';
import { broadcastToAllWindows, safelySendToWindow } from '../utils/window-send.js';

export type AppShotsConfig = NonNullable<AppConfig['appShots']>;

const DEFAULT_CONFIG: AppShotsConfig = {
  enabled: false,
  hotkey: 'CommandOrControl+Shift+1',
  captureMode: 'window',
  includeUiTree: true,
  includeSelectedText: true,
  uiTreeDepth: 4,
  autoAttach: false,
};

let currentConfig: AppShotsConfig = DEFAULT_CONFIG;
let registeredHotkey: string | null = null;
let hotkeySuspended = false;
let lastFireAt = 0;
const DEBOUNCE_MS = 500;

const REF_STORE_LIMIT = 32;
const refStore = new Map<string, AppShotPayload>();

export function resolveAppShotRef(refId: string): AppShotPayload | null {
  return refStore.get(refId) ?? null;
}

function storeAppShotRef(payload: AppShotPayload): void {
  refStore.set(payload.refId, payload);
  while (refStore.size > REF_STORE_LIMIT) {
    const oldest = refStore.keys().next().value;
    if (oldest) refStore.delete(oldest);
  }
}

export function initAppShots(appConfig: AppConfig): void {
  currentConfig = { ...DEFAULT_CONFIG, ...(appConfig.appShots ?? {}) };
  applyHotkey();
}

export function updateAppShotsConfig(appConfig: AppConfig): void {
  const next = { ...DEFAULT_CONFIG, ...(appConfig.appShots ?? {}) };
  const hotkeyChanged = next.hotkey !== currentConfig.hotkey || next.enabled !== currentConfig.enabled;
  currentConfig = next;
  if (hotkeyChanged) applyHotkey();
}

export function cleanupAppShots(): void {
  unregisterHotkey();
}

export function suspendAppShotsHotkey(): void {
  hotkeySuspended = true;
  unregisterHotkey();
}

export function resumeAppShotsHotkey(): void {
  hotkeySuspended = false;
  applyHotkey();
}

function applyHotkey(): void {
  unregisterHotkey();
  if (!currentConfig.enabled || hotkeySuspended) return;
  try {
    const ok = globalShortcut.register(currentConfig.hotkey, () => {
      const now = Date.now();
      if (now - lastFireAt < DEBOUNCE_MS) return;
      lastFireAt = now;
      void captureAppShot().catch((error) => {
        console.error('[app-shots] capture failed:', error instanceof Error ? error.message : String(error));
      });
    });
    if (ok) registeredHotkey = currentConfig.hotkey;
    else console.warn(`[app-shots] failed to register hotkey '${currentConfig.hotkey}' (already in use?)`);
  } catch (error) {
    console.warn('[app-shots] hotkey registration error:', error instanceof Error ? error.message : String(error));
  }
}

function unregisterHotkey(): void {
  if (registeredHotkey) {
    try {
      globalShortcut.unregister(registeredHotkey);
    } catch {
      /* ignore */
    }
    registeredHotkey = null;
  }
}

async function withFallback<T>(
  fn: (a: NativePlatformAdapter) => Promise<T>,
): Promise<{ value: T; usedFallback: boolean }> {
  const native = await getPlatformAdapter();
  try {
    return { value: await fn(native), usedFallback: native.kind === 'fallback' };
  } catch {
    return { value: await fn(getFallbackAdapter()), usedFallback: true };
  }
}

async function bestEffort<T>(fn: (a: NativePlatformAdapter) => Promise<T>): Promise<T | null> {
  const native = await getPlatformAdapter();
  try {
    return await fn(native);
  } catch {
    try {
      return await fn(getFallbackAdapter());
    } catch {
      return null;
    }
  }
}

export async function captureAppShot(): Promise<AppShotPayload> {
  const adapter = await getPlatformAdapter();

  let activeWindow = await bestEffort((a) => a.getActiveWindow());
  // Pin the screenshot + uiTree to the window observed *now* so later helper
  // calls can't drift onto a different frontmost window/app.
  const treeTarget = { pid: activeWindow?.pid ?? null, windowId: activeWindow?.windowId ?? null };

  // Native helpers don't currently extract browser tab URLs; active-win does
  // (via per-browser accessibility hooks). If the native adapter returned a
  // window without a URL, ask the fallback for one and merge it in.
  if (activeWindow && activeWindow.url == null) {
    const fallbackWin = await getFallbackAdapter()
      .getActiveWindow()
      .catch(() => null);
    if (fallbackWin && fallbackWin.pid === activeWindow.pid) {
      activeWindow = {
        ...activeWindow,
        url: fallbackWin.url ?? null,
        bounds: activeWindow.bounds ?? fallbackWin.bounds,
        ownerId: activeWindow.ownerId ?? fallbackWin.ownerId,
      };
    }
  }

  let display: AppShotMeta['display'];
  let displayIndex = 0;
  if (activeWindow?.bounds) {
    const all = screen.getAllDisplays();
    const match = screen.getDisplayMatching(activeWindow.bounds);
    display = { id: String(match.id), bounds: match.bounds, scale: match.scaleFactor };
    const idx = all.findIndex((d) => d.id === match.id);
    if (idx >= 0) displayIndex = idx;
  }

  const { value: shot, usedFallback } =
    currentConfig.captureMode === 'window'
      ? await withFallback((a) => a.screenshotWindow(treeTarget.windowId))
      : await withFallback((a) => a.screenshotDisplay(displayIndex));

  const [selectedText, uiTree] = await Promise.all([
    currentConfig.includeSelectedText ? bestEffort((a) => a.getSelectedText()) : Promise.resolve(undefined),
    currentConfig.includeUiTree
      ? bestEffort((a) => a.dumpUiTree(currentConfig.uiTreeDepth, treeTarget))
      : Promise.resolve(undefined),
  ]);

  const meta: AppShotMeta = {
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    adapter: usedFallback || adapter.kind === 'fallback' ? 'fallback' : 'native',
    app: activeWindow,
    display,
    selectedText: selectedText ?? null,
    uiTree: uiTree ?? null,
  };

  const safeApp = (activeWindow?.appName ?? 'screen').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'screen';
  const stamp = meta.capturedAt.replace(/[:.]/g, '-');
  const suggestedName = `appshot-${safeApp}-${stamp}`;
  const refId = randomBytes(9).toString('base64url');
  const metaJson = JSON.stringify({ refId, ...meta }, null, 2);

  const payload: AppShotPayload = {
    refId,
    imageDataUrl: `data:${shot.mimeType};base64,${shot.data.toString('base64')}`,
    imageBytes: shot.data.length,
    meta,
    metaJson,
    suggestedName,
  };

  storeAppShotRef(payload);

  try {
    const image = nativeImage.createFromBuffer(shot.data);
    const summary = `${activeWindow?.appName ?? 'Screen'} — ${activeWindow?.windowTitle ?? ''}`.trim();
    clipboard.write({
      image,
      text: `${formatAppShotRef(refId)} ${summary}`.trim(),
      html:
        `<meta name="kai-appshot-ref" content="${refId}">` +
        `<img alt="${summary.replace(/"/g, '&quot;')}" src="${payload.imageDataUrl}">`,
    });
  } catch (error) {
    console.warn('[app-shots] clipboard write failed:', error instanceof Error ? error.message : String(error));
  }

  if (currentConfig.autoAttach) {
    // Authenticated web clients are fully trusted (see project_web_bridge_trust);
    // when auto-attach is on, deliver the full payload everywhere so the
    // composer — desktop or web — receives both attachments.
    broadcastToAllWindows('app-shots:captured', { ...payload, autoAttach: true });
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.isResizable() && win.isFocusable()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        break;
      }
    }
  } else {
    // Clipboard-only: notify the local main window with the full payload
    // (autoAttach=false tells the renderer not to inject it). Web clients
    // cannot read the host clipboard, so they are not notified.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.isResizable() && win.isFocusable()) {
        safelySendToWindow(win, 'app-shots:captured', { ...payload, autoAttach: false });
        break;
      }
    }
  }

  return payload;
}

export function isAppShotsEnabled(): boolean {
  return currentConfig.enabled;
}

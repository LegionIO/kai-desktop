import { screen, shell } from 'electron';
import type * as NutNS from '@nut-tree-fork/nut-js';
import type * as ActiveWinNS from 'active-win';
import type { ComputerDisplayLayout } from '../../../shared/computer-use.js';
import { assertPlainAppName } from '../app-name-guard.js';
import {
  HelperUnavailable,
  type ActiveWindowInfo,
  type AdapterCapabilities,
  type FocusSnapshot,
  type InputMonitorEvent,
  type InputMonitorHandle,
  type NativePlatformAdapter,
  type PlatformPermissions,
  type PlatformPermissionSection,
  type RunningAppInfo,
  type ScreenshotResult,
  type TextFieldSnapshot,
  type UiNode,
} from '../types.js';

type NutModule = typeof NutNS;
type ActiveWinModule = typeof ActiveWinNS;

let nutPromise: Promise<NutModule | null> | null = null;
let activeWinPromise: Promise<ActiveWinModule | null> | null = null;

async function loadNut(): Promise<NutModule | null> {
  if (!nutPromise) {
    nutPromise = import('@nut-tree-fork/nut-js')
      .then((mod) => {
        mod.keyboard.config.autoDelayMs = 5;
        mod.mouse.config.autoDelayMs = 2;
        return mod;
      })
      .catch((error) => {
        console.warn('[platform:fallback] nut-js unavailable:', error instanceof Error ? error.message : String(error));
        return null;
      });
  }
  return nutPromise;
}

async function loadActiveWin(): Promise<ActiveWinModule | null> {
  if (!activeWinPromise) {
    activeWinPromise = import('active-win').catch((error) => {
      console.warn(
        '[platform:fallback] active-win unavailable:',
        error instanceof Error ? error.message : String(error),
      );
      return null;
    });
  }
  return activeWinPromise;
}

/**
 * Library-backed adapter used when no native helper is available, or when a
 * native call times out / fails.
 *
 * Uses `@nut-tree-fork/nut-js` for input + display screenshots and
 * `active-win` for focused-window metadata. Text introspection and UI-tree
 * dumps are unsupported (`null`); callers degrade to clipboard-paste /
 * blind-type strategies.
 */
export class FallbackAdapter implements NativePlatformAdapter {
  readonly kind = 'fallback' as const;
  readonly capabilities: AdapterCapabilities = {
    screenshotDisplay: true,
    screenshotWindow: false,
    input: true,
    textIntrospection: false,
    uiTree: false,
    inputMonitor: false,
  };

  async screenshotDisplay(displayIndex = 0): Promise<ScreenshotResult> {
    const nut = await loadNut();
    if (!nut) throw new HelperUnavailable('nut-js not available for screenshot');
    const displays = screen.getAllDisplays();
    const target = displays[displayIndex] ?? displays[0];
    const region = new nut.Region(target.bounds.x, target.bounds.y, target.bounds.width, target.bounds.height);
    const grab = await nut.screen.grabRegion(region);
    return nutImageToPng(grab);
  }

  async screenshotWindow(_windowId?: string | null): Promise<ScreenshotResult> {
    const info = await this.getActiveWindow();
    if (info?.bounds) {
      const nut = await loadNut();
      if (nut) {
        const region = new nut.Region(info.bounds.x, info.bounds.y, info.bounds.width, info.bounds.height);
        const grab = await nut.screen.grabRegion(region);
        return nutImageToPng(grab);
      }
    }
    return this.screenshotDisplay(0);
  }

  async listDisplays(): Promise<ComputerDisplayLayout | undefined> {
    const all = screen.getAllDisplays();
    if (all.length === 0) return undefined;
    const primaryId = screen.getPrimaryDisplay().id;
    return {
      displays: all.map((d, index) => ({
        displayId: String(d.id),
        name: d.label || `Display ${index + 1}`,
        pixelWidth: Math.round(d.size.width * d.scaleFactor),
        pixelHeight: Math.round(d.size.height * d.scaleFactor),
        logicalWidth: d.size.width,
        logicalHeight: d.size.height,
        globalX: d.bounds.x,
        globalY: d.bounds.y,
        scaleFactor: d.scaleFactor,
        isPrimary: d.id === primaryId,
        displayIndex: index,
      })),
    };
  }

  async movePointer(x: number, y: number, _durationMs?: number): Promise<void> {
    const nut = await loadNut();
    if (!nut) throw new HelperUnavailable('nut-js not available for movePointer');
    await nut.mouse.setPosition(new nut.Point(x, y));
  }

  async click(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    const nut = await loadNut();
    if (!nut) throw new HelperUnavailable('nut-js not available for click');
    await nut.mouse.setPosition(new nut.Point(x, y));
    const btn = button === 'right' ? nut.Button.RIGHT : button === 'middle' ? nut.Button.MIDDLE : nut.Button.LEFT;
    await nut.mouse.click(btn);
  }

  async doubleClick(x: number, y: number): Promise<void> {
    const nut = await loadNut();
    if (!nut) throw new HelperUnavailable('nut-js not available for doubleClick');
    await nut.mouse.setPosition(new nut.Point(x, y));
    await nut.mouse.doubleClick(nut.Button.LEFT);
  }

  async drag(startX: number, startY: number, endX: number, endY: number, _durationMs?: number): Promise<void> {
    const nut = await loadNut();
    if (!nut) throw new HelperUnavailable('nut-js not available for drag');
    await nut.mouse.setPosition(new nut.Point(startX, startY));
    await nut.mouse.pressButton(nut.Button.LEFT);
    await nut.mouse.move([new nut.Point(endX, endY)]);
    await nut.mouse.releaseButton(nut.Button.LEFT);
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    const nut = await loadNut();
    if (!nut) throw new HelperUnavailable('nut-js not available for scroll');
    if (deltaY > 0) await nut.mouse.scrollDown(deltaY);
    if (deltaY < 0) await nut.mouse.scrollUp(-deltaY);
    if (deltaX > 0) await nut.mouse.scrollRight(deltaX);
    if (deltaX < 0) await nut.mouse.scrollLeft(-deltaX);
  }

  async typeText(text: string, _delayMs?: number): Promise<void> {
    const nut = await loadNut();
    if (!nut) throw new HelperUnavailable('nut-js not available for typeText');
    await nut.keyboard.type(text);
  }

  async pressKeys(keys: string[], _delayMs?: number): Promise<void> {
    const nut = await loadNut();
    if (!nut) throw new HelperUnavailable('nut-js not available for pressKeys');
    const mapped = keys.map((k) => mapKeyToNut(nut, k)).filter((k): k is number => k !== null);
    if (mapped.length === 0) return;
    await nut.keyboard.pressKey(...mapped);
    await nut.keyboard.releaseKey(...mapped);
  }

  async getPointerPosition(): Promise<{ x: number; y: number } | null> {
    const nut = await loadNut();
    if (!nut) return null;
    const pos = await nut.mouse.getPosition();
    return { x: pos.x, y: pos.y };
  }

  async getActiveWindow(): Promise<ActiveWindowInfo | null> {
    const mod = await loadActiveWin();
    if (!mod) return null;
    try {
      const result = await mod.activeWindow();
      if (!result) return null;
      return {
        appName: result.owner.name,
        windowTitle: result.title,
        ownerId:
          'bundleId' in result.owner
            ? ((result.owner as { bundleId?: string }).bundleId ?? result.owner.path)
            : result.owner.path,
        pid: result.owner.processId,
        bounds: {
          x: result.bounds.x,
          y: result.bounds.y,
          width: result.bounds.width,
          height: result.bounds.height,
        },
        windowId: String(result.id),
        url: 'url' in result ? ((result as { url?: string }).url ?? null) : null,
      };
    } catch {
      return null;
    }
  }

  async listRunningApps(): Promise<RunningAppInfo[]> {
    const mod = await loadActiveWin();
    if (!mod) return [];
    try {
      const wins = await mod.openWindows();
      const seen = new Set<number>();
      const apps: RunningAppInfo[] = [];
      for (const win of wins) {
        if (seen.has(win.owner.processId)) continue;
        seen.add(win.owner.processId);
        apps.push({ name: win.owner.name, ownerId: win.owner.path, pid: win.owner.processId });
      }
      return apps;
    } catch {
      return [];
    }
  }

  async isFullscreen(): Promise<boolean> {
    const info = await this.getActiveWindow();
    if (!info?.bounds) return false;
    const display = screen.getDisplayMatching(info.bounds);
    return info.bounds.width >= display.bounds.width && info.bounds.height >= display.bounds.height;
  }

  async exitFullscreen(): Promise<void> {
    await this.pressKeys(['f11']).catch(() => {});
  }

  async openApp(name: string): Promise<void> {
    // shell.openPath opens via the OS default handler; a full/relative path
    // would launch an arbitrary target. Require a bare name (chokepoint in
    // local-desktop.ts already validates, but guard here too).
    const safe = assertPlainAppName(name);
    const error = await shell.openPath(safe);
    if (error) {
      throw new HelperUnavailable(
        `fallback adapter cannot launch '${safe}': ${error}. Install the native helper for reliable app launching.`,
      );
    }
  }

  async focusApp(name: string): Promise<void> {
    throw new HelperUnavailable(`fallback adapter cannot focus app '${name}' by name`);
  }

  async openUrl(url: string): Promise<void> {
    const { safeNavigateUrl } = await import('../safe-url.js');
    const safe = safeNavigateUrl(url);
    if (!safe) throw new Error(`Refusing to open non-http(s) URL: ${url}`);
    await shell.openExternal(safe);
  }

  async captureFocus(): Promise<FocusSnapshot | null> {
    const info = await this.getActiveWindow();
    if (!info) return null;
    return {
      appName: info.appName,
      ownerId: info.ownerId,
      pid: info.pid,
      windowId: info.windowId ?? null,
      capturedAt: Date.now(),
    };
  }

  async restoreFocus(_snapshot: FocusSnapshot): Promise<void> {
    return Promise.resolve();
  }

  async readFocusedTextField(): Promise<TextFieldSnapshot | null> {
    return null;
  }

  async writeFocusedTextField(_value: string): Promise<boolean> {
    return false;
  }

  async getSelectedText(): Promise<string | null> {
    // The fallback adapter has no accessibility API. Synthesising Cmd/Ctrl+C
    // to probe the selection is not safe — in a terminal it sends SIGINT and
    // kills whatever is running — so just report no selection.
    return null;
  }

  async dumpUiTree(_maxDepth: number): Promise<UiNode | null> {
    return null;
  }

  startInputMonitor(_onEvent: (event: InputMonitorEvent) => void, onError?: (err: string) => void): InputMonitorHandle {
    onError?.('input monitor unavailable on fallback adapter');
    return { stop: () => {} };
  }

  async checkPermissions(): Promise<PlatformPermissions> {
    const nut = await loadNut();
    return {
      platform: 'fallback',
      helperReady: nut !== null,
      states: [
        {
          section: 'helper-available',
          granted: nut !== null,
          label: 'Fallback automation library',
          hint: nut ? undefined : '@nut-tree-fork/nut-js failed to load',
        },
      ],
    };
  }

  async openPermissionSettings(_section: PlatformPermissionSection): Promise<void> {
    return Promise.resolve();
  }
}

const PRIMARY_MODIFIER = process.platform === 'darwin' ? 'LeftCmd' : 'LeftControl';

const NUT_KEY_MAP: Record<string, string> = {
  cmd: PRIMARY_MODIFIER,
  command: PRIMARY_MODIFIER,
  meta: PRIMARY_MODIFIER,
  super: 'LeftSuper',
  win: 'LeftSuper',
  ctrl: 'LeftControl',
  control: 'LeftControl',
  alt: 'LeftAlt',
  option: 'LeftAlt',
  shift: 'LeftShift',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  space: 'Space',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  f11: 'F11',
};

function mapKeyToNut(nut: NutModule, key: string): number | null {
  const lower = key.toLowerCase();
  const mapped = NUT_KEY_MAP[lower];
  let enumKey: string;
  if (mapped) {
    enumKey = mapped;
  } else if (lower.length === 1 && lower >= '0' && lower <= '9') {
    enumKey = `Num${lower}`;
  } else if (lower.length === 1) {
    enumKey = lower.toUpperCase();
  } else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) {
    enumKey = lower.toUpperCase();
  } else {
    enumKey = key;
  }
  const value = (nut.Key as unknown as Record<string, number>)[enumKey];
  return typeof value === 'number' ? value : null;
}

async function nutImageToPng(image: NutNS.Image): Promise<ScreenshotResult> {
  const rgb = await image.toRGB();
  const { width, height, data, channels } = rgb;
  let rgba: Buffer;
  if (channels === 4) {
    rgba = data;
  } else {
    rgba = Buffer.alloc(width * height * 4);
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      rgba[j] = data[i];
      rgba[j + 1] = data[i + 1];
      rgba[j + 2] = data[i + 2];
      rgba[j + 3] = 255;
    }
  }
  const png = await encodeRgbaToPng(rgba, width, height);
  return { data: png, width, height, mimeType: 'image/png' };
}

/** Minimal zero-dependency RGBA → PNG encoder. */
async function encodeRgbaToPng(rgba: Buffer, width: number, height: number): Promise<Buffer> {
  const { deflateSync } = await import('node:zlib');
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shell } from 'electron';
import {
  buildDisplayLayout,
  getComputerUsePermissions,
  getLocalMacPointerPosition,
  openLocalMacosPrivacySettings,
  runLocalMacMouseCommand,
  type LocalMacosHelperResponse,
} from '../../computer-use/permissions.js';
import {
  startLocalMacosTakeoverMonitor,
  type LocalMacosTakeoverEvent,
} from '../../computer-use/harnesses/local-macos.js';
import type { ComputerDisplayLayout } from '../../../shared/computer-use.js';
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

const execFileAsync = promisify(execFile);

async function runOsascript(script: string, timeout = 5000): Promise<string> {
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout });
  return stdout.trim();
}

function encodeBase64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64');
}

/**
 * macOS implementation of `NativePlatformAdapter`.
 *
 * Delegates almost everything to the existing `LocalMacosHelper` Swift binary
 * via `runLocalMacMouseCommand` (one-shot per call) so behaviour is identical
 * to the pre-adapter code paths. The only AppleScript still used here covers
 * window queries that the Swift helper does not yet expose; those move into
 * the helper as `activeWindow` / `uiTree` / `selectedText` in Phase 5.
 */
export class MacosAdapter implements NativePlatformAdapter {
  readonly kind = 'darwin' as const;
  readonly capabilities: AdapterCapabilities = {
    screenshotDisplay: true,
    screenshotWindow: true,
    input: true,
    textIntrospection: true,
    uiTree: true,
    inputMonitor: true,
  };

  async screenshotDisplay(displayIndex = 0): Promise<ScreenshotResult> {
    const excludeArg = encodeBase64([]);
    const result = await runLocalMacMouseCommand([
      'screenshot',
      excludeArg,
      '0.85',
      String(displayIndex),
      String(process.pid),
    ]);
    if (!result.imageBase64 || !result.width || !result.height) {
      throw new HelperUnavailable(result.error ?? 'screenshot failed');
    }
    return {
      data: Buffer.from(result.imageBase64, 'base64'),
      width: result.width,
      height: result.height,
      mimeType: 'image/jpeg',
    };
  }

  async screenshotWindow(windowId?: string | null): Promise<ScreenshotResult> {
    const result = await runLocalMacMouseCommand(['screenshotWindow', windowId ?? '']).catch(() => null);
    if (result?.imageBase64 && result.width && result.height) {
      return {
        data: Buffer.from(result.imageBase64, 'base64'),
        width: result.width,
        height: result.height,
        mimeType: 'image/png',
      };
    }
    return this.screenshotDisplay(0);
  }

  async listDisplays(): Promise<ComputerDisplayLayout | undefined> {
    const result = await runLocalMacMouseCommand(['displays']).catch(() => null);
    return buildDisplayLayout(result?.displays);
  }

  async movePointer(x: number, y: number, durationMs = 120): Promise<void> {
    await runLocalMacMouseCommand(['move', String(x), String(y), String(durationMs), '18', 'direct']);
  }

  async click(x: number, y: number, _button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    await runLocalMacMouseCommand(['click', String(x), String(y), '120', 'direct']);
  }

  async doubleClick(x: number, y: number): Promise<void> {
    await runLocalMacMouseCommand(['doubleClick', String(x), String(y), '130', 'direct']);
  }

  async drag(startX: number, startY: number, endX: number, endY: number, durationMs = 320): Promise<void> {
    await runLocalMacMouseCommand([
      'drag',
      String(startX),
      String(startY),
      String(endX),
      String(endY),
      String(durationMs),
      '28',
      'direct',
    ]);
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await runLocalMacMouseCommand(['scroll', String(deltaX), String(deltaY)]);
  }

  async typeText(text: string, delayMs = 30): Promise<void> {
    const encoded = Buffer.from(text, 'utf-8').toString('base64');
    await runLocalMacMouseCommand(['typeText', encoded, String(delayMs)]);
  }

  async pressKeys(keys: string[], delayMs = 60): Promise<void> {
    const encoded = encodeBase64(keys);
    await runLocalMacMouseCommand(['pressKeys', encoded, String(delayMs)]);
  }

  getPointerPosition(): Promise<{ x: number; y: number } | null> {
    return getLocalMacPointerPosition();
  }

  async getActiveWindow(): Promise<ActiveWindowInfo | null> {
    const helper = await runLocalMacMouseCommand(['activeWindow']).catch(() => null);
    if (helper && typeof helper.name === 'string') {
      return parseActiveWindowFromHelper(helper);
    }
    try {
      const appName = await runOsascript(
        'tell application "System Events" to get name of first application process whose frontmost is true',
      );
      let title = '';
      try {
        title = await runOsascript(
          'tell application "System Events" to tell (first application process whose frontmost is true) to get value of attribute "AXTitle" of front window',
        );
      } catch {
        /* no front window */
      }
      const front = await runLocalMacMouseCommand(['frontmostApplication']).catch(() => null);
      return {
        appName,
        windowTitle: title,
        ownerId: typeof front?.bundleId === 'string' ? front.bundleId : null,
        pid: typeof front?.pid === 'number' ? front.pid : null,
        bounds: null,
        windowId: null,
      };
    } catch {
      return null;
    }
  }

  async listRunningApps(): Promise<RunningAppInfo[]> {
    try {
      const out = await runOsascript(
        'tell application "System Events" to get name of every application process whose background only is false',
      );
      return out
        .split(', ')
        .filter(Boolean)
        .map((name) => ({ name, ownerId: null, pid: null }));
    } catch {
      return [];
    }
  }

  async isFullscreen(): Promise<boolean> {
    try {
      const out = await runOsascript(
        'tell application "System Events" to tell (first application process whose frontmost is true) to get value of attribute "AXFullScreen" of front window',
      );
      return out.toLowerCase() === 'true';
    } catch {
      return false;
    }
  }

  async exitFullscreen(): Promise<void> {
    await this.pressKeys(['control', 'command', 'f']).catch(() => {});
  }

  async openApp(name: string): Promise<void> {
    await execFileAsync('open', ['-a', name], { timeout: 15000 });
  }

  async focusApp(name: string): Promise<void> {
    const script = 'on run argv\n  tell application (item 1 of argv) to activate\nend run';
    await execFileAsync('/usr/bin/osascript', ['-e', script, name], { timeout: 15000 });
  }

  async openUrl(url: string): Promise<void> {
    const { safeNavigateUrl } = await import('../safe-url.js');
    const safe = safeNavigateUrl(url);
    if (!safe) throw new Error(`Refusing to open non-http(s) URL: ${url}`);
    await shell.openExternal(safe);
  }

  async captureFocus(): Promise<FocusSnapshot | null> {
    const result = await runLocalMacMouseCommand(['frontmostApplication']).catch(() => null);
    if (!result || typeof result.name !== 'string') return null;
    return {
      appName: result.name,
      ownerId: typeof result.bundleId === 'string' ? result.bundleId : null,
      pid: typeof result.pid === 'number' ? result.pid : null,
      capturedAt: Date.now(),
    };
  }

  async restoreFocus(snapshot: FocusSnapshot): Promise<void> {
    if (snapshot.pid != null) {
      try {
        await runOsascript(
          `tell application "System Events" to set frontmost of first application process whose unix id is ${snapshot.pid} to true`,
        );
        return;
      } catch {
        /* fall through */
      }
    }
    if (snapshot.ownerId) {
      try {
        await execFileAsync('open', ['-b', snapshot.ownerId], { timeout: 5000 });
        return;
      } catch {
        /* fall through */
      }
    }
    if (snapshot.appName) {
      await this.focusApp(snapshot.appName).catch(() => {});
    }
  }

  async readFocusedTextField(): Promise<TextFieldSnapshot | null> {
    const result = await runLocalMacMouseCommand(['readFocusedTextField']).catch(() => null);
    if (!result || typeof result.rangeText !== 'string' || typeof result.elementSignature !== 'string') {
      return null;
    }
    const start = typeof result.selectedTextRangeLocation === 'number' ? result.selectedTextRangeLocation : 0;
    const length = typeof result.selectedTextRangeLength === 'number' ? result.selectedTextRangeLength : 0;
    return {
      value: result.rangeText,
      selectionStart: start,
      selectionEnd: start + length,
      elementSignature: result.elementSignature,
      role: null,
    };
  }

  async writeFocusedTextField(value: string, selectionStart?: number, _selectionEnd?: number): Promise<boolean> {
    const encoded = Buffer.from(value, 'utf-8').toString('base64');
    const cursor = selectionStart ?? value.length;
    const result = await runLocalMacMouseCommand(['writeFocusedTextField', encoded, String(cursor)]).catch(() => null);
    return result?.ok === true;
  }

  async getSelectedText(): Promise<string | null> {
    const result = await runLocalMacMouseCommand(['selectedText']).catch(() => null);
    return typeof result?.rangeText === 'string' ? result.rangeText : null;
  }

  async dumpUiTree(maxDepth: number): Promise<UiNode | null> {
    const result = await runLocalMacMouseCommand(['uiTree', String(maxDepth)]).catch(() => null);
    if (!result || !('uiTree' in result)) return null;
    return (result as LocalMacosHelperResponse & { uiTree?: UiNode }).uiTree ?? null;
  }

  startInputMonitor(onEvent: (event: InputMonitorEvent) => void, onError?: (err: string) => void): InputMonitorHandle {
    const handle = startLocalMacosTakeoverMonitor({
      onEvent: (event: LocalMacosTakeoverEvent) => {
        onEvent({
          kind: event.kind,
          eventType: event.eventType,
          x: event.x,
          y: event.y,
          keyCode: event.keyCode,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          timestampMs: event.timestampMs,
        });
      },
      onError,
    });
    return { stop: handle.stop };
  }

  async checkPermissions(): Promise<PlatformPermissions> {
    const perms = await getComputerUsePermissions({ probeInputMonitoring: false });
    return {
      platform: 'darwin',
      helperReady: perms.helperReady,
      message: perms.message,
      states: [
        { section: 'accessibility', granted: perms.accessibilityTrusted, label: 'Accessibility' },
        { section: 'screen-recording', granted: perms.screenRecordingGranted, label: 'Screen Recording' },
        { section: 'automation', granted: perms.automationGranted, label: 'Automation (Apple Events)' },
        { section: 'input-monitoring', granted: perms.inputMonitoringGranted, label: 'Input Monitoring' },
      ],
    };
  }

  async openPermissionSettings(section: PlatformPermissionSection): Promise<void> {
    if (
      section === 'accessibility' ||
      section === 'screen-recording' ||
      section === 'automation' ||
      section === 'input-monitoring'
    ) {
      await openLocalMacosPrivacySettings(section);
    }
  }
}

function parseActiveWindowFromHelper(
  result: LocalMacosHelperResponse & {
    windowTitle?: string;
    windowId?: string | number;
    bounds?: { x?: number; y?: number; width?: number; height?: number };
    url?: string;
  },
): ActiveWindowInfo {
  const bounds =
    result.bounds && typeof result.bounds.x === 'number'
      ? {
          x: Math.round(result.bounds.x ?? 0),
          y: Math.round(result.bounds.y ?? 0),
          width: Math.round(result.bounds.width ?? 0),
          height: Math.round(result.bounds.height ?? 0),
        }
      : null;
  return {
    appName: typeof result.name === 'string' ? result.name : '',
    windowTitle: typeof result.windowTitle === 'string' ? result.windowTitle : '',
    ownerId: typeof result.bundleId === 'string' ? result.bundleId : null,
    pid: typeof result.pid === 'number' ? result.pid : null,
    bounds,
    windowId: result.windowId != null ? String(result.windowId) : null,
    url: typeof result.url === 'string' ? result.url : null,
  };
}

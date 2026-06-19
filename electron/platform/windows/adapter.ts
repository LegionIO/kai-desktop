import { app, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ComputerDisplayLayout } from '../../../shared/computer-use.js';
import { HelperProcess } from '../helper-process.js';
import { safeNavigateUrl } from '../safe-url.js';
import {
  HelperUnavailable,
  type ActiveWindowInfo,
  type AdapterCapabilities,
  type Bounds,
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

export function resolveWindowsHelperPath(): string | null {
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, 'bin', 'LocalWindowsHelper.ps1');
    return existsSync(packaged) ? packaged : null;
  }
  const candidates = [
    join(process.cwd(), 'build', 'bin', 'LocalWindowsHelper.ps1'),
    join(process.cwd(), 'electron', 'platform', 'windows', 'LocalWindowsHelper.ps1'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

type WinHelperResponse = Record<string, unknown>;

export class WindowsAdapter implements NativePlatformAdapter {
  readonly kind = 'win32' as const;
  readonly capabilities: AdapterCapabilities = {
    screenshotDisplay: true,
    screenshotWindow: true,
    input: true,
    textIntrospection: true,
    uiTree: true,
    inputMonitor: true,
  };

  private helper: HelperProcess | null = null;

  private getHelper(): HelperProcess {
    if (this.helper) return this.helper;
    const path = resolveWindowsHelperPath();
    if (!path) throw new HelperUnavailable('LocalWindowsHelper.ps1 not found');
    this.helper = new HelperProcess(
      'powershell.exe',
      ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-STA', '-File', path],
      { defaultTimeoutMs: 15000 },
    );
    this.helper.start();
    return this.helper;
  }

  private call<T = WinHelperResponse>(cmd: string, args?: unknown, timeoutMs?: number): Promise<T> {
    return this.getHelper().call<T>(cmd, args, timeoutMs);
  }

  async screenshotDisplay(displayIndex = 0): Promise<ScreenshotResult> {
    const r = await this.call<{ imageBase64: string; width: number; height: number }>('screenshotDisplay', {
      displayIndex,
    });
    return { data: Buffer.from(r.imageBase64, 'base64'), width: r.width, height: r.height, mimeType: 'image/png' };
  }

  async screenshotWindow(windowId?: string | null): Promise<ScreenshotResult> {
    const r = await this.call<{ imageBase64: string; width: number; height: number }>('screenshotWindow', {
      hwnd: windowId ?? null,
    });
    return { data: Buffer.from(r.imageBase64, 'base64'), width: r.width, height: r.height, mimeType: 'image/png' };
  }

  async listDisplays(): Promise<ComputerDisplayLayout | undefined> {
    const r = await this.call<{ displays: ComputerDisplayLayout['displays'] }>('displays').catch(() => null);
    return r?.displays ? { displays: r.displays } : undefined;
  }

  async movePointer(x: number, y: number, durationMs = 0): Promise<void> {
    await this.call('move', { x, y, durationMs });
  }

  async click(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    await this.call('click', { x, y, button });
  }

  async doubleClick(x: number, y: number): Promise<void> {
    await this.call('doubleClick', { x, y });
  }

  async drag(startX: number, startY: number, endX: number, endY: number, durationMs = 200): Promise<void> {
    await this.call('drag', { startX, startY, endX, endY, durationMs });
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await this.call('scroll', { deltaX, deltaY });
  }

  async typeText(text: string, delayMs = 5): Promise<void> {
    await this.call('typeText', { text, delayMs });
  }

  async pressKeys(keys: string[], delayMs = 30): Promise<void> {
    await this.call('pressKeys', { keys, delayMs });
  }

  async getPointerPosition(): Promise<{ x: number; y: number } | null> {
    return this.call<{ x: number; y: number }>('pointer').catch(() => null);
  }

  async getActiveWindow(): Promise<ActiveWindowInfo | null> {
    const r = await this.call<{
      appName: string;
      windowTitle: string;
      ownerId: string | null;
      pid: number | null;
      bounds: Bounds | null;
      windowId: string | null;
      url?: string | null;
    }>('activeWindow').catch(() => null);
    return r ?? null;
  }

  async listRunningApps(): Promise<RunningAppInfo[]> {
    const r = await this.call<RunningAppInfo[]>('runningApps').catch(() => null);
    return r ?? [];
  }

  async isFullscreen(): Promise<boolean> {
    const r = await this.call<{ fullscreen: boolean }>('isFullscreen').catch(() => null);
    return r?.fullscreen === true;
  }

  async exitFullscreen(): Promise<void> {
    await this.call('exitFullscreen').catch(() => {});
  }

  async openApp(name: string): Promise<void> {
    await this.call('openApp', { name });
  }

  async focusApp(name: string): Promise<void> {
    await this.call('focusApp', { name });
  }

  async openUrl(url: string): Promise<void> {
    const safe = safeNavigateUrl(url);
    if (!safe) throw new Error(`Refusing to open non-http(s) URL: ${url}`);
    await shell.openExternal(safe);
  }

  async captureFocus(): Promise<FocusSnapshot | null> {
    const r = await this.call<{ appName: string; ownerId: string | null; pid: number | null; windowId: string | null }>(
      'captureFocus',
    ).catch(() => null);
    return r ? { ...r, capturedAt: Date.now() } : null;
  }

  async restoreFocus(snapshot: FocusSnapshot): Promise<void> {
    await this.call('restoreFocus', { hwnd: snapshot.windowId ?? null, pid: snapshot.pid ?? null }).catch(() => {});
  }

  async readFocusedTextField(): Promise<TextFieldSnapshot | null> {
    const r = await this.call<TextFieldSnapshot>('readTextField', undefined, 5000).catch(() => null);
    return r ?? null;
  }

  async writeFocusedTextField(value: string, selectionStart?: number, selectionEnd?: number): Promise<boolean> {
    const r = await this.call<{ ok: boolean }>('writeTextField', { value, selectionStart, selectionEnd }, 5000).catch(
      () => null,
    );
    return r?.ok === true;
  }

  async getSelectedText(): Promise<string | null> {
    const r = await this.call<{ text: string | null }>('selectedText', undefined, 5000).catch(() => null);
    return r?.text ?? null;
  }

  async dumpUiTree(maxDepth: number): Promise<UiNode | null> {
    const r = await this.call<{ root: UiNode | null }>('uiTree', { maxDepth }, 20000).catch(() => null);
    return r?.root ?? null;
  }

  startInputMonitor(onEvent: (event: InputMonitorEvent) => void, onError?: (err: string) => void): InputMonitorHandle {
    const helper = this.getHelper();
    const unsubscribe = helper.subscribe('input', (payload) => {
      const e = payload as unknown as InputMonitorEvent;
      onEvent({
        kind: e.kind === 'keyboard' || e.kind === 'mouse' ? e.kind : 'other',
        eventType: String(e.eventType),
        x: typeof e.x === 'number' ? e.x : 0,
        y: typeof e.y === 'number' ? e.y : 0,
        keyCode: typeof e.keyCode === 'number' ? e.keyCode : undefined,
        deltaX: typeof e.deltaX === 'number' ? e.deltaX : undefined,
        deltaY: typeof e.deltaY === 'number' ? e.deltaY : undefined,
        timestampMs: typeof e.timestampMs === 'number' ? e.timestampMs : Date.now(),
      });
    });
    helper.call('startMonitor', undefined, 2000).catch((err: unknown) => {
      onError?.(err instanceof Error ? err.message : String(err));
    });
    return {
      stop: () => {
        unsubscribe();
        helper.call('stopMonitor', undefined, 2000).catch(() => {});
      },
    };
  }

  async checkPermissions(): Promise<PlatformPermissions> {
    let helperReady = false;
    let message: string | undefined;
    try {
      await this.call('ping', undefined, 4000);
      helperReady = true;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    return {
      platform: 'win32',
      helperReady,
      message,
      states: [
        {
          section: 'helper-available',
          granted: helperReady,
          label: 'PowerShell helper',
          hint: helperReady ? undefined : 'powershell.exe must be on PATH with execution policy permitting -File',
        },
      ],
    };
  }

  async openPermissionSettings(section: PlatformPermissionSection): Promise<void> {
    if (section === 'helper-available') {
      await shell.openExternal('ms-settings:developers');
    }
  }
}

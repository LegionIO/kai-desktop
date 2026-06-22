import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { app, shell } from 'electron';
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

const execFileAsync = promisify(execFile);

function resolveHelperFile(name: string): string | null {
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, 'bin', name);
    return existsSync(packaged) ? packaged : null;
  }
  const candidates = [
    join(process.cwd(), 'build', 'bin', name),
    join(process.cwd(), 'electron', 'platform', 'linux', name),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveLinuxHelperPath(): string | null {
  return resolveHelperFile('LocalLinuxHelper.sh');
}

export function resolveAtspiHelperPath(): string | null {
  return resolveHelperFile('atspi_helper.py');
}

async function which(bin: string): Promise<boolean> {
  try {
    await execFileAsync('which', [bin], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

export type LinuxToolProbe = {
  xdotool: boolean;
  maim: boolean;
  scrot: boolean;
  grim: boolean;
  wtype: boolean;
  ydotool: boolean;
  jq: boolean;
  python3: boolean;
  atspi: boolean;
  wayland: boolean;
};

export async function probeLinuxTools(): Promise<LinuxToolProbe> {
  const [xdotool, maim, scrot, grim, wtype, ydotool, jq, python3] = await Promise.all([
    which('xdotool'),
    which('maim'),
    which('scrot'),
    which('grim'),
    which('wtype'),
    which('ydotool'),
    which('jq'),
    which('python3'),
  ]);
  let atspi = false;
  if (python3) {
    try {
      await execFileAsync('python3', ['-c', 'import gi; gi.require_version("Atspi", "2.0")'], { timeout: 4000 });
      atspi = true;
    } catch {
      /* AT-SPI not available */
    }
  }
  return {
    xdotool,
    maim,
    scrot,
    grim,
    wtype,
    ydotool,
    jq,
    python3,
    atspi,
    wayland: process.env.XDG_SESSION_TYPE === 'wayland',
  };
}

function codepointOffsetToUtf16(value: string, codepointOffset: number): number {
  if (codepointOffset <= 0) return 0;
  let utf16 = 0;
  let seen = 0;
  for (const ch of value) {
    if (seen >= codepointOffset) break;
    utf16 += ch.length;
    seen++;
  }
  return utf16;
}

function utf16OffsetToCodepoint(value: string, utf16Offset: number): number {
  if (utf16Offset <= 0) return 0;
  let utf16 = 0;
  let codepoints = 0;
  for (const ch of value) {
    if (utf16 >= utf16Offset) break;
    utf16 += ch.length;
    codepoints++;
  }
  return codepoints;
}

export class LinuxAdapter implements NativePlatformAdapter {
  readonly kind = 'linux' as const;

  private helper: HelperProcess | null = null;
  private atspiHelper: HelperProcess | null = null;
  private probe: LinuxToolProbe | null = null;
  private resolvedCapabilities: AdapterCapabilities = {
    screenshotDisplay: true,
    screenshotWindow: true,
    input: true,
    textIntrospection: false,
    uiTree: false,
    inputMonitor: false,
  };

  get capabilities(): AdapterCapabilities {
    return this.resolvedCapabilities;
  }

  private async ensureProbe(): Promise<LinuxToolProbe> {
    if (!this.probe) {
      this.probe = await probeLinuxTools();
      const hasPointer = this.probe.xdotool || this.probe.ydotool;
      this.resolvedCapabilities = {
        screenshotDisplay: this.probe.maim || this.probe.scrot || this.probe.grim,
        screenshotWindow: (this.probe.maim || this.probe.scrot) && this.probe.xdotool,
        input: hasPointer,
        textIntrospection: this.probe.atspi,
        uiTree: this.probe.atspi,
        inputMonitor: this.probe.xdotool,
      };
    }
    return this.probe;
  }

  private getHelper(): HelperProcess {
    if (this.helper) return this.helper;
    const path = resolveLinuxHelperPath();
    if (!path) throw new HelperUnavailable('LocalLinuxHelper.sh not found');
    const atspiPath = resolveAtspiHelperPath();
    this.helper = new HelperProcess('bash', [path], {
      defaultTimeoutMs: 15000,
      env: { ...process.env, KAI_ATSPI_HELPER: atspiPath ?? '' },
    });
    this.helper.start();
    return this.helper;
  }

  private getAtspiHelper(): HelperProcess | null {
    if (this.atspiHelper) return this.atspiHelper;
    const path = resolveAtspiHelperPath();
    if (!path) return null;
    this.atspiHelper = new HelperProcess('python3', [path], { defaultTimeoutMs: 8000 });
    this.atspiHelper.start();
    return this.atspiHelper;
  }

  private call<T = Record<string, unknown>>(cmd: string, args?: unknown, timeoutMs?: number): Promise<T> {
    return this.getHelper().call<T>(cmd, args, timeoutMs);
  }

  async screenshotDisplay(displayIndex = 0): Promise<ScreenshotResult> {
    await this.ensureProbe();
    const r = await this.call<{ imageBase64: string; width: number; height: number }>('screenshotDisplay', {
      displayIndex,
    });
    return { data: Buffer.from(r.imageBase64, 'base64'), width: r.width, height: r.height, mimeType: 'image/png' };
  }

  async screenshotWindow(windowId?: string | null): Promise<ScreenshotResult> {
    await this.ensureProbe();
    const r = await this.call<{ imageBase64: string; width: number; height: number }>('screenshotWindow', {
      windowId: windowId ?? null,
    });
    return { data: Buffer.from(r.imageBase64, 'base64'), width: r.width, height: r.height, mimeType: 'image/png' };
  }

  async listDisplays(): Promise<ComputerDisplayLayout | undefined> {
    const r = await this.call<{ displays: ComputerDisplayLayout['displays'] }>('displays').catch(() => null);
    return r?.displays ? { displays: r.displays } : undefined;
  }

  async movePointer(x: number, y: number, _durationMs?: number): Promise<void> {
    await this.call('move', { x, y });
  }

  async click(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    await this.call('click', { x, y, button });
  }

  async doubleClick(x: number, y: number): Promise<void> {
    await this.call('doubleClick', { x, y });
  }

  async drag(startX: number, startY: number, endX: number, endY: number, _durationMs?: number): Promise<void> {
    await this.call('drag', { startX, startY, endX, endY });
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await this.call('scroll', { deltaX, deltaY });
  }

  async typeText(text: string, delayMs = 12): Promise<void> {
    await this.call('typeText', { text, delayMs });
  }

  async pressKeys(keys: string[], _delayMs?: number): Promise<void> {
    await this.call('pressKeys', { keys });
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
    await this.pressKeys(['F11']).catch(() => {});
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

  async restoreFocus(snapshot: FocusSnapshot): Promise<void> {
    await this.call('restoreFocus', { windowId: snapshot.windowId ?? null, pid: snapshot.pid ?? null }).catch(() => {});
  }

  async readFocusedTextField(): Promise<TextFieldSnapshot | null> {
    await this.ensureProbe();
    if (!this.resolvedCapabilities.textIntrospection) return null;
    const helper = this.getAtspiHelper();
    if (!helper) return null;
    const raw = await helper.call<TextFieldSnapshot>('readTextField', undefined, 5000).catch(() => null);
    if (!raw) return null;
    // AT-SPI reports caret/selection in Unicode codepoint offsets; normalize to
    // UTF-16 code units per the TextFieldSnapshot contract.
    return {
      ...raw,
      selectionStart: codepointOffsetToUtf16(raw.value, raw.selectionStart),
      selectionEnd: codepointOffsetToUtf16(raw.value, raw.selectionEnd),
    };
  }

  async writeFocusedTextField(value: string, selectionStart?: number, selectionEnd?: number): Promise<boolean> {
    await this.ensureProbe();
    if (!this.resolvedCapabilities.textIntrospection) return false;
    const helper = this.getAtspiHelper();
    if (!helper) return false;
    const r = await helper
      .call<{ ok: boolean }>(
        'writeTextField',
        {
          value,
          selectionStart: selectionStart != null ? utf16OffsetToCodepoint(value, selectionStart) : undefined,
          selectionEnd: selectionEnd != null ? utf16OffsetToCodepoint(value, selectionEnd) : undefined,
        },
        5000,
      )
      .catch(() => null);
    return r?.ok === true;
  }

  async getSelectedText(): Promise<string | null> {
    await this.ensureProbe();
    const helper = this.getAtspiHelper();
    if (helper) {
      const r = await helper.call<{ text: string | null }>('selectedText', undefined, 5000).catch(() => null);
      if (r && typeof r.text === 'string') return r.text;
    }
    const sel = await this.call<{ text: string | null }>('primarySelection').catch(() => null);
    return sel?.text ?? null;
  }

  async dumpUiTree(
    maxDepth: number,
    target?: { pid?: number | null; windowId?: string | null },
  ): Promise<UiNode | null> {
    await this.ensureProbe();
    if (!this.resolvedCapabilities.uiTree) return null;
    const helper = this.getAtspiHelper();
    if (!helper) return null;
    const r = await helper
      .call<{
        root: UiNode | null;
      }>('uiTree', { maxDepth, pid: target?.pid ?? null, windowId: target?.windowId ?? null }, 20000)
      .catch(() => null);
    return r?.root ?? null;
  }

  startInputMonitor(onEvent: (event: InputMonitorEvent) => void, onError?: (err: string) => void): InputMonitorHandle {
    let helper: HelperProcess;
    try {
      helper = this.getHelper();
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
      return { stop: () => {} };
    }
    const unsubscribe = helper.subscribe('input', (payload) => {
      const e = payload as unknown as InputMonitorEvent;
      onEvent({
        kind: e.kind === 'keyboard' || e.kind === 'mouse' ? e.kind : 'other',
        eventType: String(e.eventType ?? ''),
        x: typeof e.x === 'number' ? e.x : 0,
        y: typeof e.y === 'number' ? e.y : 0,
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
    const probe = await this.ensureProbe();
    const helperPath = resolveLinuxHelperPath();
    const screenshotTool = probe.maim ? 'maim' : probe.scrot ? 'scrot' : probe.grim ? 'grim' : null;
    const hasPointer = probe.xdotool || probe.ydotool;
    const helperReady = helperPath !== null && probe.jq && hasPointer && screenshotTool !== null;
    return {
      platform: 'linux',
      helperReady,
      message: helperReady
        ? undefined
        : probe.wayland
          ? 'Install ydotool (with /dev/uinput access) for pointer + keyboard, grim for screenshots, and jq. wtype alone is keyboard-only and not sufficient.'
          : 'Install xdotool for pointer + keyboard, maim or scrot for screenshots, and jq.',
      states: [
        {
          section: 'helper-available',
          granted: helperPath !== null && probe.jq,
          label: 'Linux helper script',
          hint: probe.jq ? undefined : 'jq is required to parse helper requests',
        },
        {
          section: 'xdotool',
          granted: hasPointer,
          label: probe.wayland ? 'Pointer tool (ydotool)' : 'Pointer tool (xdotool)',
          hint: probe.wayland
            ? 'Install ydotool (with uinput access) for mouse + keyboard input on Wayland; wtype alone is keyboard-only'
            : 'Install xdotool for mouse + keyboard input on X11',
        },
        {
          section: 'screenshot-tool',
          granted: screenshotTool !== null,
          label: `Screenshot tool${screenshotTool ? ` (${screenshotTool})` : ''}`,
          hint: 'Install maim or scrot (X11) or grim (Wayland)',
        },
        {
          section: 'at-spi',
          granted: probe.atspi,
          label: 'AT-SPI text introspection',
          hint: 'Install python3-gi and at-spi2-core for text-field reading',
        },
      ],
    };
  }

  async openPermissionSettings(_section: PlatformPermissionSection): Promise<void> {
    return Promise.resolve();
  }
}

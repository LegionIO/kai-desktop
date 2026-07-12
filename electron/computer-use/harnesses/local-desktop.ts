import { app, BrowserWindow, nativeImage } from 'electron';
import type {
  ComputerActionProposal,
  ComputerEnvironmentMetadata,
  ComputerFrame,
  ComputerSession,
} from '../../../shared/computer-use.js';
import { makeComputerUseId, nowIso, primaryDisplayIndex } from '../../../shared/computer-use.js';
import type { AppConfig } from '../../config/schema.js';
import { getFallbackAdapter, getPlatformAdapter } from '../../platform/index.js';
import { getPlatformCapabilities } from '../../platform/capabilities.js';
import type { NativePlatformAdapter } from '../../platform/types.js';
import { suppressTakeoverEvents } from '../takeover-monitor.js';
import type { ComputerHarness, ComputerHarnessActionContext, ComputerHarnessActionResult } from './shared.js';

const DEFAULT_MAX_FRAME_DIMENSION = 1920;

/** Anthropic's vision pipeline downscales images whose long edge exceeds ~1568px. */
const ANTHROPIC_VISION_MAX_EDGE = 1568;

// Module-level so a paused/aborted session that drops its harness instance
// can still be recovered by the next initialize(), dispose(), or by the user
// activating the app from the taskbar/dock.
const hiddenLocalDesktopWindows = new Set<BrowserWindow>();
let activateHookInstalled = false;

export function restoreLocalDesktopWindows(): void {
  for (const win of hiddenLocalDesktopWindows) {
    if (!win.isDestroyed()) win.showInactive();
  }
  hiddenLocalDesktopWindows.clear();
}

function ensureActivateRecoveryHook(): void {
  if (activateHookInstalled) return;
  activateHookInstalled = true;
  app.on('activate', restoreLocalDesktopWindows);
  app.on('before-quit', restoreLocalDesktopWindows);
}

/**
 * Cross-platform local-desktop harness.
 *
 * Used on Windows and Linux (and as a safety net on macOS when the Swift
 * helper is unavailable). All actions delegate to the platform adapter so
 * the orchestrator/session-manager logic written for `'local-macos'` works
 * unchanged — this harness reports the same `'local-macos'` target string to
 * preserve wire-protocol stability.
 */
export class LocalDesktopHarness implements ComputerHarness {
  readonly target = 'local-macos' as const;
  private readonly getConfig: () => AppConfig;
  private adapter: NativePlatformAdapter | null = null;

  constructor(getConfig: () => AppConfig) {
    this.getConfig = getConfig;
    ensureActivateRecoveryHook();
  }

  private hideOwnWindows(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.isVisible() && !hiddenLocalDesktopWindows.has(win)) {
        hiddenLocalDesktopWindows.add(win);
        win.hide();
      }
    }
  }

  private async getAdapter(): Promise<NativePlatformAdapter> {
    if (!this.adapter) this.adapter = await getPlatformAdapter();
    return this.adapter;
  }

  private async withFallback<T>(fn: (a: NativePlatformAdapter) => Promise<T>): Promise<T> {
    const adapter = await this.getAdapter();
    try {
      return await fn(adapter);
    } catch {
      return fn(getFallbackAdapter());
    }
  }

  private async suppressedInput<T>(estimatedMs: number, fn: (a: NativePlatformAdapter) => Promise<T>): Promise<T> {
    suppressTakeoverEvents(estimatedMs + 400);
    try {
      return await this.withFallback(fn);
    } finally {
      suppressTakeoverEvents(250);
    }
  }

  async initialize(_session: ComputerSession): Promise<void> {
    // Privacy consent gate (ADR-0005 experimental-on). On Windows/Linux this
    // harness screenshots ALL displays via nut-js with NO OS screen-recording
    // consent prompt (macOS gates capture via the TCC screen-recording
    // permission; nut-js has no equivalent). So on a platform where local
    // computer use is only EXPERIMENTAL, refuse to start a session until the
    // user has explicitly opted in via computerUse.safety.experimentalScreenCaptureConsent.
    // Fail-closed: no consent → clean error surfaced as a failed action, no capture.
    if (getPlatformCapabilities().computerUseLocal.experimental) {
      if (!this.getConfig().computerUse.safety.experimentalScreenCaptureConsent) {
        throw new Error(
          'Local computer use is experimental on this platform and captures your screen. ' +
            'Enable "Allow experimental screen capture" in Computer Use settings to try it.',
        );
      }
    }

    const adapter = await this.getAdapter();
    const perms = await adapter.checkPermissions();
    if (!perms.helperReady) {
      const fallbackPerms = await getFallbackAdapter()
        .checkPermissions()
        .catch(() => null);
      if (!fallbackPerms?.helperReady) {
        throw new Error(perms.message ?? fallbackPerms?.message ?? 'Local desktop helper is unavailable.');
      }
    }
    restoreLocalDesktopWindows();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.isFullScreen()) {
        win.setFullScreen(false);
        await new Promise<void>((resolve) => {
          const onLeave = () => resolve();
          win.once('leave-full-screen', onLeave);
          setTimeout(() => {
            win.removeListener('leave-full-screen', onLeave);
            resolve();
          }, 2000);
        });
      }
    }
  }

  async dispose(_sessionId: string): Promise<void> {
    restoreLocalDesktopWindows();
  }

  async captureFrame(session: ComputerSession): Promise<ComputerFrame> {
    const config = this.getConfig();
    const configuredMax = config.computerUse.capture.maxDimension ?? DEFAULT_MAX_FRAME_DIMENSION;
    const maxDimension =
      session.providerAdapter === 'anthropic-client-tool'
        ? Math.min(configuredMax, ANTHROPIC_VISION_MAX_EDGE)
        : configuredMax;

    const layout = await (await this.getAdapter()).listDisplays().catch(() => undefined);
    const primary = layout?.displays.find((d) => d.isPrimary) ?? layout?.displays[0];

    // The macOS harness excludes its own PID at the compositor level via the
    // Swift helper. Windows/Linux helpers have no equivalent, so hide our own
    // windows so the model never sees Kai. In autonomous mode they stay
    // hidden for the session lifetime (restored in `dispose()`) so actions
    // never land on a re-shown Kai window. In step/goal mode the main window
    // hosts the approval UI, so we restore it after each capture and rely on
    // the user keeping it clear of the target while approving.
    const persistHide = session.approvalMode === 'autonomous' && session.status === 'running';
    const hadVisible =
      hiddenLocalDesktopWindows.size === 0 &&
      BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible());
    this.hideOwnWindows();
    if (hadVisible) {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    const displayFrames: NonNullable<ComputerFrame['displayFrames']> = [];
    let primaryFrame: {
      dataUrl: string;
      width: number;
      height: number;
      nativeWidth: number;
      nativeHeight: number;
    } | null = null;
    try {
      const targets = layout?.displays.length ? layout.displays : [primary ?? { displayIndex: 0, name: 'Primary' }];
      for (const display of targets) {
        try {
          const shot = await this.withFallback((a) => a.screenshotDisplay(display.displayIndex));
          const resized = resizeForModel(shot.data, shot.width, shot.height, maxDimension);
          const dataUrl = `data:image/jpeg;base64,${resized.data.toString('base64')}`;
          displayFrames.push({
            displayIndex: display.displayIndex,
            displayName: display.name,
            dataUrl,
            width: resized.width,
            height: resized.height,
            nativeWidth: shot.width,
            nativeHeight: shot.height,
          });
          if (display.displayIndex === (primary?.displayIndex ?? 0)) {
            primaryFrame = {
              dataUrl,
              width: resized.width,
              height: resized.height,
              nativeWidth: shot.width,
              nativeHeight: shot.height,
            };
          }
        } catch (error) {
          if (display.displayIndex === (primary?.displayIndex ?? 0)) throw error;
        }
      }
    } finally {
      if (!persistHide) restoreLocalDesktopWindows();
    }

    if (!primaryFrame) {
      const first = displayFrames[0];
      if (!first) throw new Error('Screenshot capture failed for all displays');
      primaryFrame = {
        dataUrl: first.dataUrl,
        width: first.width,
        height: first.height,
        nativeWidth: first.nativeWidth ?? first.width,
        nativeHeight: first.nativeHeight ?? first.height,
      };
    }

    // Only advertise the displays we actually captured so the prompt and the
    // image set agree.
    const capturedIndices = new Set(displayFrames.map((f) => f.displayIndex));
    const finalLayout = layout
      ? { displays: layout.displays.filter((d) => capturedIndices.has(d.displayIndex)) }
      : undefined;

    return {
      id: makeComputerUseId('frame'),
      sessionId: session.id,
      createdAt: nowIso(),
      mimeType: 'image/jpeg',
      dataUrl: primaryFrame.dataUrl,
      width: primaryFrame.width,
      height: primaryFrame.height,
      nativeWidth: primaryFrame.nativeWidth,
      nativeHeight: primaryFrame.nativeHeight,
      source: 'local-macos',
      displayLayout: finalLayout,
      displayFrames,
    };
  }

  private resolveSpace(
    session: ComputerSession,
    displayIndex?: number,
  ): {
    frameWidth: number;
    frameHeight: number;
    logicalWidth: number;
    logicalHeight: number;
    originX: number;
    originY: number;
  } {
    const layout = session.displayLayout ?? session.latestFrame?.displayLayout;
    const resolvedIndex = displayIndex ?? primaryDisplayIndex(layout);
    const display = layout?.displays.find((d) => d.displayIndex === resolvedIndex);
    if (layout && layout.displays.length > 0 && !display) {
      const valid = layout.displays.map((d) => d.displayIndex).join(', ');
      throw new Error(`Action targets displayIndex ${resolvedIndex}, but only [${valid}] are available.`);
    }
    const displayFrame = session.latestFrame?.displayFrames?.find((f) => f.displayIndex === resolvedIndex);
    const frameWidth = Math.max(1, displayFrame?.width ?? session.latestFrame?.width ?? 1);
    const frameHeight = Math.max(1, displayFrame?.height ?? session.latestFrame?.height ?? 1);
    return {
      frameWidth,
      frameHeight,
      logicalWidth: Math.max(
        1,
        display?.logicalWidth ?? displayFrame?.nativeWidth ?? session.latestFrame?.nativeWidth ?? frameWidth,
      ),
      logicalHeight: Math.max(
        1,
        display?.logicalHeight ?? displayFrame?.nativeHeight ?? session.latestFrame?.nativeHeight ?? frameHeight,
      ),
      originX: display?.globalX ?? 0,
      originY: display?.globalY ?? 0,
    };
  }

  private toDesktop(session: ComputerSession, x: number, y: number, displayIndex?: number): { x: number; y: number } {
    const s = this.resolveSpace(session, displayIndex);
    const fx = Math.max(0, Math.min(x, s.frameWidth - 1));
    const fy = Math.max(0, Math.min(y, s.frameHeight - 1));
    return {
      x: Math.round(s.originX + (fx / s.frameWidth) * s.logicalWidth),
      y: Math.round(s.originY + (fy / s.frameHeight) * s.logicalHeight),
    };
  }

  private toFrame(session: ComputerSession, x: number, y: number, displayIndex?: number): { x: number; y: number } {
    const s = this.resolveSpace(session, displayIndex);
    return {
      x: Math.round(((x - s.originX) / s.logicalWidth) * s.frameWidth),
      y: Math.round(((y - s.originY) / s.logicalHeight) * s.frameHeight),
    };
  }

  private async cursorResult(
    session: ComputerSession,
    prefix: string,
    requestedFrame: { x: number; y: number },
    desktopTarget: { x: number; y: number },
    displayIndex?: number,
  ): Promise<ComputerHarnessActionResult> {
    const adapter = await this.getAdapter();
    const pos = await adapter.getPointerPosition().catch(() => null);
    const actualFrame = pos ? this.toFrame(session, pos.x, pos.y, displayIndex) : requestedFrame;
    return {
      summary: `${prefix} ${desktopTarget.x}, ${desktopTarget.y}.`,
      cursor: { x: actualFrame.x, y: actualFrame.y, visible: true, displayIndex },
    };
  }

  async movePointer(
    session: ComputerSession,
    action: ComputerActionProposal,
    _context?: ComputerHarnessActionContext,
  ): Promise<ComputerHarnessActionResult> {
    const requested = { x: action.x ?? 0, y: action.y ?? 0 };
    const target = this.toDesktop(session, requested.x, requested.y, action.displayIndex);
    const duration = action.waitMs ?? 120;
    await this.suppressedInput(duration, (a) => a.movePointer(target.x, target.y, duration));
    return this.cursorResult(session, 'Moved pointer to', requested, target, action.displayIndex);
  }

  async click(session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const requested = { x: action.x ?? 0, y: action.y ?? 0 };
    const target = this.toDesktop(session, requested.x, requested.y, action.displayIndex);
    await this.suppressedInput(200, (a) => a.click(target.x, target.y));
    return this.cursorResult(session, 'Clicked at', requested, target, action.displayIndex);
  }

  async doubleClick(session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const requested = { x: action.x ?? 0, y: action.y ?? 0 };
    const target = this.toDesktop(session, requested.x, requested.y, action.displayIndex);
    await this.suppressedInput(300, (a) => a.doubleClick(target.x, target.y));
    return this.cursorResult(session, 'Double-clicked at', requested, target, action.displayIndex);
  }

  async drag(session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const requestedStart = { x: action.x ?? 0, y: action.y ?? 0 };
    const requestedEnd = { x: action.endX ?? requestedStart.x, y: action.endY ?? requestedStart.y };
    const start = this.toDesktop(session, requestedStart.x, requestedStart.y, action.displayIndex);
    const end = this.toDesktop(session, requestedEnd.x, requestedEnd.y, action.displayIndex);
    const duration = action.waitMs ?? 200;
    await this.suppressedInput(duration, (a) => a.drag(start.x, start.y, end.x, end.y, duration));
    return this.cursorResult(session, `Dragged from ${start.x}, ${start.y} to`, requestedEnd, end, action.displayIndex);
  }

  async scroll(session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const dx = Math.round(action.deltaX ?? 0);
    const dy = Math.round(action.deltaY ?? 0);
    if (action.x != null && action.y != null) {
      const target = this.toDesktop(session, action.x, action.y, action.displayIndex);
      await this.suppressedInput(50, (a) => a.movePointer(target.x, target.y, 0));
    }
    await this.suppressedInput(150, (a) => a.scroll(dx, dy));
    return { summary: `Scrolled by ${dx}, ${dy}.` };
  }

  async typeText(_session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const text = action.text ?? '';
    const estimated = Math.min(10000, text.length * Math.max(5, action.waitMs ?? 5) + 200);
    await this.suppressedInput(estimated, (a) => a.typeText(text, action.waitMs));
    return { summary: `Typed ${JSON.stringify(text)}.` };
  }

  async pressKeys(_session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const keys = action.keys ?? [];
    await this.suppressedInput(200, (a) => a.pressKeys(keys, action.waitMs));
    return { summary: `Pressed keys: ${keys.join(' + ') || 'Enter'}.` };
  }

  async openApp(_session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const name = action.appName?.trim();
    if (!name) throw new Error('Open app requires appName.');
    await this.withFallback((a) => a.openApp(name));
    return { summary: `Opened ${name}.` };
  }

  async focusWindow(_session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const name = action.appName?.trim();
    if (!name) throw new Error('Focus window requires appName.');
    await this.withFallback((a) => a.focusApp(name));
    return { summary: `Focused ${name}.` };
  }

  async navigate(_session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const url = action.url?.trim();
    if (!url) throw new Error('Navigation requires a URL.');
    const adapter = await this.getAdapter();
    await adapter.openUrl(url);
    return { summary: `Opened ${url}.` };
  }

  async waitForIdle(_session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const waitMs = Math.max(250, Math.min(action.waitMs ?? 1000, 10000));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return { summary: `Waited ${waitMs}ms.` };
  }

  async getEnvironmentMetadata(_session: ComputerSession): Promise<ComputerEnvironmentMetadata> {
    const adapter = await this.getAdapter();
    const win = await adapter.getActiveWindow().catch(() => null);
    const perms = await adapter.checkPermissions().catch(() => null);
    return {
      appName: win?.appName,
      windowTitle: win?.windowTitle,
      permissionState: {
        accessibility: perms?.helperReady ?? false,
        screenRecording: perms?.states.find((s) => s.section === 'screenshot-tool')?.granted ?? true,
        automation: perms?.helperReady ?? false,
      },
    };
  }
}

function resizeForModel(
  data: Buffer,
  width: number,
  height: number,
  maxDimension: number,
): { data: Buffer; width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxDimension) {
    const image = nativeImage.createFromBuffer(data);
    return { data: Buffer.from(image.toJPEG(85)), width, height };
  }
  const scale = maxDimension / longest;
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const image = nativeImage.createFromBuffer(data);
  const resized = image.resize({ width: targetWidth, height: targetHeight, quality: 'better' });
  const actual = resized.getSize();
  return {
    data: Buffer.from(resized.toJPEG(85)),
    width: actual.width > 0 ? actual.width : targetWidth,
    height: actual.height > 0 ? actual.height : targetHeight,
  };
}

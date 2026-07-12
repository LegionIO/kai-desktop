import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserWindow, nativeImage } from 'electron';
import type {
  ComputerActionProposal,
  ComputerDisplayInfo,
  ComputerEnvironmentMetadata,
  ComputerFrame,
  ComputerSession,
} from '../../../shared/computer-use.js';
import { makeComputerUseId, nowIso, primaryDisplayIndex } from '../../../shared/computer-use.js';
import type { AppConfig } from '../../config/schema.js';
import {
  buildDisplayLayout,
  buildSwiftFallbackEnv,
  getComputerUsePermissions,
  getLocalMacDisplayLayout,
  getLocalMacPointerPosition,
  resolveCompiledHelperBinary,
  resolveMaterializedHelperPath,
  runLocalMacMouseCommand,
} from '../permissions.js';
import type { ComputerHarness, ComputerHarnessActionContext, ComputerHarnessActionResult } from './shared.js';
import { safeNavigateUrl } from '../../platform/safe-url.js';

const execFileAsync = promisify(execFile);

/**
 * Maximum pixel dimension (longest side) for screenshots sent to the AI model.
 * Vision models internally downscale large images and then output coordinates in
 * that smaller space.  By resizing to a known size up-front we ensure the
 * model's coordinate output matches the frame dimensions stored in the session,
 * and the existing toDesktopPoint() math correctly scales them back to the real
 * desktop resolution.  The default (1920) is chosen because it matches common
 * display widths where computer-use is already known to work reliably.
 * Configurable via `computerUse.capture.maxDimension`.
 */
const DEFAULT_MAX_FRAME_DIMENSION = 1920;

/** Anthropic's vision pipeline downscales images whose long edge exceeds ~1568px. */
const ANTHROPIC_VISION_MAX_EDGE = 1568;

const LOCAL_MACOS_HELPER_COMMANDS = {
  permissions: 'permissions',
  move: 'move',
  click: 'click',
  doubleClick: 'doubleClick',
  drag: 'drag',
  scroll: 'scroll',
  typeText: 'typeText',
  pressKeys: 'pressKeys',
  pointer: 'pointer',
  monitor: 'monitor',
  screenshot: 'screenshot',
} as const;

type LocalMacosHelperCommand = (typeof LOCAL_MACOS_HELPER_COMMANDS)[keyof typeof LOCAL_MACOS_HELPER_COMMANDS];

export type LocalMacosTakeoverEvent = {
  event: 'takeover';
  kind: 'mouse' | 'keyboard' | 'other';
  eventType: string;
  x: number;
  y: number;
  keyCode?: number;
  deltaX?: number;
  deltaY?: number;
  timestampMs: number;
};

function parseMonitorLine(line: string): LocalMacosTakeoverEvent | null {
  if (!line.trim()) return null;
  try {
    const payload = JSON.parse(line) as {
      event?: string;
      kind?: string;
      eventType?: string;
      x?: number;
      y?: number;
      keyCode?: number;
      deltaX?: number;
      deltaY?: number;
      timestampMs?: number;
    };
    if (payload.event !== 'takeover') return null;
    if (typeof payload.kind !== 'string' || typeof payload.eventType !== 'string') return null;
    if (typeof payload.x !== 'number' || typeof payload.y !== 'number' || typeof payload.timestampMs !== 'number')
      return null;
    return {
      event: 'takeover',
      kind: payload.kind === 'keyboard' || payload.kind === 'mouse' ? payload.kind : 'other',
      eventType: payload.eventType,
      x: payload.x,
      y: payload.y,
      ...(typeof payload.keyCode === 'number' ? { keyCode: payload.keyCode } : {}),
      ...(typeof payload.deltaX === 'number' ? { deltaX: payload.deltaX } : {}),
      ...(typeof payload.deltaY === 'number' ? { deltaY: payload.deltaY } : {}),
      timestampMs: payload.timestampMs,
    };
  } catch {
    return null;
  }
}

export type LocalMacosTakeoverMonitorHandle = {
  process: ChildProcessWithoutNullStreams;
  stop: () => void;
};

export function startLocalMacosTakeoverMonitor(params: {
  onEvent: (event: LocalMacosTakeoverEvent) => void;
  onError?: (error: string) => void;
}): LocalMacosTakeoverMonitorHandle {
  // Prefer the pre-compiled binary; fall back to xcrun swift interpretation
  const binaryPath = resolveCompiledHelperBinary();
  let child: ChildProcessWithoutNullStreams;

  if (binaryPath) {
    child = spawn(binaryPath, [LOCAL_MACOS_HELPER_COMMANDS.monitor], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } else {
    const helperPath = resolveMaterializedHelperPath();
    child = spawn('xcrun', ['swift', helperPath, LOCAL_MACOS_HELPER_COMMANDS.monitor], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSwiftFallbackEnv(),
    });
  }

  let stdoutBuffer = '';
  // Cap the unparsed-line buffer: the trusted helper emits compact newline-
  // terminated JSON, so a line this long means a helper bug/compromise — drop it
  // rather than grow memory unbounded waiting for a newline that never comes.
  const MAX_MONITOR_LINE_BYTES = 64 * 1024;
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    while (true) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline === -1) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      const event = parseMonitorLine(line);
      if (event) {
        params.onEvent(event);
      }
    }
    if (stdoutBuffer.length > MAX_MONITOR_LINE_BYTES) {
      stdoutBuffer = '';
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) params.onError?.(text);
  });

  child.on('error', (error) => {
    params.onError?.(error.message);
  });

  return {
    process: child,
    stop: () => {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    },
  };
}

async function runAppleScript(script: string): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 15000 });
  return stdout.trim();
}

function helperArgs(command: LocalMacosHelperCommand, args: Array<string | number>): string[] {
  return [command, ...args.map((value) => String(value))];
}

function buildResult(summary: string, cursor?: { x: number; y: number }): ComputerHarnessActionResult {
  return {
    summary,
    ...(cursor ? { cursor: { x: cursor.x, y: cursor.y, visible: true } } : {}),
  };
}

/**
 * Validate a model-supplied app name for `open -a` / `focusWindow`. Name-only:
 * reject a path (so a bundle can't be launched by absolute/relative path) and a
 * leading dash (defense-in-depth against option-like values). Returns the
 * trimmed name or throws.
 */
export function resolveAppName(raw: string | undefined, verb: string): string {
  const name = raw?.trim();
  if (!name) throw new Error(`${verb} requires appName.`);
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(`Refusing to ${verb.toLowerCase()} a path; provide an application name, not a path: ${name}`);
  }
  if (name.startsWith('-')) {
    throw new Error(`Refusing an application name that begins with '-': ${name}`);
  }
  return name;
}

function resolveMovementPath(
  action: ComputerActionProposal,
): 'teleport' | 'direct' | 'horizontal-first' | 'vertical-first' {
  return action.movementPath;
}

async function resolveActualCursor(fallback: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const actual = await getLocalMacPointerPosition().catch(() => null);
  if (!actual) return fallback;
  return {
    x: Math.round(actual.x),
    y: Math.round(actual.y),
  };
}

function summarizePointerAction(
  prefix: string,
  requested: { x: number; y: number },
  actual: { x: number; y: number },
  movementPath: 'teleport' | 'direct' | 'horizontal-first' | 'vertical-first',
): string {
  const pathSuffix = movementPath === 'direct' ? '' : ' via ' + movementPath;
  const rx = Math.round(requested.x);
  const ry = Math.round(requested.y);
  if (rx === actual.x && ry === actual.y) {
    return prefix + ' ' + rx + ', ' + ry + pathSuffix + '.';
  }
  return prefix + ' ' + rx + ', ' + ry + pathSuffix + ' (actual ' + actual.x + ', ' + actual.y + ').';
}

type LocalMacModelFrameConfig = AppConfig['computerUse']['capture']['modelFrame'];

/**
 * Resize a native screenshot into the model-facing coordinate space.
 *
 * The model emits pointer coordinates in this resized image space. The action
 * executor maps those coordinates back across the native display's logical
 * bounds before posting macOS events.
 */
function resizeFrameForModel(
  data: Buffer,
  originalSize: { width: number; height: number },
  modelFrame: LocalMacModelFrameConfig | undefined,
  maxFrameDimension?: number,
): { data: Buffer; width: number; height: number; nativeWidth: number; nativeHeight: number } {
  const nativeWidth = originalSize.width;
  const nativeHeight = originalSize.height;
  let targetWidth = nativeWidth;
  let targetHeight = nativeHeight;

  if (modelFrame?.mode === 'canonical') {
    const canonicalWidth = Math.max(1, Math.round(modelFrame.width || 1366));
    const canonicalHeight = Math.max(1, Math.round(modelFrame.height || 768));
    const originalAspect = nativeWidth / Math.max(nativeHeight, 1);
    const canonicalAspect = canonicalWidth / Math.max(canonicalHeight, 1);
    const canUseExactCanonical =
      nativeWidth >= canonicalWidth &&
      nativeHeight >= canonicalHeight &&
      Math.abs(originalAspect - canonicalAspect) / Math.max(canonicalAspect, 0.0001) < 0.01;

    if (canUseExactCanonical) {
      targetWidth = canonicalWidth;
      targetHeight = canonicalHeight;
    } else {
      const scale = Math.min(1, canonicalWidth / Math.max(nativeWidth, 1), canonicalHeight / Math.max(nativeHeight, 1));
      targetWidth = Math.max(1, Math.round(nativeWidth * scale));
      targetHeight = Math.max(1, Math.round(nativeHeight * scale));
    }
  } else {
    const maxDim = maxFrameDimension ?? DEFAULT_MAX_FRAME_DIMENSION;
    const longest = Math.max(nativeWidth, nativeHeight);
    if (longest > maxDim) {
      const scale = maxDim / longest;
      targetWidth = Math.max(1, Math.round(nativeWidth * scale));
      targetHeight = Math.max(1, Math.round(nativeHeight * scale));
    }
  }

  if (targetWidth === nativeWidth && targetHeight === nativeHeight) {
    return { data, width: nativeWidth, height: nativeHeight, nativeWidth, nativeHeight };
  }

  const image = nativeImage.createFromBuffer(data);
  const resized = image.resize({ width: targetWidth, height: targetHeight, quality: 'better' });
  const actual = resized.getSize();
  const jpegBuffer = resized.toJPEG(85);

  return {
    data: Buffer.from(jpegBuffer),
    width: actual.width > 0 ? actual.width : targetWidth,
    height: actual.height > 0 ? actual.height : targetHeight,
    nativeWidth,
    nativeHeight,
  };
}

export class LocalMacosHarness implements ComputerHarness {
  readonly target = 'local-macos' as const;
  private readonly getConfig: () => AppConfig;

  constructor(getConfig: () => AppConfig) {
    this.getConfig = getConfig;
  }

  async initialize(_session: ComputerSession): Promise<void> {
    // Skip the input monitoring probe here — this runs at session start when the
    // user is idle; we only need to verify the helper binary is functional.
    const permissions = await getComputerUsePermissions({ probeInputMonitoring: false });
    if (!permissions.helperReady) {
      throw new Error(permissions.message ?? 'Local macOS helper is unavailable.');
    }

    // If any of our own windows are full-screened, exit full-screen first.
    // macOS creates a dedicated Space for full-screen apps, and since we
    // exclude our own PID from screenshots, the capture would be blank.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.isFullScreen()) {
        win.setFullScreen(false);
        // Wait for the full-screen exit animation to complete
        await new Promise<void>((resolve) => {
          const onLeave = () => {
            resolve();
          };
          win.once('leave-full-screen', onLeave);
          // Safety timeout in case the event doesn't fire
          setTimeout(() => {
            win.removeListener('leave-full-screen', onLeave);
            resolve();
          }, 2000);
        });
      }
    }
  }

  async dispose(_sessionId: string): Promise<void> {
    return Promise.resolve();
  }

  async captureFrame(session: ComputerSession): Promise<ComputerFrame> {
    // If our app got full-screened mid-session (e.g. the AI did it),
    // exit full-screen so screenshots aren't blank.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.isFullScreen()) {
        win.setFullScreen(false);
        await new Promise<void>((resolve) => {
          const onLeave = () => {
            resolve();
          };
          win.once('leave-full-screen', onLeave);
          setTimeout(() => {
            win.removeListener('leave-full-screen', onLeave);
            resolve();
          }, 2000);
        });
      }
    }

    const config = this.getConfig();
    const excludeApps = config.computerUse.localMacos.captureExcludedApps ?? ['Electron'];
    const jpegQuality = config.computerUse.capture.jpegQuality ?? 0.8;
    const configuredMax = config.computerUse.capture.maxDimension ?? DEFAULT_MAX_FRAME_DIMENSION;
    const maxDimension =
      session.providerAdapter === 'anthropic-client-tool'
        ? Math.min(configuredMax, ANTHROPIC_VISION_MAX_EDGE)
        : configuredMax;
    const modelFrame = config.computerUse.capture.modelFrame;
    const allowedDisplays = config.computerUse.localMacos.allowedDisplays;

    const excludeArg = Buffer.from(JSON.stringify(excludeApps)).toString('base64');
    const qualityArg = String(jpegQuality);
    const selfPid = String(process.pid);

    // Resolve the display layout up front so we know exactly which physical
    // displays to capture (by CGDirectDisplayID), independent of sort position.
    const displayLayout = await getLocalMacDisplayLayout(
      allowedDisplays && allowedDisplays.length > 0 ? allowedDisplays : undefined,
    );
    if (!displayLayout || displayLayout.displays.length === 0) {
      throw new Error('No displays available for capture');
    }
    const primaryIdx = primaryDisplayIndex(displayLayout);

    const displayFrames: NonNullable<ComputerFrame['displayFrames']> = [];
    let primaryFrame: {
      dataUrl: string;
      width: number;
      height: number;
      nativeWidth: number;
      nativeHeight: number;
    } | null = null;
    let helperDisplays: NonNullable<Parameters<typeof buildDisplayLayout>[0]> | undefined;

    for (const display of displayLayout.displays) {
      try {
        const result = await runLocalMacMouseCommand(
          helperArgs(LOCAL_MACOS_HELPER_COMMANDS.screenshot, [excludeArg, qualityArg, display.displayId, selfPid]),
        );
        if (!result.imageBase64 || !result.width || !result.height) {
          if (display.displayIndex === primaryIdx) throw new Error(result.error ?? 'Screenshot capture failed');
          continue;
        }
        helperDisplays ??= result.displays;
        const raw = Buffer.from(result.imageBase64, 'base64');
        const resized = resizeFrameForModel(
          raw,
          { width: result.width, height: result.height },
          modelFrame,
          maxDimension,
        );
        const dataUrl = `data:image/jpeg;base64,${resized.data.toString('base64')}`;
        displayFrames.push({
          displayIndex: display.displayIndex,
          displayName: display.name,
          dataUrl,
          width: resized.width,
          height: resized.height,
          nativeWidth: resized.nativeWidth,
          nativeHeight: resized.nativeHeight,
        });
        if (display.displayIndex === primaryIdx) {
          primaryFrame = {
            dataUrl,
            width: resized.width,
            height: resized.height,
            nativeWidth: resized.nativeWidth,
            nativeHeight: resized.nativeHeight,
          };
        }
      } catch (error) {
        if (display.displayIndex === primaryIdx) throw error;
      }
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

    // Prefer the layout reported alongside the screenshot (same SCShareableContent
    // snapshot the image came from); fall back to the pre-fetched layout.
    const finalLayout =
      buildDisplayLayout(helperDisplays, allowedDisplays && allowedDisplays.length > 0 ? allowedDisplays : undefined) ??
      displayLayout;

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

  /**
   * Resolve the display-specific coordinate space for an action. Throws when
   * the requested display is not in the captured layout so the orchestrator
   * surfaces the error to the model instead of clicking the wrong monitor.
   */
  private resolveDisplayForAction(
    session: ComputerSession,
    action: ComputerActionProposal,
  ): {
    display: ComputerDisplayInfo;
    frameWidth: number;
    frameHeight: number;
  } {
    const layout = session.displayLayout ?? session.latestFrame?.displayLayout;
    if (!layout || layout.displays.length === 0) {
      throw new Error('No display layout captured for this session yet.');
    }

    const displayIndex = action.displayIndex ?? primaryDisplayIndex(layout);
    const display = layout.displays.find((d) => d.displayIndex === displayIndex);
    if (!display) {
      const valid = layout.displays.map((d) => d.displayIndex).join(', ');
      throw new Error(`Action targets displayIndex ${displayIndex}, but only [${valid}] are available.`);
    }

    const displayFrame = session.latestFrame?.displayFrames?.find((f) => f.displayIndex === displayIndex);
    if (displayFrame) {
      return { display, frameWidth: displayFrame.width, frameHeight: displayFrame.height };
    }
    // Single-display sessions store the frame at the top level without displayFrames.
    if (layout.displays.length === 1 && session.latestFrame) {
      return { display, frameWidth: session.latestFrame.width, frameHeight: session.latestFrame.height };
    }
    throw new Error(`No captured frame for displayIndex ${displayIndex}; capture may have failed for that monitor.`);
  }

  /**
   * Convert frame-space coordinates (within a specific display's image)
   * to macOS global logical-point coordinates.
   */
  private displayFrameToGlobal(
    point: { x: number; y: number },
    display: ComputerDisplayInfo,
    frameWidth: number,
    frameHeight: number,
  ): { x: number; y: number } {
    const fw = Math.max(frameWidth, 1);
    const fh = Math.max(frameHeight, 1);
    const fx = Math.max(0, Math.min(point.x, fw - 1));
    const fy = Math.max(0, Math.min(point.y, fh - 1));
    return {
      x: Math.round(display.globalX + (fx / fw) * display.logicalWidth),
      y: Math.round(display.globalY + (fy / fh) * display.logicalHeight),
    };
  }

  /**
   * Convert macOS global logical-point coordinates back to frame-space
   * coordinates for a specific display.
   */
  private globalToDisplayFrame(
    point: { x: number; y: number },
    display: ComputerDisplayInfo,
    frameWidth: number,
    frameHeight: number,
  ): { x: number; y: number } {
    const localLogicalX = Math.max(0, Math.min(point.x - display.globalX, display.logicalWidth - 1));
    const localLogicalY = Math.max(0, Math.min(point.y - display.globalY, display.logicalHeight - 1));

    return {
      x: Math.round((localLogicalX / Math.max(display.logicalWidth, 1)) * frameWidth),
      y: Math.round((localLogicalY / Math.max(display.logicalHeight, 1)) * frameHeight),
    };
  }

  async movePointer(
    session: ComputerSession,
    action: ComputerActionProposal,
    _context?: ComputerHarnessActionContext,
  ): Promise<ComputerHarnessActionResult> {
    const requested = { x: action.x ?? 0, y: action.y ?? 0 };
    const movementPath = resolveMovementPath(action);
    const ctx = this.resolveDisplayForAction(session, action);
    const target = this.displayFrameToGlobal(requested, ctx.display, ctx.frameWidth, ctx.frameHeight);
    const durationMs = Math.max(60, Math.min(action.waitMs ?? 180, 1200));
    await runLocalMacMouseCommand(
      helperArgs(LOCAL_MACOS_HELPER_COMMANDS.move, [target.x, target.y, durationMs, 18, movementPath]),
    );
    const actual = this.globalToDisplayFrame(
      await resolveActualCursor(target),
      ctx.display,
      ctx.frameWidth,
      ctx.frameHeight,
    );
    return buildResult(summarizePointerAction('Moved pointer to', requested, actual, movementPath), actual);
  }

  async click(session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const requested = { x: action.x ?? 0, y: action.y ?? 0 };
    const movementPath = resolveMovementPath(action);
    const ctx = this.resolveDisplayForAction(session, action);
    const target = this.displayFrameToGlobal(requested, ctx.display, ctx.frameWidth, ctx.frameHeight);
    await runLocalMacMouseCommand(
      helperArgs(LOCAL_MACOS_HELPER_COMMANDS.click, [target.x, target.y, 120, movementPath]),
    );
    const actual = this.globalToDisplayFrame(
      await resolveActualCursor(target),
      ctx.display,
      ctx.frameWidth,
      ctx.frameHeight,
    );
    return buildResult(summarizePointerAction('Clicked at', requested, actual, movementPath), actual);
  }

  async doubleClick(session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const requested = { x: action.x ?? 0, y: action.y ?? 0 };
    const movementPath = resolveMovementPath(action);
    const ctx = this.resolveDisplayForAction(session, action);
    const target = this.displayFrameToGlobal(requested, ctx.display, ctx.frameWidth, ctx.frameHeight);
    await runLocalMacMouseCommand(
      helperArgs(LOCAL_MACOS_HELPER_COMMANDS.doubleClick, [target.x, target.y, 130, movementPath]),
    );
    const actual = this.globalToDisplayFrame(
      await resolveActualCursor(target),
      ctx.display,
      ctx.frameWidth,
      ctx.frameHeight,
    );
    return buildResult(summarizePointerAction('Double-clicked at', requested, actual, movementPath), actual);
  }

  async drag(
    session: ComputerSession,
    action: ComputerActionProposal,
    _context?: ComputerHarnessActionContext,
  ): Promise<ComputerHarnessActionResult> {
    const requestedStart = { x: action.x ?? action.endX ?? 0, y: action.y ?? action.endY ?? 0 };
    const requestedEnd = { x: action.endX ?? requestedStart.x, y: action.endY ?? requestedStart.y };
    const movementPath = resolveMovementPath(action);
    const ctx = this.resolveDisplayForAction(session, action);
    const start = this.displayFrameToGlobal(requestedStart, ctx.display, ctx.frameWidth, ctx.frameHeight);
    const end = this.displayFrameToGlobal(requestedEnd, ctx.display, ctx.frameWidth, ctx.frameHeight);
    const durationMs = Math.max(120, Math.min(action.waitMs ?? 320, 2400));
    await runLocalMacMouseCommand(
      helperArgs(LOCAL_MACOS_HELPER_COMMANDS.drag, [start.x, start.y, end.x, end.y, durationMs, 28, movementPath]),
    );
    const actual = this.globalToDisplayFrame(
      await resolveActualCursor(end),
      ctx.display,
      ctx.frameWidth,
      ctx.frameHeight,
    );
    const pathSuffix = movementPath === 'direct' ? '' : ' via ' + movementPath;
    const rsx = Math.round(requestedStart.x);
    const rsy = Math.round(requestedStart.y);
    const rex = Math.round(requestedEnd.x);
    const rey = Math.round(requestedEnd.y);
    const summary =
      actual.x === rex && actual.y === rey
        ? `Dragged from ${rsx}, ${rsy} to ${rex}, ${rey}${pathSuffix}.`
        : `Dragged from ${rsx}, ${rsy} to ${rex}, ${rey}${pathSuffix} (actual ${actual.x}, ${actual.y}).`;
    return buildResult(summary, actual);
  }

  async scroll(session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const deltaX = Math.round(action.deltaX ?? 0);
    const deltaY = Math.round(action.deltaY ?? 0);
    let cursor: { x: number; y: number } | undefined;
    if (action.x != null && action.y != null) {
      const ctx = this.resolveDisplayForAction(session, action);
      const target = this.displayFrameToGlobal(
        { x: action.x, y: action.y },
        ctx.display,
        ctx.frameWidth,
        ctx.frameHeight,
      );
      await runLocalMacMouseCommand(
        helperArgs(LOCAL_MACOS_HELPER_COMMANDS.move, [target.x, target.y, 40, 1, 'teleport']),
      );
      cursor = this.globalToDisplayFrame(
        await resolveActualCursor(target),
        ctx.display,
        ctx.frameWidth,
        ctx.frameHeight,
      );
    }
    await runLocalMacMouseCommand(helperArgs(LOCAL_MACOS_HELPER_COMMANDS.scroll, [deltaX, deltaY]));
    return buildResult(`Scrolled by ${deltaX}, ${deltaY}.`, cursor);
  }

  async typeText(_session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const text = action.text ?? '';
    const encoded = Buffer.from(text, 'utf-8').toString('base64');
    const delayMs = Math.max(8, Math.min(action.waitMs ?? 45, 250));
    await runLocalMacMouseCommand(helperArgs(LOCAL_MACOS_HELPER_COMMANDS.typeText, [encoded, delayMs]));
    return buildResult(`Typed ${JSON.stringify(text)}.`);
  }

  async pressKeys(_session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const keys = action.keys ?? [];
    const encoded = Buffer.from(JSON.stringify(keys), 'utf-8').toString('base64');
    const delayMs = Math.max(12, Math.min(action.waitMs ?? 60, 400));
    await runLocalMacMouseCommand(helperArgs(LOCAL_MACOS_HELPER_COMMANDS.pressKeys, [encoded, delayMs]));
    return buildResult(`Pressed keys: ${keys.join(' + ') || 'Enter'}.`);
  }

  async openApp(_session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const appName = resolveAppName(action.appName, 'Open app');
    await execFileAsync('open', ['-a', appName], { timeout: 15000 });
    return buildResult(`Opened ${appName}.`);
  }

  async focusWindow(_session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const appName = resolveAppName(action.appName, 'Focus window');
    // Pass model-supplied appName as argv DATA, never as an option. osascript
    // keeps parsing -e/-l/etc. after the first -e, so an appName like
    // "-e return 99" would be read as another script fragment; the `--`
    // separator forces everything after it to be positional (run-handler argv).
    const FOCUS_SCRIPT = 'on run argv\n  tell application (item 1 of argv) to activate\nend run';
    await execFileAsync('osascript', ['-e', FOCUS_SCRIPT, '--', appName], { timeout: 15000 });
    return buildResult(`Focused ${appName}.`);
  }

  async navigate(_session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const url = action.url?.trim();
    if (!url) throw new Error('Navigation requires a URL.');
    // Model-supplied URL — restrict to http/https/about so a `navigate` action
    // can't hand `file:`, `x-apple.systempreferences:`, `mailto:`, custom app
    // schemes, etc. to `open` and launch arbitrary OS protocol handlers.
    // (App launching stays behind the separate, approval-gated openApp action.)
    const safe = safeNavigateUrl(url);
    if (!safe) throw new Error(`Refusing to navigate to disallowed URL scheme: ${url}`);
    await execFileAsync('open', [safe], { timeout: 15000 });
    return buildResult(`Opened ${safe}.`);
  }

  async waitForIdle(_session: ComputerSession, action: ComputerActionProposal): Promise<ComputerHarnessActionResult> {
    const waitMs = Math.max(250, Math.min(action.waitMs ?? 1000, 10000));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return buildResult(`Waited ${waitMs}ms.`);
  }

  async getEnvironmentMetadata(_session: ComputerSession): Promise<ComputerEnvironmentMetadata> {
    const permissions = await getComputerUsePermissions({ probeInputMonitoring: false });
    const appName = await runAppleScript(
      'tell application "System Events" to get name of first application process whose frontmost is true',
    );
    let windowTitle = '';
    try {
      windowTitle = await runAppleScript(
        'tell application "System Events" to tell (first application process whose frontmost is true) to get value of attribute "AXTitle" of front window',
      );
    } catch {
      windowTitle = '';
    }
    return {
      appName,
      windowTitle,
      permissionState: {
        accessibility: permissions.accessibilityTrusted,
        screenRecording: permissions.screenRecordingGranted,
        automation: permissions.automationGranted,
      },
    };
  }
}

import type { BrowserWindow, NativeImage, ProcessMetric, WebContents } from 'electron';
import { appendBoundedLog } from './main-diagnostics.js';
import { traceDiagnostic } from './debug-trace.js';

const HEALTH_LOG_MAX_BYTES = 5 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 2_500;
const SURFACE_RETRY_DELAY_MS = 500;
const ACTIVE_WORK_RETRY_MS = 15_000;
const AUTO_RELOAD_COOLDOWN_MS = 60_000;
const AUTO_RELOAD_WINDOW_MS = 10 * 60_000;
const MAX_AUTO_RELOADS_PER_WINDOW = 2;

export type HealthWindow = Pick<
  BrowserWindow,
  'isDestroyed' | 'isVisible' | 'isMinimized' | 'getBounds' | 'on' | 'off'
> & {
  webContents: Pick<
    WebContents,
    | 'id'
    | 'isDestroyed'
    | 'getOSProcessId'
    | 'getURL'
    | 'invalidate'
    | 'executeJavaScript'
    | 'capturePage'
    | 'reload'
    | 'on'
    | 'off'
  >;
};

export interface WindowHealthProbeResult {
  healthy: boolean;
  rendererResponsive: boolean;
  animationFrameCompleted: boolean;
  documentReadyState?: string;
  documentVisibility?: string;
  rootChildCount?: number;
  captureEmpty?: boolean;
  captureSize?: { width: number; height: number };
  captureHasVisiblePixels?: boolean;
  error?: string;
}

export interface WindowHealthMonitorOptions {
  logPath: string;
  getPrimaryWindow: () => HealthWindow | null;
  getProcessMetrics: () => ProcessMetric[];
  hasActiveWork: () => boolean;
  /** macOS hook used to rebuild the native vibrancy-backed surface. */
  reviveNativeSurface?: () => void | Promise<void>;
  now?: () => number;
  probe?: (window: HealthWindow) => Promise<WindowHealthProbeResult>;
  timings?: {
    surfaceRetryDelayMs?: number;
    activeWorkRetryMs?: number;
  };
}

interface RendererProbePayload {
  readyState?: unknown;
  visibilityState?: unknown;
  rootChildCount?: unknown;
  animationFrameCompleted?: unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return raw.slice(0, 300);
  }
}

function webContentsUrl(contents: Pick<WebContents, 'getURL'>): string {
  try {
    return safeUrl(contents.getURL());
  } catch (error) {
    return `<unavailable:${errorMessage(error)}>`;
  }
}

function webContentsPid(contents: Pick<WebContents, 'getOSProcessId'>): number | null {
  try {
    return contents.getOSProcessId();
  } catch {
    return null;
  }
}

function metricSnapshot(metrics: ProcessMetric[]): Array<Record<string, unknown>> {
  return metrics.map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    name: metric.name,
    serviceName: metric.serviceName,
    cpuPercent: Number(metric.cpu.percentCPUUsage.toFixed(1)),
    workingSetKB: metric.memory.workingSetSize,
    privateKB: metric.memory.privateBytes,
    creationTime: metric.creationTime,
  }));
}

function hasVisiblePixels(image: NativeImage): boolean {
  const bitmap = image.toBitmap();
  if (bitmap.length < 4) return false;

  // NativeImage bitmaps are BGRA. Sampling caps the work for large/high-DPI
  // windows while still reliably distinguishing a fully transparent surface.
  const pixelCount = Math.floor(bitmap.length / 4);
  const stride = Math.max(1, Math.floor(pixelCount / 4096));
  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    if ((bitmap[pixel * 4 + 3] ?? 0) > 8) return true;
  }
  return false;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Probe both renderer progress and the composited surface. A renderer can still
 * answer JavaScript while Chromium has stopped presenting frames, which is the
 * failure mode that leaves a transparent/vibrant macOS window as a grey blur.
 */
export async function probeWindowHealth(window: HealthWindow): Promise<WindowHealthProbeResult> {
  const contents = window.webContents;
  if (window.isDestroyed() || contents.isDestroyed()) {
    return {
      healthy: false,
      rendererResponsive: false,
      animationFrameCompleted: false,
      error: 'window-or-webcontents-destroyed',
    };
  }

  try {
    contents.invalidate();
    const renderer = (await withTimeout(
      contents.executeJavaScript(
        `new Promise((resolve) => {
          let settled = false;
          const finish = (animationFrameCompleted) => {
            if (settled) return;
            settled = true;
            resolve({
              readyState: document.readyState,
              visibilityState: document.visibilityState,
              rootChildCount: document.getElementById('root')?.childElementCount ?? 0,
              animationFrameCompleted,
            });
          };
          requestAnimationFrame(() => requestAnimationFrame(() => finish(true)));
          setTimeout(() => finish(false), 1200);
        })`,
        true,
      ) as Promise<RendererProbePayload>,
      PROBE_TIMEOUT_MS,
      'renderer probe',
    )) as RendererProbePayload;

    const image = await withTimeout(contents.capturePage(), PROBE_TIMEOUT_MS, 'surface capture');
    const captureEmpty = image.isEmpty();
    const captureSize = image.getSize();
    const captureHasVisiblePixels = !captureEmpty && hasVisiblePixels(image);
    const documentReadyState = typeof renderer.readyState === 'string' ? renderer.readyState : undefined;
    const documentVisibility = typeof renderer.visibilityState === 'string' ? renderer.visibilityState : undefined;
    const rootChildCount = typeof renderer.rootChildCount === 'number' ? renderer.rootChildCount : undefined;
    const animationFrameCompleted = renderer.animationFrameCompleted === true;
    const rendererResponsive = true;

    return {
      healthy:
        documentReadyState === 'complete' &&
        (rootChildCount ?? 0) > 0 &&
        animationFrameCompleted &&
        !captureEmpty &&
        captureSize.width > 0 &&
        captureSize.height > 0 &&
        captureHasVisiblePixels,
      rendererResponsive,
      animationFrameCompleted,
      documentReadyState,
      documentVisibility,
      rootChildCount,
      captureEmpty,
      captureSize,
      captureHasVisiblePixels,
    };
  } catch (error) {
    return {
      healthy: false,
      rendererResponsive: false,
      animationFrameCompleted: false,
      error: errorMessage(error),
    };
  }
}

/**
 * Owns diagnostics and conservative revival for the primary renderer. Event
 * wiring lives in main.ts so this policy remains unit-testable without booting
 * Electron.
 */
export class WindowHealthMonitor {
  private readonly now: () => number;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryRunning = false;
  private pendingTrigger: string | null = null;
  private loadedWebContentsIds = new Set<number>();
  private reloadHistory: number[] = [];
  private attachedWindow: HealthWindow | null = null;
  private windowListeners: Array<{ event: string; listener: (...args: never[]) => void }> = [];
  private contentsListeners: Array<{ event: string; listener: (...args: never[]) => void }> = [];
  private blurredAt: number | null = null;
  private readonly probe: (window: HealthWindow) => Promise<WindowHealthProbeResult>;
  private readonly surfaceRetryDelayMs: number;
  private readonly activeWorkRetryMs: number;

  constructor(private readonly options: WindowHealthMonitorOptions) {
    this.now = options.now ?? Date.now;
    this.probe = options.probe ?? probeWindowHealth;
    this.surfaceRetryDelayMs = options.timings?.surfaceRetryDelayMs ?? SURFACE_RETRY_DELAY_MS;
    this.activeWorkRetryMs = options.timings?.activeWorkRetryMs ?? ACTIVE_WORK_RETRY_MS;
  }

  log(event: string, details: Record<string, unknown> = {}, includeMetrics = false): void {
    let processes: Array<Record<string, unknown>> | undefined;
    if (includeMetrics) {
      try {
        processes = metricSnapshot(this.options.getProcessMetrics());
      } catch (error) {
        details.metricsError = errorMessage(error);
      }
    }
    const payload = processes ? { ...details, processes } : details;
    appendBoundedLog(
      this.options.logPath,
      `[${new Date(this.now()).toISOString()}] [WINDOW_HEALTH] event=${event} data=${JSON.stringify(payload)}\n`,
      HEALTH_LOG_MAX_BYTES,
    );
    traceDiagnostic({ scope: 'window', event, fields: payload });
  }

  logSession(details: Record<string, unknown>): void {
    this.log('session-start', details, true);
  }

  attachWindow(window: HealthWindow): void {
    this.detachWindow();
    this.attachedWindow = window;
    const contents = window.webContents;

    const onWindow = (event: string, listener: (...args: never[]) => void): void => {
      window.on(event as never, listener);
      this.windowListeners.push({ event, listener });
    };
    const onContents = (event: string, listener: (...args: never[]) => void): void => {
      contents.on(event as never, listener);
      this.contentsListeners.push({ event, listener });
    };

    onContents('did-start-loading', () => {
      this.loadedWebContentsIds.delete(contents.id);
      this.log('main-renderer-load-started', this.windowDetails(window));
    });
    onContents('did-finish-load', () => {
      this.loadedWebContentsIds.add(contents.id);
      this.log('main-renderer-load-finished', this.windowDetails(window), true);
    });
    onContents('unresponsive', () => {
      this.log('main-renderer-unresponsive', this.windowDetails(window), true);
      this.requestRecovery('renderer-unresponsive', 5_000);
    });
    onContents('responsive', () => {
      this.log('main-renderer-responsive', this.windowDetails(window), true);
    });
    onWindow('blur', () => {
      this.blurredAt = this.now();
    });
    onWindow('focus', () => {
      const awayMs = this.blurredAt === null ? null : this.now() - this.blurredAt;
      this.blurredAt = null;
      if (awayMs !== null && awayMs >= 60_000) {
        this.log('window-focus-after-idle', { ...this.windowDetails(window), awayMs });
        this.requestRecovery('focus-after-idle', 250);
      }
    });
    onWindow('restore', () => this.requestRecovery('window-restored', 250));
    onWindow('show', () => this.requestRecovery('window-shown', 250));

    this.log('primary-window-attached', this.windowDetails(window), true);
  }

  detachWindow(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    const window = this.attachedWindow;
    if (window) {
      for (const { event, listener } of this.windowListeners) window.off(event as never, listener);
      for (const { event, listener } of this.contentsListeners) window.webContents.off(event as never, listener);
    }
    this.windowListeners = [];
    this.contentsListeners = [];
    this.attachedWindow = null;
    this.pendingTrigger = null;
    this.recoveryRunning = false;
  }

  recordLifecycleEvent(event: string, details: Record<string, unknown> = {}): void {
    this.log(event, details, true);
  }

  recordChildProcessGone(details: Record<string, unknown>): void {
    this.log('child-process-gone', details, true);
    if (details.type === 'GPU') this.requestRecovery('gpu-process-gone', 1_500);
  }

  recordRendererGone(
    webContents: Pick<WebContents, 'id' | 'getURL' | 'getOSProcessId'>,
    details: Record<string, unknown>,
  ): void {
    const primary = this.options.getPrimaryWindow();
    const isPrimary = !!primary && primary.webContents.id === webContents.id;
    this.log(
      'render-process-gone',
      {
        ...details,
        webContentsId: webContents.id,
        rendererPid: webContentsPid(webContents),
        url: webContentsUrl(webContents),
        isPrimary,
      },
      true,
    );
    if (isPrimary) this.reloadAfterRendererCrash(String(details.reason ?? 'unknown'));
  }

  requestRecovery(trigger: string, delayMs = 1_000): void {
    this.pendingTrigger = trigger;
    if (this.recoveryTimer || this.recoveryRunning) {
      this.log('recovery-coalesced', { trigger });
      return;
    }
    this.log('recovery-scheduled', { trigger, delayMs });
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.runRecovery(trigger);
    }, delayMs);
  }

  private async runRecovery(trigger: string): Promise<void> {
    if (this.recoveryRunning) return;
    this.recoveryRunning = true;
    this.pendingTrigger = null;
    try {
      const window = this.options.getPrimaryWindow();
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
        this.log('recovery-skipped', { trigger, reason: 'no-primary-window' });
        return;
      }
      if (!window.isVisible() || window.isMinimized()) {
        this.log('recovery-skipped', { trigger, reason: 'window-not-presented', ...this.windowDetails(window) });
        return;
      }
      if (!this.loadedWebContentsIds.has(window.webContents.id)) {
        this.log('recovery-skipped', { trigger, reason: 'renderer-not-loaded', ...this.windowDetails(window) });
        return;
      }

      this.log('recovery-probe-started', { trigger, ...this.windowDetails(window) }, true);
      const firstProbe = await this.probe(window);
      this.log('recovery-probe-result', { trigger, attempt: 1, ...firstProbe }, !firstProbe.healthy);
      if (firstProbe.healthy) return;

      if (this.options.reviveNativeSurface) {
        try {
          await this.options.reviveNativeSurface();
          this.log('native-surface-rebuilt', { trigger });
        } catch (error) {
          this.log('native-surface-rebuild-failed', { trigger, error: errorMessage(error) });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.surfaceRetryDelayMs));

      const secondProbe = await this.probe(window);
      this.log('recovery-probe-result', { trigger, attempt: 2, ...secondProbe }, !secondProbe.healthy);
      if (secondProbe.healthy) return;
      if (window.isDestroyed() || window.webContents.isDestroyed()) {
        this.log('recovery-skipped', { trigger, reason: 'window-destroyed-during-probe' });
        return;
      }

      if (this.options.hasActiveWork()) {
        this.log('auto-reload-deferred', { trigger, reason: 'active-agent-stream' }, true);
        this.recoveryRunning = false;
        this.requestRecovery(`${trigger}:deferred`, this.activeWorkRetryMs);
        return;
      }
      if (!this.canAutoReload()) {
        this.log('auto-reload-suppressed', { trigger, reason: 'reload-loop-guard' }, true);
        return;
      }

      this.reloadHistory.push(this.now());
      this.log('auto-reload', { trigger, reason: 'two-failed-health-probes' }, true);
      window.webContents.reload();
    } finally {
      this.recoveryRunning = false;
      const pending = this.pendingTrigger;
      if (pending && !this.recoveryTimer) this.requestRecovery(pending, 1_000);
    }
  }

  private reloadAfterRendererCrash(reason: string): void {
    const window = this.options.getPrimaryWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    if (!this.canAutoReload()) {
      this.log('auto-reload-suppressed', { trigger: 'primary-renderer-gone', reason: 'reload-loop-guard' }, true);
      return;
    }
    this.reloadHistory.push(this.now());
    this.log('auto-reload', { trigger: 'primary-renderer-gone', reason }, true);
    window.webContents.reload();
  }

  private canAutoReload(): boolean {
    const now = this.now();
    this.reloadHistory = this.reloadHistory.filter((ts) => now - ts < AUTO_RELOAD_WINDOW_MS);
    const latest = this.reloadHistory.at(-1);
    if (latest !== undefined && now - latest < AUTO_RELOAD_COOLDOWN_MS) return false;
    return this.reloadHistory.length < MAX_AUTO_RELOADS_PER_WINDOW;
  }

  private windowDetails(window: HealthWindow): Record<string, unknown> {
    const contents = window.webContents;
    return {
      webContentsId: contents.id,
      rendererPid: contents.isDestroyed() ? null : webContentsPid(contents),
      url: contents.isDestroyed() ? '' : webContentsUrl(contents),
      visible: window.isVisible(),
      minimized: window.isMinimized(),
      bounds: window.getBounds(),
    };
  }
}

import type { BrowserWindow, NativeImage, ProcessMetric, WebContents } from 'electron';
import { appendBoundedLog } from './main-diagnostics.js';
import { traceDiagnostic } from './debug-trace.js';

const HEALTH_LOG_MAX_BYTES = 10 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 2_500;
const SURFACE_RETRY_DELAY_MS = 500;
const ACTIVE_WORK_RETRY_MS = 15_000;
const AUTO_RELOAD_COOLDOWN_MS = 60_000;
const AUTO_RELOAD_WINDOW_MS = 10 * 60_000;
const MAX_AUTO_RELOADS_PER_WINDOW = 2;
// Renderer JS-heap thresholds for the heap-pressure warning. Either an absolute
// used-MB ceiling OR a used/limit ratio trips it — a V8/cppgc OOM abort (SIGTRAP
// during GC) is preceded by the heap climbing toward jsHeapSizeLimit, so leaving
// a flagged trail lets the next crash be attributed to renderer memory growth.
const HEAP_PRESSURE_USED_MB = 2_048;
const HEAP_PRESSURE_USED_PCT = 90;
// Cadence for the standalone renderer-heap heartbeat. The full health probe only
// runs on window events (focus, display change, show) — so a renderer that sits
// idle behind a locked screen and then aborts (SIGTRAP in V8/cppgc GC) leaves a
// multi-hour telemetry blind spot right before the crash. The heartbeat samples
// just the JS heap on this interval regardless of window activity, so the heap
// trajectory approaching the next abort is always on disk. 60s balances signal
// density against the cost of a trivial executeJavaScript round-trip.
const HEAP_HEARTBEAT_INTERVAL_MS = 60_000;
// Once a snapshot fires at thresholdPct, the heap must fall this many points
// below the threshold before another snapshot can fire — prevents re-capturing
// every tick while the heap sits pinned at/near 100%.
const SNAPSHOT_REARM_HYSTERESIS_PCT = 10;
/** Cooldown before re-arming a heap snapshot after a FAILED capture, so a persistently
 *  high heap gets retried (not latched off) without spamming attempts every heartbeat. */
const SNAPSHOT_RETRY_COOLDOWN_MS = 60_000;

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
  /** Renderer JS-heap usage sampled from performance.memory, in MB. */
  jsHeapUsedMB?: number;
  jsHeapTotalMB?: number;
  jsHeapLimitMB?: number;
  /** used / limit as a percentage (0–100), when both are known. */
  jsHeapUsedPct?: number;
  error?: string;
}

export interface WindowHealthMonitorOptions {
  logPath: string;
  getPrimaryWindow: () => HealthWindow | null;
  getProcessMetrics: () => ProcessMetric[];
  hasActiveWork: () => boolean;
  /** macOS hook used to rebuild the native vibrancy-backed surface. */
  reviveNativeSurface?: () => void | Promise<void>;
  /**
   * Live predicate gating the renderer-heap heartbeat. Checked per tick so the
   * "In-depth memory & crash logging" setting starts/stops sampling without a
   * relaunch. When omitted, the heartbeat is always on (used by tests).
   */
  isHeapHeartbeatEnabled?: () => boolean;
  /**
   * Live max-bytes for window-health.log, read per write so a GUI change to the
   * cap takes effect immediately. When omitted, the built-in default is used.
   */
  getMaxLogBytes?: () => number;
  /**
   * Live heap-snapshot policy for the heartbeat. When `enabled`, the heartbeat
   * fires `onHeapSnapshotTrigger` once the sampled heap reaches `thresholdPct`
   * of the limit, then latches until the heap drops back below the threshold
   * (minus hysteresis) — so a heap wedged at 100% captures ONE snapshot, not one
   * per tick. Read per tick so the GUI toggle applies without a relaunch.
   */
  getHeapSnapshotPolicy?: () => { enabled: boolean; thresholdPct: number } | null;
  /**
   * Invoked (fire-and-forget) when the heartbeat decides a snapshot is due. The
   * monitor passes the attached window; main.ts performs the actual capture +
   * retention. Errors are swallowed by the monitor.
   */
  onHeapSnapshotTrigger?: (window: HealthWindow, sample: RendererHeapSample) => void | Promise<void>;
  now?: () => number;
  probe?: (window: HealthWindow) => Promise<WindowHealthProbeResult>;
  /** Heap-only sampler for the heartbeat (injectable for tests). */
  heapSampler?: (window: HealthWindow) => Promise<RendererHeapSample>;
  timings?: {
    surfaceRetryDelayMs?: number;
    activeWorkRetryMs?: number;
    /** Renderer-heap heartbeat cadence. 0 disables the heartbeat. */
    heapHeartbeatIntervalMs?: number;
  };
}

interface RendererProbePayload {
  readyState?: unknown;
  visibilityState?: unknown;
  rootChildCount?: unknown;
  animationFrameCompleted?: unknown;
  // performance.memory is Chromium-only and its precision is reduced, but it is
  // present in Electron renderers and is the cheapest signal for the renderer
  // JS-heap growth that precedes a V8/cppgc OOM abort (SIGTRAP during GC).
  jsHeapUsed?: unknown;
  jsHeapTotal?: unknown;
  jsHeapLimit?: unknown;
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
            const mem = (performance && performance.memory) || {};
            resolve({
              readyState: document.readyState,
              visibilityState: document.visibilityState,
              rootChildCount: document.getElementById('root')?.childElementCount ?? 0,
              animationFrameCompleted,
              jsHeapUsed: mem.usedJSHeapSize,
              jsHeapTotal: mem.totalJSHeapSize,
              jsHeapLimit: mem.jsHeapSizeLimit,
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

    // performance.memory values are bytes (or absent); convert to MB and derive
    // the used/limit ratio. Absent → fields stay undefined (non-Chromium/hardened).
    const bytesToMB = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v / (1024 * 1024)) : undefined;
    const jsHeapUsedMB = bytesToMB(renderer.jsHeapUsed);
    const jsHeapTotalMB = bytesToMB(renderer.jsHeapTotal);
    const jsHeapLimitMB = bytesToMB(renderer.jsHeapLimit);
    const jsHeapUsedPct =
      jsHeapUsedMB !== undefined && jsHeapLimitMB !== undefined && jsHeapLimitMB > 0
        ? Math.round((jsHeapUsedMB / jsHeapLimitMB) * 100)
        : undefined;

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
      jsHeapUsedMB,
      jsHeapTotalMB,
      jsHeapLimitMB,
      jsHeapUsedPct,
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

export interface RendererHeapSample {
  jsHeapUsedMB?: number;
  jsHeapTotalMB?: number;
  jsHeapLimitMB?: number;
  jsHeapUsedPct?: number;
  error?: string;
}

/**
 * Sample ONLY the renderer JS heap — no rAF wait, no capturePage. This is the
 * heartbeat's probe: it must be cheap enough to run every minute on an idle,
 * possibly-backgrounded renderer without perturbing it. The heavier
 * {@link probeWindowHealth} (surface capture + frame liveness) is reserved for
 * window-event-triggered recovery. Returns `{}`-ish with an `error` when the
 * heap stats are unavailable (hardened/non-Chromium) or the renderer is gone.
 */
export async function sampleRendererHeap(window: HealthWindow): Promise<RendererHeapSample> {
  const contents = window.webContents;
  if (window.isDestroyed() || contents.isDestroyed()) {
    return { error: 'window-or-webcontents-destroyed' };
  }
  try {
    const mem = (await withTimeout(
      contents.executeJavaScript(
        `(() => { const m = (performance && performance.memory) || {};
          return { u: m.usedJSHeapSize, t: m.totalJSHeapSize, l: m.jsHeapSizeLimit }; })()`,
        true,
      ) as Promise<{ u?: unknown; t?: unknown; l?: unknown }>,
      PROBE_TIMEOUT_MS,
      'renderer heap sample',
    )) as { u?: unknown; t?: unknown; l?: unknown };
    const bytesToMB = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v / (1024 * 1024)) : undefined;
    const jsHeapUsedMB = bytesToMB(mem.u);
    const jsHeapTotalMB = bytesToMB(mem.t);
    const jsHeapLimitMB = bytesToMB(mem.l);
    const jsHeapUsedPct =
      jsHeapUsedMB !== undefined && jsHeapLimitMB !== undefined && jsHeapLimitMB > 0
        ? Math.round((jsHeapUsedMB / jsHeapLimitMB) * 100)
        : undefined;
    return { jsHeapUsedMB, jsHeapTotalMB, jsHeapLimitMB, jsHeapUsedPct };
  } catch (error) {
    return { error: errorMessage(error) };
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
  private readonly heapSampler: (window: HealthWindow) => Promise<RendererHeapSample>;
  private readonly surfaceRetryDelayMs: number;
  private readonly activeWorkRetryMs: number;
  private readonly heapHeartbeatIntervalMs: number;
  private readonly isHeapHeartbeatEnabled: () => boolean;
  private heapHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heapHeartbeatRunning = false;
  // Latch so a heap wedged over the threshold captures ONE snapshot, not one per
  // tick. Armed again only after the heap drops `SNAPSHOT_REARM_HYSTERESIS_PCT`
  // below the threshold (so oscillation around the line doesn't re-fire).
  private heapSnapshotArmed = true;
  // When a capture FAILED (transient), the timestamp after which we re-arm so a retry can
  // fire while the heap is still over threshold — otherwise a failed capture would latch
  // off until the heap recovered below the hysteresis line and no snapshot is ever taken.
  private heapSnapshotRetryAfter = 0;

  constructor(private readonly options: WindowHealthMonitorOptions) {
    this.now = options.now ?? Date.now;
    this.probe = options.probe ?? probeWindowHealth;
    this.heapSampler = options.heapSampler ?? sampleRendererHeap;
    this.surfaceRetryDelayMs = options.timings?.surfaceRetryDelayMs ?? SURFACE_RETRY_DELAY_MS;
    this.activeWorkRetryMs = options.timings?.activeWorkRetryMs ?? ACTIVE_WORK_RETRY_MS;
    this.heapHeartbeatIntervalMs = options.timings?.heapHeartbeatIntervalMs ?? HEAP_HEARTBEAT_INTERVAL_MS;
    this.isHeapHeartbeatEnabled = options.isHeapHeartbeatEnabled ?? (() => true);
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
      this.resolveMaxLogBytes(),
    );
    traceDiagnostic({ scope: 'window', event, fields: payload });
  }

  /**
   * Resolve the window-health.log cap. Reads the injected `getMaxLogBytes` per
   * write so a GUI change applies immediately; falls back to the built-in
   * default and clamps out any non-finite/absurd value so a bad config can
   * never disable the bound (which would let the log grow without limit).
   */
  private resolveMaxLogBytes(): number {
    const raw = this.options.getMaxLogBytes?.();
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1024 * 1024) {
      return Math.min(raw, 50 * 1024 * 1024);
    }
    return HEALTH_LOG_MAX_BYTES;
  }

  logSession(details: Record<string, unknown>): void {
    this.log('session-start', details, true);
  }

  /**
   * Emit a flagged `renderer-heap-pressure` event when a probe reports the
   * renderer JS heap over either threshold. The renderer OOM abort (SIGTRAP
   * during V8/cppgc GC) leaves no JS-level exception, so this trail is the only
   * in-app signal that a crash was preceded by heap growth. Includes a process
   * metric snapshot so the working-set of the offending Tab is captured too.
   */
  private checkHeapPressure(
    trigger: string,
    attempt: number,
    probe: Pick<WindowHealthProbeResult, 'jsHeapUsedMB' | 'jsHeapTotalMB' | 'jsHeapLimitMB' | 'jsHeapUsedPct'>,
  ): void {
    const usedMB = probe.jsHeapUsedMB;
    const usedPct = probe.jsHeapUsedPct;
    if (usedMB === undefined && usedPct === undefined) return; // heap stats unavailable
    const overAbsolute = usedMB !== undefined && usedMB >= HEAP_PRESSURE_USED_MB;
    const overRatio = usedPct !== undefined && usedPct >= HEAP_PRESSURE_USED_PCT;
    if (!overAbsolute && !overRatio) return;
    this.log(
      'renderer-heap-pressure',
      {
        trigger,
        attempt,
        jsHeapUsedMB: usedMB,
        jsHeapTotalMB: probe.jsHeapTotalMB,
        jsHeapLimitMB: probe.jsHeapLimitMB,
        jsHeapUsedPct: usedPct,
        thresholdUsedMB: HEAP_PRESSURE_USED_MB,
        thresholdUsedPct: HEAP_PRESSURE_USED_PCT,
        trippedBy: overAbsolute && overRatio ? 'both' : overAbsolute ? 'absolute' : 'ratio',
      },
      true,
    );
  }

  /**
   * Decide whether the current heartbeat sample should trigger a heap snapshot.
   * Latched: fires once when the heap first reaches `thresholdPct`, then won't
   * fire again until the heap drops `SNAPSHOT_REARM_HYSTERESIS_PCT` below the
   * threshold. Config is read live so the GUI toggle applies immediately. The
   * actual capture is delegated to `onHeapSnapshotTrigger` (fire-and-forget).
   */
  private maybeTriggerHeapSnapshot(window: HealthWindow, sample: RendererHeapSample): void {
    const policy = this.options.getHeapSnapshotPolicy?.();
    const trigger = this.options.onHeapSnapshotTrigger;
    const pct = sample.jsHeapUsedPct;
    if (!policy || !policy.enabled || !trigger || pct === undefined) return;

    const rearmBelow = Math.max(0, policy.thresholdPct - SNAPSHOT_REARM_HYSTERESIS_PCT);
    // Re-arm once the heap has recovered well below the line.
    if (!this.heapSnapshotArmed && pct <= rearmBelow) {
      this.heapSnapshotArmed = true;
    }
    // Re-arm after a FAILED capture's cooldown even if the heap is STILL over threshold —
    // otherwise a transient failure would latch us off until the heap recovered (below the
    // hysteresis line), so a persistently-high heap would never get a snapshot.
    if (!this.heapSnapshotArmed && this.heapSnapshotRetryAfter > 0 && Date.now() >= this.heapSnapshotRetryAfter) {
      this.heapSnapshotArmed = true;
      this.heapSnapshotRetryAfter = 0;
    }
    if (!this.heapSnapshotArmed || pct < policy.thresholdPct) return;

    // Latch immediately so overlapping ticks can't double-fire, then delegate.
    this.heapSnapshotArmed = false;
    this.heapSnapshotRetryAfter = 0;
    this.log('renderer-heap-snapshot-triggered', {
      jsHeapUsedMB: sample.jsHeapUsedMB,
      jsHeapLimitMB: sample.jsHeapLimitMB,
      jsHeapUsedPct: pct,
      thresholdPct: policy.thresholdPct,
    });
    // Arm a retry window: if the capture rejects/throws, re-arm after this cooldown so a
    // still-high heap gets another attempt rather than being latched off indefinitely.
    const armRetry = (): void => {
      this.heapSnapshotRetryAfter = Date.now() + SNAPSHOT_RETRY_COOLDOWN_MS;
    };
    try {
      void Promise.resolve(trigger(window, sample)).catch((error) => {
        this.log('renderer-heap-snapshot-failed', { error: errorMessage(error) });
        armRetry();
      });
    } catch (error) {
      this.log('renderer-heap-snapshot-failed', { error: errorMessage(error) });
      armRetry();
    }
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
    this.startHeapHeartbeat();
  }

  /**
   * Begin the periodic renderer-heap heartbeat. Idempotent. Uses `setInterval`
   * whose callback samples only the JS heap (no rAF/capture) so it is safe on an
   * idle/backgrounded renderer. Skips its own tick if one is still in flight
   * (a wedged renderer won't queue overlapping executeJavaScript calls). The
   * timer is `unref`'d so it never keeps the process alive on its own.
   */
  private startHeapHeartbeat(): void {
    if (this.heapHeartbeatIntervalMs <= 0 || this.heapHeartbeatTimer) return;
    this.heapHeartbeatTimer = setInterval(() => {
      void this.runHeapHeartbeat();
    }, this.heapHeartbeatIntervalMs);
    // unref keeps the heartbeat from holding the event loop open at shutdown.
    (this.heapHeartbeatTimer as { unref?: () => void }).unref?.();
  }

  private stopHeapHeartbeat(): void {
    if (this.heapHeartbeatTimer) {
      clearInterval(this.heapHeartbeatTimer);
      this.heapHeartbeatTimer = null;
    }
    this.heapHeartbeatRunning = false;
  }

  private async runHeapHeartbeat(): Promise<void> {
    if (this.heapHeartbeatRunning) return; // previous sample still in flight
    // Live gate: the setting can be toggled without a relaunch, so re-check each
    // tick rather than only at attach. Cheap (a config cache read).
    if (!this.isHeapHeartbeatEnabled()) return;
    const window = this.attachedWindow;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    // Only sample once the renderer has finished loading — sampling mid-load
    // races the executeJavaScript against a document that may swap out.
    if (!this.loadedWebContentsIds.has(window.webContents.id)) return;
    this.heapHeartbeatRunning = true;
    try {
      const sample = await this.heapSampler(window);
      if (sample.error) {
        // Heap stats unavailable or renderer unreachable — record it (an
        // unreachable renderer just before an abort is itself a useful signal),
        // but don't spam a metric snapshot for the common "no performance.memory"
        // case.
        this.log('renderer-heap-heartbeat', { error: sample.error });
        return;
      }
      // Only the used-MB and derived % are logged per tick; a full process
      // metric snapshot every 60s would bloat the log. checkHeapPressure adds
      // the flagged, metric-bearing event when a threshold trips.
      this.log('renderer-heap-heartbeat', {
        jsHeapUsedMB: sample.jsHeapUsedMB,
        jsHeapTotalMB: sample.jsHeapTotalMB,
        jsHeapLimitMB: sample.jsHeapLimitMB,
        jsHeapUsedPct: sample.jsHeapUsedPct,
      });
      this.checkHeapPressure('heartbeat', 0, sample);
      this.maybeTriggerHeapSnapshot(window, sample);
    } catch {
      /* heartbeat is best-effort; never let it throw into the interval */
    } finally {
      this.heapHeartbeatRunning = false;
    }
  }

  detachWindow(): void {
    this.stopHeapHeartbeat();
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
      this.checkHeapPressure(trigger, 1, firstProbe);
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
      this.checkHeapPressure(trigger, 2, secondProbe);
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

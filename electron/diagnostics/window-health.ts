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
// A renderer normally finishes loading in well under 2s. If it stays unloaded
// past this and recovery keeps getting skipped (the display-reconfigure / GPU
// context-loss zombie: `did-finish-load` never re-fires), treat it as wedged and
// force a reload rather than skipping forever. Used only when no policy is
// injected (tests / defensive default).
const STALL_RELOAD_MS = 30_000;
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
  /**
   * Live renderer-recovery policy. When `reloadStalledRenderer` is set, a
   * renderer that has been unloaded longer than `stallReloadMs` is force-reloaded
   * instead of being skipped forever (the display-reconfigure / GPU context-loss
   * zombie case). Read live so the GUI toggle applies without a relaunch. When
   * omitted, the built-in default (reload after 30s) applies.
   */
  getRendererRecoveryPolicy?: () => { reloadStalledRenderer: boolean; stallReloadMs: number } | null;
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
  // Bookkeeping so a newly-requested recovery can tell whether it wants to run
  // sooner than the currently-armed timer (and pre-empt it) vs. coalesce.
  private recoveryTimerArmedAt: number | null = null;
  private recoveryTimerDelayMs = 0;
  private recoveryRunning = false;
  private pendingTrigger: string | null = null;
  private loadedWebContentsIds = new Set<number>();
  // Wall-clock when the current renderer entered the unloaded state (attach /
  // did-start-loading), cleared on did-finish-load. Lets recovery distinguish a
  // renderer that's briefly loading from one wedged unloaded for tens of seconds.
  private unloadedSince: number | null = null;
  // Whether the CURRENT renderer's main frame has ever finished loading. A
  // never-loaded startup window stays show:false (no ready-to-show), so it must
  // be reloadable even while hidden; a window that loaded before and is now
  // hidden must NOT be force-reloaded (it may be intentionally hidden). Reset on
  // attach (new renderer).
  private everLoaded = false;
  // When runRecovery skips a not-yet-stalled unloaded renderer, it records the
  // ms until the stall deadline here; the finally arms a single follow-up
  // recovery at that delay (can't call requestRecovery inline — it would coalesce
  // under the running guard and the finally would then use a fixed 1s delay).
  private stallDeadlineRescheduleMs: number | null = null;
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
    // Arm a retry window on ANY capture failure (including a TIMEOUT) so a
    // still-high heap gets another attempt rather than being latched off forever.
    // Crash recovery reloads via webContents.reload(), NOT attachWindow(), so it does
    // NOT re-arm the latch — without this, a single timed-out capture on a renderer
    // that then survives would permanently disable all further snapshots. The retry
    // only fires after SNAPSHOT_RETRY_COOLDOWN_MS (well past the capture timeout), by
    // which point the abandoned native capture has settled; and its late-settler (see
    // heap-snapshot.ts) removes any file it wrote, so a retry can't overlap a live one.
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
    // The renderer is unloaded until its first did-finish-load; start the stall
    // clock now so a window that never finishes its initial load is recoverable.
    this.unloadedSince = this.now();
    this.everLoaded = false;
    // Re-arm the heap-snapshot latch for the NEW renderer: it was disarmed after capturing
    // the OLD renderer (armed re-only when the heap dips below the re-arm boundary). A
    // replacement renderer that starts ABOVE the threshold would otherwise never trigger its
    // own snapshot until its heap first fell below hysteresis.
    this.heapSnapshotArmed = true;
    this.heapSnapshotRetryAfter = 0;
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
      this.everLoaded = true;
      this.log('main-renderer-load-finished', this.windowDetails(window), true);
    });
    // The stall clock keys on MAIN-FRAME navigation only. did-start-loading /
    // did-finish-load / did-fail-load are aggregate WebContents events that also
    // fire for subframes — Kai renders artifact/code previews in <iframe>s — so
    // an iframe load must NOT arm the stall clock (that would force-reload a
    // healthy main renderer after 30s and discard UI state). did-start-navigation
    // and did-frame-finish-load carry isMainFrame; use them for the stall clock.
    onContents('did-start-navigation', (...args: never[]) => {
      const details = args[0] as { isMainFrame?: boolean } | undefined;
      if (!details?.isMainFrame) return;
      // Main frame started (re)navigating → renderer is unloaded until
      // did-frame-finish-load. Arm the stall watchdog for EVERY main-frame
      // navigation, not just recovery-initiated reloads: a reload from any path
      // (crash auto-reload, two-probe recovery, or a normal navigation) that
      // then silently wedges must still be caught without waiting on an
      // unrelated focus/display event. The loop-guard caps actual reloads.
      this.unloadedSince = this.now();
      this.armStallWatchdog();
    });
    onContents('did-frame-finish-load', (...args: never[]) => {
      const isMainFrame = args[1] as boolean | undefined;
      if (isMainFrame) {
        this.unloadedSince = null;
        this.everLoaded = true;
      }
    });
    onContents('did-fail-load', (...args: never[]) => {
      // Only a MAIN-FRAME load failure matters: a display reconfigure / context
      // loss can abort the main-frame load, leaving the renderer unloaded with no
      // did-frame-finish-load to follow. A subframe (iframe preview) failing to
      // load is not a renderer stall. Re-arm recovery so the stall-reload path
      // fires once the main frame has been unloaded past the threshold.
      const isMainFrame = args[4] as boolean | undefined;
      if (!isMainFrame) return;
      this.log('main-renderer-load-failed', this.windowDetails(window), true);
      this.requestRecovery('renderer-load-failed', 750);
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
      // The await can span a detach (+ reattach of a NEW window): stopHeapHeartbeat cleared
      // the flag and attachWindow may have installed a fresh sample cycle. If this captured
      // window is no longer the attached one (or was destroyed), DROP this stale sample —
      // acting on it would snapshot a detached/destroyed window and its finally would clear
      // the NEW cycle's running flag, causing overlapping heartbeat work.
      if (this.attachedWindow !== window || window.isDestroyed() || window.webContents.isDestroyed()) {
        return;
      }
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
      // Only clear the flag if we still own the attachment. If a detach (+ reattach)
      // happened during the await, a NEW cycle owns heapHeartbeatRunning now — clearing it
      // here would let two heartbeats run concurrently.
      if (this.attachedWindow === window) this.heapHeartbeatRunning = false;
    }
  }

  detachWindow(): void {
    this.stopHeapHeartbeat();
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
      this.recoveryTimerArmedAt = null;
    }
    const window = this.attachedWindow;
    // Guard against a destroyed window/webContents: detachWindow runs on the
    // renderer-crash recovery path (render-process-gone → attachWindow → detachWindow),
    // where the just-crashed webContents — or a window torn down by the updater — is
    // already destroyed. Touching `.off` on a destroyed BrowserWindow or WebContents
    // throws "Object has been destroyed"; unhandled inside the native CFRunLoop
    // callback that path runs under, that escalates to a V8 fatal (SIGTRAP) and takes
    // the whole main process down. Removing listeners from a destroyed emitter is a
    // no-op anyway (it's gone), so skipping is safe.
    if (window && !window.isDestroyed()) {
      for (const { event, listener } of this.windowListeners) window.off(event as never, listener);
      if (!window.webContents.isDestroyed()) {
        for (const { event, listener } of this.contentsListeners) window.webContents.off(event as never, listener);
      }
    }
    this.windowListeners = [];
    this.contentsListeners = [];
    this.attachedWindow = null;
    this.unloadedSince = null;
    this.stallDeadlineRescheduleMs = null;
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

  /**
   * Schedule a recovery at the stall deadline so an unloaded/wedged renderer is
   * re-checked without waiting on an external focus/display event. Called from
   * every main-frame navigation start (covers all reload paths) and from the
   * cooldown-suppressed branch. No-op when stall-reload is disabled. requestRecovery
   * pre-empts/coalesces, so calling this repeatedly is safe.
   */
  private armStallWatchdog(extraDelayMs = 0): void {
    const policy = this.options.getRendererRecoveryPolicy?.() ?? {
      reloadStalledRenderer: true,
      stallReloadMs: STALL_RELOAD_MS,
    };
    if (!policy.reloadStalledRenderer) return;
    this.requestRecovery('stall-watchdog', Math.max(250, policy.stallReloadMs + 250 + extraDelayMs));
  }

  requestRecovery(trigger: string, delayMs = 1_000): void {
    this.pendingTrigger = trigger;
    if (this.recoveryRunning) {
      this.log('recovery-coalesced', { trigger });
      return;
    }
    if (this.recoveryTimer) {
      // A timer is already pending. If the new request wants to run at least as
      // soon as what's scheduled, replace it (a fresh focus/display trigger must
      // not be blocked behind a longer stall-deadline backstop); otherwise
      // coalesce. Uses `>` so an equally-soon (or already-due) trigger pre-empts.
      if (delayMs > this.pendingRecoveryDelayRemainingMs()) {
        this.log('recovery-coalesced', { trigger });
        return;
      }
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    this.log('recovery-scheduled', { trigger, delayMs });
    this.recoveryTimerArmedAt = this.now();
    this.recoveryTimerDelayMs = delayMs;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.runRecovery(trigger);
    }, delayMs);
  }

  /** Remaining ms on the currently-armed recovery timer (Infinity if none). */
  private pendingRecoveryDelayRemainingMs(): number {
    if (this.recoveryTimer === null || this.recoveryTimerArmedAt === null) return Infinity;
    const elapsed = this.now() - this.recoveryTimerArmedAt;
    return Math.max(0, this.recoveryTimerDelayMs - elapsed);
  }

  private async runRecovery(trigger: string): Promise<void> {
    if (this.recoveryRunning) return;
    this.recoveryRunning = true;
    this.pendingTrigger = null;
    // The captured `window` must remain the CURRENT primary across each await — a
    // close+recreate during a slow probe would otherwise make reviveNativeSurface/reload
    // operate on the NEW window, and the finally would clear a fresh recovery's flag. Bail
    // (without clearing the flag if a new recovery now owns it) when ownership is lost.
    let window: HealthWindow | null = null;
    const stillOwnsRecovery = (): boolean =>
      window !== null &&
      this.options.getPrimaryWindow() === window &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed();
    try {
      window = this.options.getPrimaryWindow();
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
        this.log('recovery-skipped', { trigger, reason: 'no-primary-window' });
        return;
      }
      if (!window.isVisible() || window.isMinimized()) {
        const unloadedMs = this.unloadedSince === null ? 0 : this.now() - this.unloadedSince;
        const policy = this.options.getRendererRecoveryPolicy?.() ?? {
          reloadStalledRenderer: true,
          stallReloadMs: STALL_RELOAD_MS,
        };
        // A never-loaded STARTUP window stays show:false because it can't emit
        // ready-to-show until it loads — so it must be reloadable even while
        // hidden, or an initial stall is unrecoverable. A window that HAS loaded
        // and is now hidden may be intentionally hidden: don't force-reload it,
        // just keep the watchdog alive (it'll recover once shown).
        const neverLoaded = !this.everLoaded && !this.loadedWebContentsIds.has(window.webContents.id);
        if (
          policy.reloadStalledRenderer &&
          neverLoaded &&
          this.unloadedSince !== null &&
          unloadedMs >= policy.stallReloadMs
        ) {
          if (!this.canAutoReload()) {
            const cooldownMs = this.cooldownRemainingMs();
            this.log(
              'auto-reload-suppressed',
              { trigger, reason: 'reload-loop-guard', context: 'hidden-startup-stall', unloadedMs, cooldownMs },
              true,
            );
            if (cooldownMs > 0) this.stallDeadlineRescheduleMs = cooldownMs + 250;
            return;
          }
          this.reloadHistory.push(this.now());
          this.log(
            'renderer-reload-stalled-load',
            { trigger, context: 'hidden-startup', unloadedMs, ...this.windowDetails(window) },
            true,
          );
          this.unloadedSince = this.now();
          this.stallDeadlineRescheduleMs = policy.stallReloadMs + 250;
          window.webContents.reload();
          return;
        }
        this.log('recovery-skipped', {
          trigger,
          reason: 'window-not-presented',
          unloadedMs,
          ...this.windowDetails(window),
        });
        // Previously-presented hidden window that's unloaded: keep re-checking
        // at the CONFIGURED stall cadence (not a hardcoded default).
        if (
          policy.reloadStalledRenderer &&
          this.unloadedSince !== null &&
          !this.loadedWebContentsIds.has(window.webContents.id)
        ) {
          this.stallDeadlineRescheduleMs = policy.stallReloadMs + 250;
        }
        return;
      }
      if (!this.loadedWebContentsIds.has(window.webContents.id)) {
        // Renderer isn't loaded. Normally this is a brief in-flight load and we
        // skip. But a display-reconfigure / GPU context-loss zombie stays
        // unloaded forever (did-finish-load never re-fires) — the crash logs
        // showed ~8h of this skip. If it's been unloaded past the stall
        // threshold, force a reload through the loop-guard instead of skipping.
        const policy = this.options.getRendererRecoveryPolicy?.() ?? {
          reloadStalledRenderer: true,
          stallReloadMs: STALL_RELOAD_MS,
        };
        const unloadedMs = this.unloadedSince === null ? 0 : this.now() - this.unloadedSince;
        if (policy.reloadStalledRenderer && this.unloadedSince !== null && unloadedMs >= policy.stallReloadMs) {
          if (!this.canAutoReload()) {
            // The default watchdog can land inside the 60s auto-reload cooldown
            // (stallReloadMs is ~30s). Rather than give up — which would leave the
            // renderer wedged until an unrelated event — reschedule for when the
            // cooldown expires so the retry actually gets to reload. If the block
            // is the per-window COUNT cap instead (cooldownRemaining==0), don't
            // reschedule: the cap is a genuine "stop trying" backstop.
            const cooldownMs = this.cooldownRemainingMs();
            this.log(
              'auto-reload-suppressed',
              { trigger, reason: 'reload-loop-guard', context: 'stalled-load', unloadedMs, cooldownMs },
              true,
            );
            if (cooldownMs > 0) this.stallDeadlineRescheduleMs = cooldownMs + 250;
            return;
          }
          this.reloadHistory.push(this.now());
          this.log('renderer-reload-stalled-load', { trigger, unloadedMs, ...this.windowDetails(window) }, true);
          // Reset the stall clock so the loop-guard (not this timer) paces any retry,
          // and arm a post-reload watchdog: reload() fires did-start-loading but no
          // listener re-triggers recovery, so if THIS reload also wedges (no
          // did-finish-load / did-fail-load) nothing would re-check. Schedule a
          // follow-up one stall window out (armed by the finally); the loop-guard
          // caps how many times this can actually reload, so it can't hot-loop.
          this.unloadedSince = this.now();
          this.stallDeadlineRescheduleMs = policy.stallReloadMs + 250;
          window.webContents.reload();
          return;
        }
        // Unloaded but not yet past the stall threshold. Skip probing now, but if
        // stall-reload is enabled and the clock is running, self-schedule a
        // follow-up at the remaining deadline — otherwise a zombie renderer with
        // no further focus/display events would stay unloaded forever (the branch
        // above only fires when SOMETHING re-triggers recovery after the
        // threshold). Recorded here and armed by the finally (we're inside a
        // running recovery, so requestRecovery would just coalesce); +250ms
        // guards against firing a hair early.
        if (policy.reloadStalledRenderer && this.unloadedSince !== null) {
          const remainingMs = Math.max(250, policy.stallReloadMs - unloadedMs + 250);
          this.log('recovery-skipped', {
            trigger,
            reason: 'renderer-not-loaded',
            unloadedMs,
            rescheduleInMs: remainingMs,
            ...this.windowDetails(window),
          });
          this.stallDeadlineRescheduleMs = remainingMs;
          return;
        }
        this.log('recovery-skipped', {
          trigger,
          reason: 'renderer-not-loaded',
          unloadedMs,
          ...this.windowDetails(window),
        });
        return;
      }

      this.log('recovery-probe-started', { trigger, ...this.windowDetails(window) }, true);
      const firstProbe = await this.probe(window);
      if (!stillOwnsRecovery()) {
        this.log('recovery-skipped', { trigger, reason: 'window-replaced-during-probe' });
        return;
      }
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
      if (!stillOwnsRecovery()) {
        this.log('recovery-skipped', { trigger, reason: 'window-replaced-during-probe' });
        return;
      }
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
      // Clear the flag ONLY if we still own the recovery — a close+recreate during an await
      // may have started a NEW recovery for the replacement window; clearing then would let
      // two recoveries overlap. (The mid-body `recoveryRunning = false` for the deferred path
      // above is guarded by an immediate return + fresh requestRecovery.)
      if (window === null || this.options.getPrimaryWindow() === window) {
        this.recoveryRunning = false;
        // Honor a stall-deadline reschedule first (specific delay), else fall back
        // to the generic pending-trigger reschedule.
        const stallMs = this.stallDeadlineRescheduleMs;
        this.stallDeadlineRescheduleMs = null;
        if (stallMs !== null && !this.recoveryTimer) {
          this.requestRecovery('stalled-load-deadline', stallMs);
        } else {
          const pending = this.pendingTrigger;
          if (pending && !this.recoveryTimer) this.requestRecovery(pending, 1_000);
        }
      }
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

  /**
   * Ms until `canAutoReload()` would next return true because of the COOLDOWN
   * (not the per-window cap). 0 if reloading is already allowed or the block is
   * the count cap (which the cooldown can't clear). Lets the suppressed
   * stall-reload branch reschedule for the cooldown's expiry instead of giving up.
   */
  private cooldownRemainingMs(): number {
    const now = this.now();
    const latest = this.reloadHistory.at(-1);
    if (latest === undefined) return 0;
    return Math.max(0, AUTO_RELOAD_COOLDOWN_MS - (now - latest));
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

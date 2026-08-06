import { EventEmitter } from 'events';
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NativeImage, ProcessMetric, WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  probeWindowHealth,
  sampleRendererHeap,
  WindowHealthMonitor,
  type HealthWindow,
  type RendererHeapSample,
  type WindowHealthProbeResult,
} from '../window-health';

class FakeContents extends EventEmitter {
  id = 41;
  destroyed = false;
  reload = vi.fn();
  invalidate = vi.fn();
  executeJavaScript = vi.fn();
  capturePage = vi.fn();
  isDestroyed = vi.fn(() => this.destroyed);
  getOSProcessId = vi.fn(() => 4242);
  getURL = vi.fn(() => 'file:///Applications/Kai/index.html?approval=secret#fragment');
}

class FakeWindow extends EventEmitter {
  destroyed = false;
  visible = true;
  minimized = false;
  webContents = new FakeContents();
  isDestroyed = vi.fn(() => this.destroyed);
  isVisible = vi.fn(() => this.visible);
  isMinimized = vi.fn(() => this.minimized);
  getBounds = vi.fn(() => ({ x: 10, y: 20, width: 1100, height: 750 }));
}

function asHealthWindow(window: FakeWindow): HealthWindow {
  return window as unknown as HealthWindow;
}

function visibleImage(): NativeImage {
  return {
    isEmpty: () => false,
    getSize: () => ({ width: 100, height: 80 }),
    toBitmap: () => Buffer.from([0, 0, 0, 255]),
  } as unknown as NativeImage;
}

const healthyProbe: WindowHealthProbeResult = {
  healthy: true,
  rendererResponsive: true,
  animationFrameCompleted: true,
  documentReadyState: 'complete',
  rootChildCount: 1,
  captureEmpty: false,
  captureSize: { width: 100, height: 80 },
  captureHasVisiblePixels: true,
};

const failedProbe: WindowHealthProbeResult = {
  healthy: false,
  rendererResponsive: true,
  animationFrameCompleted: true,
  documentReadyState: 'complete',
  rootChildCount: 1,
  captureEmpty: true,
  captureSize: { width: 0, height: 0 },
  captureHasVisiblePixels: false,
};

describe('probeWindowHealth', () => {
  it('requires both renderer animation progress and visible composited pixels', async () => {
    const window = new FakeWindow();
    window.webContents.executeJavaScript.mockResolvedValue({
      readyState: 'complete',
      visibilityState: 'visible',
      rootChildCount: 1,
      animationFrameCompleted: true,
    });
    window.webContents.capturePage.mockResolvedValue(visibleImage());

    const result = await probeWindowHealth(asHealthWindow(window));

    expect(window.webContents.invalidate).toHaveBeenCalledTimes(1);
    expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(window.webContents.capturePage).toHaveBeenCalledTimes(1);
    expect(result.healthy).toBe(true);
    expect(result.captureHasVisiblePixels).toBe(true);
  });

  it('reports a responsive renderer with an empty surface as unhealthy', async () => {
    const window = new FakeWindow();
    window.webContents.executeJavaScript.mockResolvedValue({
      readyState: 'complete',
      visibilityState: 'visible',
      rootChildCount: 1,
      animationFrameCompleted: true,
    });
    window.webContents.capturePage.mockResolvedValue({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      toBitmap: () => Buffer.alloc(0),
    } as unknown as NativeImage);

    const result = await probeWindowHealth(asHealthWindow(window));

    expect(result.rendererResponsive).toBe(true);
    expect(result.captureEmpty).toBe(true);
    expect(result.healthy).toBe(false);
  });

  it('maps performance.memory bytes into MB and a used/limit percentage', async () => {
    const window = new FakeWindow();
    window.webContents.executeJavaScript.mockResolvedValue({
      readyState: 'complete',
      visibilityState: 'visible',
      rootChildCount: 1,
      animationFrameCompleted: true,
      jsHeapUsed: 2_048 * 1024 * 1024, // 2048 MB
      jsHeapTotal: 3_000 * 1024 * 1024,
      jsHeapLimit: 4_096 * 1024 * 1024, // 4096 MB → 50% used
    });
    window.webContents.capturePage.mockResolvedValue(visibleImage());

    const result = await probeWindowHealth(asHealthWindow(window));

    expect(result.jsHeapUsedMB).toBe(2_048);
    expect(result.jsHeapTotalMB).toBe(3_000);
    expect(result.jsHeapLimitMB).toBe(4_096);
    expect(result.jsHeapUsedPct).toBe(50);
  });

  it('leaves heap fields undefined when performance.memory is unavailable', async () => {
    const window = new FakeWindow();
    window.webContents.executeJavaScript.mockResolvedValue({
      readyState: 'complete',
      visibilityState: 'visible',
      rootChildCount: 1,
      animationFrameCompleted: true,
    });
    window.webContents.capturePage.mockResolvedValue(visibleImage());

    const result = await probeWindowHealth(asHealthWindow(window));

    expect(result.jsHeapUsedMB).toBeUndefined();
    expect(result.jsHeapUsedPct).toBeUndefined();
  });
});

describe('WindowHealthMonitor recovery policy', () => {
  let dir: string;
  let logPath: string;
  let window: FakeWindow;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kai-window-health-'));
    logPath = join(dir, 'window-health.log');
    window = new FakeWindow();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeMonitor(
    options: {
      probe?: () => Promise<WindowHealthProbeResult>;
      active?: () => boolean;
      now?: () => number;
      revive?: () => void | Promise<void>;
      heapSampler?: (window: HealthWindow) => Promise<RendererHeapSample>;
      heapHeartbeatIntervalMs?: number;
      isHeapHeartbeatEnabled?: () => boolean;
      getMaxLogBytes?: () => number;
      getHeapSnapshotPolicy?: () => { enabled: boolean; thresholdPct: number } | null;
      onHeapSnapshotTrigger?: (window: HealthWindow, sample: RendererHeapSample) => void | Promise<void>;
      skipLoad?: boolean;
    } = {},
  ): WindowHealthMonitor {
    const monitor = new WindowHealthMonitor({
      logPath,
      getPrimaryWindow: () => asHealthWindow(window),
      getProcessMetrics: () => [] as ProcessMetric[],
      hasActiveWork: options.active ?? (() => false),
      reviveNativeSurface: options.revive,
      probe: options.probe ? async () => options.probe!() : async () => healthyProbe,
      heapSampler: options.heapSampler,
      isHeapHeartbeatEnabled: options.isHeapHeartbeatEnabled,
      getMaxLogBytes: options.getMaxLogBytes,
      getHeapSnapshotPolicy: options.getHeapSnapshotPolicy,
      onHeapSnapshotTrigger: options.onHeapSnapshotTrigger,
      now: options.now,
      // Heartbeat off by default so recovery tests are deterministic; the
      // heartbeat suite opts in with a short interval.
      timings: {
        surfaceRetryDelayMs: 0,
        activeWorkRetryMs: 60_000,
        heapHeartbeatIntervalMs: options.heapHeartbeatIntervalMs ?? 0,
      },
    });
    monitor.attachWindow(asHealthWindow(window));
    if (!options.skipLoad) window.webContents.emit('did-finish-load');
    return monitor;
  }

  it('rebuilds the native surface then reloads after two failed probes', async () => {
    const revive = vi.fn();
    const probe = vi.fn().mockResolvedValue(failedProbe);
    const monitor = makeMonitor({ probe, revive });

    monitor.requestRecovery('test-failed-surface', 0);
    await vi.waitFor(() => expect(window.webContents.reload).toHaveBeenCalledTimes(1));

    expect(probe).toHaveBeenCalledTimes(2);
    expect(revive).toHaveBeenCalledTimes(1);
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('event=recovery-probe-result');
    expect(log).toContain('event=native-surface-rebuilt');
    expect(log).toContain('event=auto-reload');
    monitor.detachWindow();
  });

  it('does not reload when the first probe succeeds', async () => {
    const probe = vi.fn().mockResolvedValue(healthyProbe);
    const revive = vi.fn();
    const monitor = makeMonitor({ probe, revive });

    monitor.requestRecovery('healthy-window', 0);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

    expect(revive).not.toHaveBeenCalled();
    expect(window.webContents.reload).not.toHaveBeenCalled();
    monitor.detachWindow();
  });

  it('defers reload while an agent stream is active', async () => {
    const probe = vi.fn().mockResolvedValue(failedProbe);
    const monitor = makeMonitor({ probe, active: () => true });

    monitor.requestRecovery('active-stream', 0);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));

    expect(window.webContents.reload).not.toHaveBeenCalled();
    expect(readFileSync(logPath, 'utf-8')).toContain('event=auto-reload-deferred');
    monitor.detachWindow();
  });

  it('automatically reloads a crashed primary renderer but suppresses a reload loop', () => {
    let now = 1_000_000;
    const monitor = makeMonitor({ now: () => now });
    const contents = window.webContents as unknown as Pick<WebContents, 'id' | 'getURL' | 'getOSProcessId'>;

    monitor.recordRendererGone(contents, { reason: 'crashed', exitCode: 5 });
    monitor.recordRendererGone(contents, { reason: 'crashed', exitCode: 5 });
    now += 61_000;
    monitor.recordRendererGone(contents, { reason: 'crashed', exitCode: 5 });
    now += 61_000;
    monitor.recordRendererGone(contents, { reason: 'crashed', exitCode: 5 });

    expect(window.webContents.reload).toHaveBeenCalledTimes(2);
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('event=render-process-gone');
    expect(log).toContain('event=auto-reload-suppressed');
    expect(log).not.toContain('approval=secret');
    monitor.detachWindow();
  });

  it('records GPU exits with process context and schedules recovery', async () => {
    const probe = vi.fn().mockResolvedValue(healthyProbe);
    const monitor = makeMonitor({ probe });

    monitor.recordChildProcessGone({ type: 'GPU', reason: 'crashed', exitCode: 9 });
    expect(readFileSync(logPath, 'utf-8')).toContain('event=child-process-gone');
    expect(readFileSync(logPath, 'utf-8')).toContain('"type":"GPU"');
    monitor.detachWindow();
  });

  it('emits renderer-heap-pressure when a probe reports the heap over the absolute ceiling', async () => {
    const probe = vi.fn().mockResolvedValue({
      ...healthyProbe,
      jsHeapUsedMB: 2_500,
      jsHeapTotalMB: 2_800,
      jsHeapLimitMB: 4_096,
      jsHeapUsedPct: 61,
    } satisfies WindowHealthProbeResult);
    const monitor = makeMonitor({ probe });

    monitor.requestRecovery('heap-pressure', 0);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('event=renderer-heap-pressure');
    expect(log).toContain('"trippedBy":"absolute"');
    monitor.detachWindow();
  });

  it('does not emit renderer-heap-pressure when the heap is below both thresholds', async () => {
    const probe = vi.fn().mockResolvedValue({
      ...healthyProbe,
      jsHeapUsedMB: 800,
      jsHeapLimitMB: 4_096,
      jsHeapUsedPct: 20,
    } satisfies WindowHealthProbeResult);
    const monitor = makeMonitor({ probe });

    monitor.requestRecovery('heap-ok', 0);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));

    expect(readFileSync(logPath, 'utf-8')).not.toContain('event=renderer-heap-pressure');
    monitor.detachWindow();
  });

  it('logs a renderer-heap-heartbeat on the heartbeat interval', async () => {
    const heapSampler = vi.fn().mockResolvedValue({
      jsHeapUsedMB: 1_024,
      jsHeapTotalMB: 1_100,
      jsHeapLimitMB: 4_096,
      jsHeapUsedPct: 25,
    } satisfies RendererHeapSample);
    const monitor = makeMonitor({ heapSampler, heapHeartbeatIntervalMs: 5 });

    await vi.waitFor(() => expect(heapSampler).toHaveBeenCalled());
    await vi.waitFor(() => expect(readFileSync(logPath, 'utf-8')).toContain('event=renderer-heap-heartbeat'));

    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('"jsHeapUsedMB":1024');
    // A below-threshold heartbeat must NOT emit the flagged pressure event.
    expect(log).not.toContain('event=renderer-heap-pressure');
    monitor.detachWindow();
  });

  it('escalates a heartbeat over the ceiling to renderer-heap-pressure', async () => {
    const heapSampler = vi.fn().mockResolvedValue({
      jsHeapUsedMB: 3_600,
      jsHeapTotalMB: 3_700,
      jsHeapLimitMB: 4_096,
      jsHeapUsedPct: 88,
    } satisfies RendererHeapSample);
    const monitor = makeMonitor({ heapSampler, heapHeartbeatIntervalMs: 5 });

    await vi.waitFor(() => expect(readFileSync(logPath, 'utf-8')).toContain('event=renderer-heap-pressure'));

    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('event=renderer-heap-heartbeat');
    expect(log).toContain('"trippedBy":"absolute"');
    expect(log).toContain('"trigger":"heartbeat"');
    monitor.detachWindow();
  });

  it('does not sample the heap before the renderer has finished loading', async () => {
    const heapSampler = vi.fn().mockResolvedValue({ jsHeapUsedMB: 10 } satisfies RendererHeapSample);
    // skipLoad → did-finish-load never fires, so the webContents id is not marked loaded.
    const monitor = makeMonitor({ heapSampler, heapHeartbeatIntervalMs: 5, skipLoad: true });

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(heapSampler).not.toHaveBeenCalled();
    monitor.detachWindow();
  });

  it('stops the heartbeat on detach', async () => {
    const heapSampler = vi.fn().mockResolvedValue({ jsHeapUsedMB: 10 } satisfies RendererHeapSample);
    const monitor = makeMonitor({ heapSampler, heapHeartbeatIntervalMs: 5 });

    await vi.waitFor(() => expect(heapSampler).toHaveBeenCalled());
    monitor.detachWindow();
    const callsAfterDetach = heapSampler.mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(heapSampler.mock.calls.length).toBe(callsAfterDetach);
  });

  it('does not sample the heap while the diagnostics setting is off', async () => {
    const heapSampler = vi.fn().mockResolvedValue({ jsHeapUsedMB: 10 } satisfies RendererHeapSample);
    const monitor = makeMonitor({ heapSampler, heapHeartbeatIntervalMs: 5, isHeapHeartbeatEnabled: () => false });

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(heapSampler).not.toHaveBeenCalled();
    monitor.detachWindow();
  });

  it('samples once the diagnostics setting flips on without re-attaching', async () => {
    let enabled = false;
    const heapSampler = vi.fn().mockResolvedValue({ jsHeapUsedMB: 10 } satisfies RendererHeapSample);
    const monitor = makeMonitor({
      heapSampler,
      heapHeartbeatIntervalMs: 5,
      isHeapHeartbeatEnabled: () => enabled,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(heapSampler).not.toHaveBeenCalled();

    enabled = true; // live toggle — no re-attach
    await vi.waitFor(() => expect(heapSampler).toHaveBeenCalled());
    monitor.detachWindow();
  });

  it('rolls window-health.log at the injected max-bytes cap', () => {
    // Tiny cap + a large per-line payload so a handful of events cross 1 MiB.
    const monitor = makeMonitor({ getMaxLogBytes: () => 1024 * 1024 });
    const big = 'x'.repeat(30 * 1024); // ~30 KiB/line → ~35 lines to exceed 1 MiB
    for (let i = 0; i < 50; i++) monitor.recordLifecycleEvent('display-metrics-changed', { i, big });
    // appendBoundedLog checks size BEFORE each append, so once the live file
    // exceeds 1 MiB it renames to `.1`. Assert the roll happened and the live
    // file was reset below the cap after the roll.
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(statSync(logPath).size).toBeLessThan(1024 * 1024);
    monitor.detachWindow();
  });

  it('reads the cap live, so raising it stops the roll', () => {
    let cap = 1024 * 1024; // start tiny
    const monitor = makeMonitor({ getMaxLogBytes: () => cap });
    cap = 50 * 1024 * 1024; // GUI raises it before any write
    for (let i = 0; i < 40; i++) monitor.recordLifecycleEvent('display-metrics-changed', { i });
    // With the raised cap the file never crosses it, so no `.1` roll appears.
    expect(existsSync(`${logPath}.1`)).toBe(false);
    monitor.detachWindow();
  });

  it('falls back to the default cap when getMaxLogBytes returns garbage', () => {
    // A non-finite / absurdly small value must NOT disable the bound (which would
    // let the log grow unbounded); the built-in 10 MiB default applies instead.
    const monitor = makeMonitor({ getMaxLogBytes: () => Number.NaN });
    for (let i = 0; i < 40; i++) monitor.recordLifecycleEvent('display-metrics-changed', { i });
    // 40 small lines stay well under 10 MiB → no roll, and the file exists.
    expect(existsSync(`${logPath}.1`)).toBe(false);
    expect(statSync(logPath).size).toBeGreaterThan(0);
    monitor.detachWindow();
  });

  it('triggers a heap snapshot once when the heap crosses the threshold, then latches', async () => {
    let pct = 50;
    const heapSampler = vi.fn(async () => ({
      jsHeapUsedMB: Math.round(pct * 40),
      jsHeapLimitMB: 4000,
      jsHeapUsedPct: pct,
    }));
    const onHeapSnapshotTrigger = vi.fn();
    const monitor = makeMonitor({
      heapSampler,
      heapHeartbeatIntervalMs: 5,
      getHeapSnapshotPolicy: () => ({ enabled: true, thresholdPct: 85 }),
      onHeapSnapshotTrigger,
    });

    // Below threshold → no trigger.
    await vi.waitFor(() => expect(heapSampler.mock.calls.length).toBeGreaterThan(1));
    expect(onHeapSnapshotTrigger).not.toHaveBeenCalled();

    // Cross the threshold → exactly one trigger, and it stays latched while pinned.
    pct = 100;
    await vi.waitFor(() => expect(onHeapSnapshotTrigger).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30)); // several more ticks at 100%
    expect(onHeapSnapshotTrigger).toHaveBeenCalledTimes(1); // still latched
    expect(readFileSync(logPath, 'utf-8')).toContain('event=renderer-heap-snapshot-triggered');
    monitor.detachWindow();
  });

  it('re-arms the snapshot after the heap recovers below the threshold', async () => {
    let pct = 100;
    const heapSampler = vi.fn(async () => ({ jsHeapUsedMB: 3600, jsHeapLimitMB: 4000, jsHeapUsedPct: pct }));
    const onHeapSnapshotTrigger = vi.fn();
    const monitor = makeMonitor({
      heapSampler,
      heapHeartbeatIntervalMs: 5,
      getHeapSnapshotPolicy: () => ({ enabled: true, thresholdPct: 85 }),
      onHeapSnapshotTrigger,
    });

    await vi.waitFor(() => expect(onHeapSnapshotTrigger).toHaveBeenCalledTimes(1));
    pct = 60; // recover below threshold - hysteresis (85-10=75) → re-arm
    await new Promise((r) => setTimeout(r, 20));
    pct = 100; // climb again → second trigger
    await vi.waitFor(() => expect(onHeapSnapshotTrigger).toHaveBeenCalledTimes(2));
    monitor.detachWindow();
  });

  it('does not trigger a snapshot when the policy is disabled', async () => {
    const heapSampler = vi.fn(async () => ({ jsHeapUsedMB: 3900, jsHeapLimitMB: 4000, jsHeapUsedPct: 98 }));
    const onHeapSnapshotTrigger = vi.fn();
    const monitor = makeMonitor({
      heapSampler,
      heapHeartbeatIntervalMs: 5,
      getHeapSnapshotPolicy: () => null, // disabled
      onHeapSnapshotTrigger,
    });

    await vi.waitFor(() => expect(heapSampler.mock.calls.length).toBeGreaterThan(2));
    expect(onHeapSnapshotTrigger).not.toHaveBeenCalled();
    monitor.detachWindow();
  });
});

describe('sampleRendererHeap', () => {
  it('maps performance.memory bytes to MB and a used/limit percentage', async () => {
    const window = new FakeWindow();
    window.webContents.executeJavaScript.mockResolvedValue({
      u: 1_024 * 1024 * 1024,
      t: 1_500 * 1024 * 1024,
      l: 4_096 * 1024 * 1024,
    });

    const sample = await sampleRendererHeap(asHealthWindow(window));

    expect(sample.jsHeapUsedMB).toBe(1_024);
    expect(sample.jsHeapLimitMB).toBe(4_096);
    expect(sample.jsHeapUsedPct).toBe(25);
    // Heartbeat probe must NOT capture the surface — that would be too heavy per tick.
    expect(window.webContents.capturePage).not.toHaveBeenCalled();
  });

  it('returns an error when the renderer is unreachable', async () => {
    const window = new FakeWindow();
    window.webContents.executeJavaScript.mockRejectedValue(new Error('renderer gone'));

    const sample = await sampleRendererHeap(asHealthWindow(window));

    expect(sample.error).toBe('renderer gone');
    expect(sample.jsHeapUsedMB).toBeUndefined();
  });
});

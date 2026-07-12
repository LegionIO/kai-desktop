import {
  startLocalMacosTakeoverMonitor as startNativeMonitor,
  type LocalMacosTakeoverEvent,
  type LocalMacosTakeoverMonitorHandle,
} from './harnesses/local-macos.js';
import { resolveMaterializedHelperPath } from './permissions.js';

export type { LocalMacosTakeoverEvent };

type Listener = {
  onEvent: (event: LocalMacosTakeoverEvent) => void;
  onError?: (message: string) => void;
};

let activeMonitor: LocalMacosTakeoverMonitorHandle | null = null;
let activeListener: Listener | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let shouldRun = false;
let suppressedUntil = 0;

/**
 * Drop monitor events for the next `durationMs` milliseconds.
 *
 * The macOS Swift helper tags its own synthetic events and filters them at
 * source. The Windows PowerShell helper filters via LL*HF_INJECTED. Linux
 * `xinput test-xi2` cannot distinguish XTEST-injected events from real ones,
 * so the cross-platform harness calls this around every input action as a
 * timing-based guard that also provides defence-in-depth on the other OSes.
 */
export function suppressTakeoverEvents(durationMs: number): void {
  suppressedUntil = Math.max(suppressedUntil, Date.now() + durationMs);
}

/** True while takeover events are being suppressed (within a suppression window). */
export function isTakeoverSuppressed(now = Date.now()): boolean {
  return now < suppressedUntil;
}

function clearRestartTimer(): void {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function scheduleRestart(): void {
  if (!shouldRun || !activeListener || restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (shouldRun && activeListener) {
      startMonitor(activeListener);
    }
  }, 1200);
}

function startMonitor(listener: Listener): void {
  clearRestartTimer();
  activeListener = listener;

  if (process.platform !== 'darwin') {
    void import('../platform/index.js').then(async ({ getPlatformAdapter }) => {
      if (!shouldRun) return;
      const adapter = await getPlatformAdapter();
      if (!shouldRun) return;
      const handle = adapter.startInputMonitor(
        (e) => {
          if (isTakeoverSuppressed()) return;
          listener.onEvent({
            event: 'takeover',
            kind: e.kind,
            eventType: e.eventType,
            x: e.x,
            y: e.y,
            keyCode: e.keyCode,
            deltaX: e.deltaX,
            deltaY: e.deltaY,
            timestampMs: e.timestampMs,
          });
        },
        (message) => listener.onError?.(message),
      );
      if (!shouldRun) {
        handle.stop();
        return;
      }
      activeMonitor = { process: null as unknown as LocalMacosTakeoverMonitorHandle['process'], stop: handle.stop };
    });
    return;
  }

  resolveMaterializedHelperPath();
  const monitor = startNativeMonitor({
    onEvent: listener.onEvent,
    onError: (message) => listener.onError?.(message),
  });

  activeMonitor = monitor;

  monitor.process.on('exit', (code, signal) => {
    // A superseded monitor's delayed exit must not schedule a restart: if this
    // process is no longer the active one (stop→rapid-start replaced it), just
    // return so we don't spawn an untracked duplicate on top of the new monitor.
    if (activeMonitor?.process !== monitor.process) return;
    activeMonitor = null;
    if (!shouldRun) return;
    listener.onError?.(`Local macOS takeover monitor exited (${signal ?? code ?? 'unknown'}).`);
    scheduleRestart();
  });
}

export function startLocalMacosTakeoverMonitor(listener: Listener): void {
  shouldRun = true;
  activeListener = listener;
  if (activeMonitor && activeMonitor.process && !activeMonitor.process.killed) {
    return;
  }
  if (activeMonitor && !activeMonitor.process) {
    return;
  }
  // Clear any suppression window left over from a prior session so the first
  // moments of this session aren't blind to a genuine manual takeover. Done
  // AFTER the already-active guards so an idempotent re-entry on a running
  // monitor can't clear a legitimately-active window mid-action.
  suppressedUntil = 0;
  startMonitor(listener);
}

export function stopLocalMacosTakeoverMonitor(): void {
  shouldRun = false;
  clearRestartTimer();
  activeListener = null;
  activeMonitor?.stop();
  activeMonitor = null;
  // Reset the suppression window so it can't carry into a later session and
  // briefly blind takeover detection at that session's start.
  suppressedUntil = 0;
}

import { WebContentsView, type Session, type WebContents } from 'electron';
import { hardenRemoteWebPreferences } from './session.js';

export const BROWSER_SERVICE_WORKER_COMMAND_TIMEOUT_MS = 5_000;

class BrowserServiceWorkerCommandTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`${command} exceeded its ${timeoutMs / 1_000} second deadline.`);
    this.name = 'BrowserServiceWorkerCommandTimeoutError';
  }
}

async function runServiceWorkerCommandWithDeadline<T>(
  command: string,
  task: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        reject(new BrowserServiceWorkerCommandTimeoutError(command, timeoutMs));
      },
      Math.max(0, timeoutMs),
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(task), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Stop every running worker in a Browser profile through CDP. Electron's
 * ServiceWorkers API exposes inventory but no stop primitive, so a temporary,
 * sandboxed WebContentsView provides a CDP target when no tab is alive. */
export async function stopRunningBrowserServiceWorkers(
  scopedSession: Session,
  contents?: WebContents,
  requireSuccess = false,
  commandTimeoutMs = BROWSER_SERVICE_WORKER_COMMAND_TIMEOUT_MS,
  acquireDebuggerLease?: (target: WebContents) => { release: () => void },
  aggregateTimeoutMs = commandTimeoutMs,
): Promise<void> {
  let versionIds: string[];
  try {
    const serviceWorkers = scopedSession.serviceWorkers;
    versionIds = serviceWorkers ? Object.keys(serviceWorkers.getAllRunning()) : [];
  } catch (error) {
    if (requireSuccess) throw error;
    return;
  }
  if (versionIds.length === 0) return;

  let temporaryView: WebContentsView | null = null;
  let target = contents;
  let wasAttached = false;
  let debuggerLease: { release: () => void } | undefined;
  const deadlineAt = Date.now() + Math.max(0, aggregateTimeoutMs);
  const remainingCommandTime = (command: string): number => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new BrowserServiceWorkerCommandTimeoutError(command, aggregateTimeoutMs);
    return Math.min(commandTimeoutMs, remaining);
  };
  try {
    if (!target || target.isDestroyed()) {
      const webPreferences: Record<string, unknown> = { session: scopedSession };
      hardenRemoteWebPreferences(webPreferences);
      temporaryView = new WebContentsView({ webPreferences: webPreferences as Electron.WebPreferences });
      target = temporaryView.webContents;
    }
    // A manager-owned live tab may share this debugger with bounded Browser
    // work. Join its ownership set only after worker inventory proves CDP is
    // needed; the helper's private temporary target has no outside consumers.
    if (!temporaryView && acquireDebuggerLease) debuggerLease = acquireDebuggerLease(target);
    wasAttached = target.debugger.isAttached();
    if (!wasAttached) target.debugger.attach('1.3');
    await runServiceWorkerCommandWithDeadline(
      'ServiceWorker.enable',
      () => target!.debugger.sendCommand('ServiceWorker.enable'),
      remainingCommandTime('ServiceWorker.enable'),
    );
    // Keep CDP pressure bounded. A profile can accumulate many registrations;
    // eagerly allocating one command and deadline timer per worker can stall the
    // main process exactly while profile clearing is trying to drain it.
    let firstFailure: { error: unknown } | undefined;
    for (const versionId of versionIds) {
      try {
        await runServiceWorkerCommandWithDeadline(
          `ServiceWorker.stopWorker (${versionId})`,
          () => target!.debugger.sendCommand('ServiceWorker.stopWorker', { versionId }),
          remainingCommandTime(`ServiceWorker.stopWorker (${versionId})`),
        );
      } catch (error) {
        firstFailure ??= { error };
        // A timed-out CDP call is not cancellable. Stop issuing more commands
        // on this target; detaching/closing it below bounds retained native work
        // to that single command, while the aggregate deadline bounds the full
        // cleanup regardless of the number of worker registrations.
        if (error instanceof BrowserServiceWorkerCommandTimeoutError) break;
      }
    }
    if (requireSuccess && firstFailure) throw firstFailure.error;
  } catch (error) {
    if (requireSuccess) throw error;
  } finally {
    if (target && !wasAttached && !target.isDestroyed() && target.debugger.isAttached()) target.debugger.detach();
    debuggerLease?.release();
    if (temporaryView) {
      try {
        if (!temporaryView.webContents.isDestroyed()) temporaryView.webContents.close({ waitForBeforeUnload: false });
      } catch {
        // Best-effort reclamation of the temporary CDP target.
      }
    }
  }
}

import { WebContentsView, type Session, type WebContents } from 'electron';
import { hardenRemoteWebPreferences } from './session.js';

export const BROWSER_SERVICE_WORKER_COMMAND_TIMEOUT_MS = 5_000;

async function runServiceWorkerCommandWithDeadline<T>(
  command: string,
  task: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        reject(new Error(`${command} exceeded its ${timeoutMs / 1_000} second deadline.`));
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
  try {
    if (!target || target.isDestroyed()) {
      const webPreferences: Record<string, unknown> = { session: scopedSession };
      hardenRemoteWebPreferences(webPreferences);
      temporaryView = new WebContentsView({ webPreferences: webPreferences as Electron.WebPreferences });
      target = temporaryView.webContents;
    }
    wasAttached = target.debugger.isAttached();
    if (!wasAttached) target.debugger.attach('1.3');
    await runServiceWorkerCommandWithDeadline(
      'ServiceWorker.enable',
      () => target!.debugger.sendCommand('ServiceWorker.enable'),
      commandTimeoutMs,
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
          commandTimeoutMs,
        );
      } catch (error) {
        firstFailure ??= { error };
      }
    }
    if (requireSuccess && firstFailure) throw firstFailure.error;
  } catch (error) {
    if (requireSuccess) throw error;
  } finally {
    if (target && !wasAttached && !target.isDestroyed() && target.debugger.isAttached()) target.debugger.detach();
    if (temporaryView) {
      try {
        if (!temporaryView.webContents.isDestroyed()) temporaryView.webContents.close({ waitForBeforeUnload: false });
      } catch {
        // Best-effort reclamation of the temporary CDP target.
      }
    }
  }
}

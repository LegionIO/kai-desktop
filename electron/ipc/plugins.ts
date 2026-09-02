import type { BrowserWindow, IpcMain } from 'electron';
import { app } from 'electron';
import type { PluginManager } from '../plugins/plugin-manager.js';
import { UnverifiedPluginError } from '../plugins/marketplace-service.js';
import { isCanonicalPrimaryRendererUrl } from '../primary-renderer-url.js';

const RENDERER_RELOAD_TIMEOUT_MS = 30_000;

export function registerPluginHandlers(
  ipcMain: IpcMain,
  pluginManager: PluginManager,
  getPrimaryWindow: () => BrowserWindow | null,
  revokePrimaryRendererAuthority: () => void,
  primaryRendererUrl: string,
): void {
  if (
    !getPrimaryWindow ||
    !revokePrimaryRendererAuthority ||
    !isCanonicalPrimaryRendererUrl(primaryRendererUrl, primaryRendererUrl)
  ) {
    throw new Error('Plugin renderer replacement requires primary-renderer revocation callbacks and a canonical URL.');
  }
  const reloadPrimaryRendererIfRequired = async (_pluginName: string, required: boolean): Promise<void> => {
    if (!required) return;
    const primaryWindow = getPrimaryWindow();
    if (!primaryWindow || primaryWindow.isDestroyed() || primaryWindow.webContents.isDestroyed()) {
      return;
    }
    const contents = primaryWindow.webContents;
    // Confirm that the old realm actually unloaded before forgetting that it
    // held the plugin. A page-level beforeunload handler must not be allowed to
    // retain the authenticated Browser bridge after the plugin is disabled.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        contents.removeListener('will-prevent-unload', onWillPreventUnload);
        contents.removeListener('did-navigate', onDidNavigate);
        contents.removeListener('did-fail-load', onDidFailLoad);
        contents.removeListener('render-process-gone', onRenderProcessGone);
        contents.removeListener('destroyed', onDestroyed);
      };
      const finish = (error?: Error, rendererAlreadyRevoked = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!error) {
          resolve();
          return;
        }
        // A failed or wedged reload must fail closed. The disabled frontend
        // plugin still has every capability of the old renderer realm until
        // that renderer exits, including the authenticated Browser bridge.
        if (!rendererAlreadyRevoked && !contents.isDestroyed()) {
          try {
            contents.forcefullyCrashRenderer();
          } catch {
            // BrowserWindow.destroy() is the last-resort synchronous revocation
            // path if Chromium refuses the renderer crash request.
            try {
              if (!primaryWindow.isDestroyed()) primaryWindow.destroy();
            } catch {
              // Preserve the reload error; both revocation APIs failing is
              // still surfaced through diagnostics and the rejected IPC call.
            }
          }
        }
        reject(error);
      };
      const onWillPreventUnload = (event: Electron.Event) => {
        // Electron interprets preventDefault here as permission to ignore the
        // page's beforeunload veto and continue replacing the renderer.
        event.preventDefault();
      };
      const onDidNavigate = (_event: Electron.Event, url: string) => {
        if (!isCanonicalPrimaryRendererUrl(url, primaryRendererUrl)) {
          finish(new Error('Primary renderer replacement committed an unexpected URL.'));
          return;
        }
        finish();
      };
      const onDidFailLoad = (
        _event: Electron.Event,
        errorCode: number,
        errorDescription: string,
        _validatedUrl: string,
        isMainFrame: boolean,
      ) => {
        // ERR_ABORTED may be followed by another committed top-level
        // navigation. Keep waiting for that replacement rather than
        // acknowledging the old realm prematurely.
        if (isMainFrame && errorCode !== -3) {
          finish(new Error(`Primary renderer reload failed (${errorCode}): ${errorDescription}`));
        }
      };
      const onRenderProcessGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) =>
        finish(new Error(`Primary renderer exited during reload: ${details.reason}`), true);
      const onDestroyed = () => finish(new Error('Primary renderer was destroyed during reload.'), true);
      const timeout = setTimeout(
        () => finish(new Error('Timed out waiting for the primary renderer to reload.')),
        RENDERER_RELOAD_TIMEOUT_MS,
      );
      timeout.unref?.();

      contents.on('will-prevent-unload', onWillPreventUnload);
      contents.on('did-navigate', onDidNavigate);
      contents.on('did-fail-load', onDidFailLoad);
      contents.on('render-process-gone', onRenderProcessGone);
      contents.on('destroyed', onDestroyed);
      try {
        void contents.loadURL(primaryRendererUrl).catch((error: unknown) => {
          finish(error instanceof Error ? error : new Error(String(error)));
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  pluginManager.setRendererReplacementHandler(async (pluginName) => {
    // Revoke authenticated Browser IPC before requesting navigation. A reload
    // can fail before Chromium emits did-start-navigation, and crashing a
    // renderer is asynchronous; neither window leaves the old plugin realm
    // with a usable Browser bridge while replacement is being confirmed.
    let revocationError: unknown;
    try {
      revokePrimaryRendererAuthority();
    } catch (error) {
      // Bookkeeping failure must not leave the already-loaded plugin realm
      // alive with its authenticated Browser bridge. Replace every renderer,
      // then surface the original failure to the lifecycle caller.
      revocationError = error;
    }
    await reloadPrimaryRendererIfRequired(pluginName, true);
    if (revocationError) throw revocationError;
  });
  ipcMain.handle('plugin:get-ui-state', () => {
    return pluginManager.getUIState();
  });

  ipcMain.handle('plugin:list', () => {
    return pluginManager.listPlugins();
  });

  ipcMain.handle('plugin:get-config', (_event, pluginName: string) => {
    return pluginManager.getPluginConfig(pluginName);
  });

  ipcMain.handle('plugin:set-config', (_event, pluginName: string, path: string, value: unknown) => {
    pluginManager.setPluginConfig(pluginName, path, value);
    return { success: true };
  });

  ipcMain.handle(
    'plugin:modal-action',
    async (_event, pluginName: string, modalId: string, action: string, data?: unknown) => {
      return pluginManager.handleAction({
        pluginName,
        targetId: modalId,
        action,
        data,
      });
    },
  );

  ipcMain.handle(
    'plugin:banner-action',
    async (_event, pluginName: string, bannerId: string, action: string, data?: unknown) => {
      return pluginManager.handleAction({
        pluginName,
        targetId: bannerId,
        action,
        data,
      });
    },
  );

  // Generic plugin action dispatch (for settings sections and any plugin-defined targets)
  ipcMain.handle(
    'plugin:action',
    async (_event, pluginName: string, targetId: string, action: string, data?: unknown) => {
      return pluginManager.handleAction({
        pluginName,
        targetId,
        action,
        data,
      });
    },
  );

  // ── Marketplace ──

  ipcMain.handle('plugin:marketplace-catalog', () => {
    return pluginManager.getMarketplaceCatalog();
  });

  // Distinguishes "no marketplace configured" from "configured but the startup
  // catalog fetch hasn't settled yet" so the renderer doesn't falsely report
  // the former during the async init window.
  ipcMain.handle('plugin:marketplace-status', () => {
    return pluginManager.getMarketplaceStatus();
  });

  // Atomic catalog + status read — avoids the renderer pairing an old catalog
  // with newer status (or vice-versa) across two separate round-trips.
  ipcMain.handle('plugin:marketplace-snapshot', () => {
    return pluginManager.getMarketplaceSnapshot();
  });

  ipcMain.handle('plugin:marketplace-install', async (_event, pluginName: string) => {
    try {
      await pluginManager.installFromMarketplace(pluginName);
      return { success: true };
    } catch (err) {
      if (err instanceof UnverifiedPluginError) {
        return {
          success: false,
          needsConfirmation: true,
          pluginName: err.pluginName,
          reason: 'no-integrity-hash',
        };
      }
      throw err;
    }
  });

  ipcMain.handle('plugin:marketplace-install-unverified', async (_event, pluginName: string) => {
    await pluginManager.installFromMarketplace(pluginName, { skipHashCheck: true });
    return { success: true };
  });

  ipcMain.handle('plugin:marketplace-uninstall', async (_event, pluginName: string) => {
    await pluginManager.uninstallFromMarketplace(pluginName);
    return { success: true };
  });

  ipcMain.handle('plugin:disable', async (_event, pluginName: string, opts?: { persist?: boolean }) => {
    await pluginManager.disablePlugin(pluginName, { persist: opts?.persist ?? true });
    return { success: true };
  });

  ipcMain.handle('plugin:enable', async (_event, pluginName: string) => {
    await pluginManager.enablePlugin(pluginName);
    return { success: true };
  });

  ipcMain.handle('plugin:pause', async (_event, pluginName: string) => {
    await pluginManager.pausePlugin(pluginName);
    return { success: true };
  });

  ipcMain.handle('plugin:resume', async (_event, pluginName: string) => {
    await pluginManager.resumePlugin(pluginName);
    return { success: true };
  });

  ipcMain.handle('plugin:kill', async (_event, pluginName: string) => {
    await pluginManager.killPlugin(pluginName);
    return { success: true };
  });

  ipcMain.handle('plugin:marketplace-refresh', async () => {
    const catalog = await pluginManager.refreshMarketplace();
    return catalog;
  });

  ipcMain.handle('plugin:available-update-count', () => {
    return pluginManager.getAvailableUpdateCount();
  });

  ipcMain.handle('plugin:pending-restart', () => {
    return pluginManager.getPendingRestart();
  });

  ipcMain.handle('plugin:failed-updates', () => {
    return pluginManager.getFailedUpdates();
  });

  ipcMain.handle('plugin:restart-app', () => {
    setTimeout(() => {
      app.relaunch();
      app.quit();
    }, 200);
    return { success: true };
  });

  // ── Permission Consent ──

  ipcMain.handle('plugin:approve-consent', async (_event, pluginName: string, expectedFileHash?: string) => {
    // REJECT a hashless APPROVE (R29P3): the generation hash is how main rejects a
    // STALE cross-request approval (R28P55). A pre-fix client (e.g. a web client from
    // an older build reconnecting after restart) whose bridge omits the hash would
    // otherwise skip that check — approving a same-name H2 with different, UNSEEN
    // dangerous permissions. The current desktop + web bridges always send it, so a
    // missing hash means a stale client that must reload; fail closed rather than
    // grant permissions the user may never have seen. (Deny is unaffected — denying
    // grants nothing and its own stale-guard no-ops on mismatch.)
    if (typeof expectedFileHash !== 'string' || expectedFileHash.length === 0) {
      return { success: false, error: 'This approval is stale; please reload and try again.' };
    }
    try {
      const success = await pluginManager.approveAndReload(pluginName, expectedFileHash);
      return { success };
    } catch (err) {
      // approveAndReload only THROWS for a PRE-mutation refusal — an active app-update
      // freeze (assertNoActiveFreeze), before any consent state is consumed or approval
      // persisted. Mirror the deny handler (R37P2): return a structured failure instead
      // of letting the rejection escape. The renderer's handleApprove has no catch, so
      // an escaped rejection would surface as an unhandled promise rejection AND skip
      // the pending-consent resync; a { success:false } keeps the prompt for a retry
      // once the freeze clears (nothing was consumed, so the retry is a genuine no-op-
      // free retry).
      return { success: false, error: err instanceof Error ? err.message : 'Could not approve the plugin right now' };
    }
  });

  ipcMain.handle('plugin:deny-consent', async (_event, pluginName: string, expectedFileHash?: string) => {
    try {
      await pluginManager.denyPlugin(pluginName, expectedFileHash);
      return { success: true };
    } catch (err) {
      // denyPlugin only THROWS for a PRE-mutation refusal (an active app-update
      // freeze) — nothing was consumed, so this is genuinely retryable: return
      // success:false and the modal keeps the prompt for a retry once the freeze
      // clears (R28P17/R28P50). A POST-consumption rollback failure does NOT throw
      // (denyPlugin swallows it and resolves) — the modal correctly drops the stale
      // prompt rather than offering a no-op retry that would strand the generation.
      return { success: false, error: err instanceof Error ? err.message : 'Could not deny the plugin right now' };
    }
  });

  ipcMain.handle('plugin:pending-consent', () => {
    return pluginManager.getPendingConsent();
  });
}

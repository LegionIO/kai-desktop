import type { IpcMain } from 'electron';
import { app } from 'electron';
import type { PluginManager } from '../plugins/plugin-manager.js';
import { UnverifiedPluginError } from '../plugins/marketplace-service.js';

export function registerPluginHandlers(ipcMain: IpcMain, pluginManager: PluginManager): void {
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

  ipcMain.handle('plugin:restart-app', () => {
    setTimeout(() => {
      app.relaunch();
      app.quit();
    }, 200);
    return { success: true };
  });

  // ── Permission Consent ──

  ipcMain.handle('plugin:approve-consent', async (_event, pluginName: string) => {
    const success = await pluginManager.approveAndReload(pluginName);
    return { success };
  });

  ipcMain.handle('plugin:deny-consent', (_event, pluginName: string) => {
    pluginManager.denyPlugin(pluginName);
    return { success: true };
  });

  ipcMain.handle('plugin:pending-consent', () => {
    return pluginManager.getPendingConsent();
  });
}

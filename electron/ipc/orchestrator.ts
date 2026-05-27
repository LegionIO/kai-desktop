/**
 * Orchestrator IPC handlers — wires the renderer to the TaskDispatcher.
 *
 * Persistence is delegated back to the caller via a setConfig function so we
 * don't need to know how the desktop config is written to disk; this keeps the
 * orchestrator decoupled from the config plumbing.
 */

import type { IpcMain } from 'electron';
import { BrowserWindow } from 'electron';

import type { DispatcherConfig, TaskDispatcher, TaskDispatcherState } from '../agent/task-dispatcher.js';

interface RegisterOrchestratorHandlersOptions {
  /** Persist the full autopilot config back to desktop.json. */
  setConfig?: (path: string, value: unknown) => void;
}

export function broadcastOrchestratorState(state: TaskDispatcherState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('orchestrator:state-changed', state);
    } catch {
      // Best-effort — a destroyed/loading window shouldn't crash the dispatcher.
    }
  }
}

export function registerOrchestratorHandlers(
  ipcMain: IpcMain,
  dispatcher: TaskDispatcher,
  _appHome: string,
  options: RegisterOrchestratorHandlersOptions = {},
): void {
  const persist = (config: DispatcherConfig): void => {
    if (!options.setConfig) return;
    try {
      options.setConfig('autopilot', config);
    } catch (err) {
      console.warn('[orchestrator] Failed to persist autopilot config:', err);
    }
  };

  ipcMain.handle('orchestrator:get-state', () => {
    return dispatcher.getState();
  });

  ipcMain.handle('orchestrator:get-config', () => {
    return dispatcher.getConfig();
  });

  ipcMain.handle('orchestrator:toggle', (_event, enabled: boolean) => {
    dispatcher.toggle(Boolean(enabled));
    persist(dispatcher.getConfig());
    return dispatcher.getState();
  });

  ipcMain.handle('orchestrator:set-config', (_event, partial: Partial<DispatcherConfig>) => {
    const next = dispatcher.updateConfig(partial ?? {});
    persist(next);
    return dispatcher.getState();
  });

  ipcMain.handle('orchestrator:force-tick', async () => {
    const decisions = await dispatcher.forceTick();
    return { decisions, state: dispatcher.getState() };
  });

  ipcMain.handle('orchestrator:clear-log', () => {
    dispatcher.clearLog();
    return dispatcher.getState();
  });
}

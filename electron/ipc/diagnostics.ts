import type { IpcMain } from 'electron';
import { statSync, writeFileSync, rmSync } from 'fs';
import {
  getDiagnosticCounters,
  getDiagnosticsBootTs,
  readLogTail,
  resetDiagnosticCounters,
  type DiagnosticCounter,
} from '../diagnostics/main-diagnostics.js';
import {
  getPluginProcessMetrics,
  refreshPluginProcessPrivateMemory,
  type PluginProcessMetric,
} from '../plugins/process/plugin-process-host.js';

export interface DiagnosticsSummary {
  logPath: string;
  logSizeBytes: number;
  sinceBoot: string;
  totalErrors: number;
  counters: DiagnosticCounter[];
  /** One OS process per plugin, sampled through Electron's app metrics. */
  pluginProcesses: PluginProcessMetric[];
}

/** Max bytes returned by diagnostics:tail-log (keeps the IPC payload bounded). */
const TAIL_MAX_BYTES = 256 * 1024;

function logSize(logPath: string): number {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

export function registerDiagnosticsHandlers(ipcMain: IpcMain, mainProcessLogPath: string): void {
  ipcMain.handle('diagnostics:get-summary', async (): Promise<DiagnosticsSummary> => {
    await refreshPluginProcessPrivateMemory();
    const counters = getDiagnosticCounters();
    return {
      logPath: mainProcessLogPath,
      logSizeBytes: logSize(mainProcessLogPath),
      sinceBoot: getDiagnosticsBootTs(),
      totalErrors: counters.reduce((sum, c) => sum + c.count, 0),
      counters,
      pluginProcesses: getPluginProcessMetrics(),
    };
  });

  ipcMain.handle('diagnostics:tail-log', async (_event, maxBytes?: number) => {
    const cap = Math.min(TAIL_MAX_BYTES, Math.max(1024, typeof maxBytes === 'number' ? maxBytes : TAIL_MAX_BYTES));
    return readLogTail(mainProcessLogPath, cap);
  });

  ipcMain.handle('diagnostics:clear-log', async () => {
    try {
      writeFileSync(mainProcessLogPath, '');
    } catch {
      /* file may not exist */
    }
    // Also drop the rotated sibling if present.
    try {
      rmSync(`${mainProcessLogPath}.1`, { force: true });
    } catch {
      /* noop */
    }
    return { success: true, logSizeBytes: logSize(mainProcessLogPath) };
  });

  ipcMain.handle('diagnostics:reset-counters', async () => {
    resetDiagnosticCounters();
    return { success: true };
  });
}

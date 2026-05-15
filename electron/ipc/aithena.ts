/**
 * Aithena Memory IPC Handlers — exposes cognitive memory operations to renderer.
 *
 * Handlers:
 *   aithena:health          — Test connection
 *   aithena:stats           — Get memory statistics
 *   aithena:compile-context — Compile context packet
 *   aithena:recall          — Recall relevant memories
 *   aithena:learn           — Send a learning event
 *   aithena:remember        — Store a specific memory
 *   aithena:skill-search    — Search for proven workflows
 */

import type { IpcMain } from 'electron';
import type { AppConfig } from '../config/schema.js';
import {
  getAithenaAdapter,
  type CompileContextOptions,
  type LearnInput,
  type RememberInput,
} from '../agent/aithena-memory.js';

export function registerAithenaHandlers(
  ipcMain: IpcMain,
  getConfig: () => AppConfig,
): void {
  ipcMain.handle('aithena:health', async () => {
    const adapter = getAithenaAdapter(getConfig());
    if (!adapter) {
      return { ok: false, error: 'Aithena is not configured. Enable it in settings.' };
    }
    return adapter.checkHealth();
  });

  ipcMain.handle('aithena:stats', async () => {
    const adapter = getAithenaAdapter(getConfig());
    if (!adapter) {
      return { error: 'Aithena is not configured' };
    }
    const stats = await adapter.getStats();
    return stats ?? { error: 'Aithena unavailable' };
  });

  ipcMain.handle('aithena:compile-context', async (_event, query: string, options?: CompileContextOptions) => {
    const adapter = getAithenaAdapter(getConfig());
    if (!adapter) return null;
    return adapter.compileContext(query, options);
  });

  ipcMain.handle('aithena:recall', async (_event, query: string, topK?: number) => {
    const adapter = getAithenaAdapter(getConfig());
    if (!adapter) return [];
    return adapter.recall(query, topK);
  });

  ipcMain.handle('aithena:learn', async (_event, input: LearnInput) => {
    const adapter = getAithenaAdapter(getConfig());
    if (!adapter) return;
    adapter.learn(input);
  });

  ipcMain.handle('aithena:remember', async (_event, input: RememberInput) => {
    const adapter = getAithenaAdapter(getConfig());
    if (!adapter) return;
    adapter.remember(input);
  });

  ipcMain.handle('aithena:skill-search', async (_event, query: string, topK?: number) => {
    const adapter = getAithenaAdapter(getConfig());
    if (!adapter) return [];
    return adapter.skillSearch(query, topK);
  });
}

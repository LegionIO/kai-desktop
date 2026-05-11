import { app, session, type IpcMain } from 'electron';
import { join } from 'path';
import { existsSync, readdirSync, statSync, rmSync } from 'fs';

/**
 * Recursively calculate total size of a directory in bytes.
 */
function dirSize(dirPath: string): number {
  let total = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += dirSize(fullPath);
      } else {
        try {
          total += statSync(fullPath).size;
        } catch { /* skip unreadable files */ }
      }
    }
  } catch { /* skip unreadable dirs */ }
  return total;
}

export function registerPartitionHandlers(ipcMain: IpcMain): void {
  const partitionsDir = join(app.getPath('userData'), 'Partitions');

  ipcMain.handle('partitions:list', async () => {
    if (!existsSync(partitionsDir)) return [];

    try {
      const entries = readdirSync(partitionsDir, { withFileTypes: true });
      const partitions: Array<{ name: string; sizeBytes: number }> = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = join(partitionsDir, entry.name);
        const sizeBytes = dirSize(fullPath);
        partitions.push({ name: entry.name, sizeBytes });
      }

      return partitions;
    } catch (error) {
      console.warn('[Partitions] Failed to list partitions:', error);
      return [];
    }
  });

  ipcMain.handle('partitions:delete', async (_event, names: string[]) => {
    if (!Array.isArray(names) || names.length === 0) {
      return { error: 'No partition names provided.' };
    }

    const deleted: string[] = [];

    try {
      for (const name of names) {
        // Sanitize: disallow path traversal
        if (name.includes('..') || name.includes('/') || name.includes('\\')) {
          continue;
        }

        // Clear in-memory session data first
        try {
          const ses = session.fromPartition(`persist:${name}`);
          await ses.clearStorageData();
          await ses.clearCache();
        } catch {
          // Session might not exist in-memory — that's fine
        }

        // Also try without persist: prefix (plugins may use either form)
        try {
          const ses = session.fromPartition(name);
          await ses.clearStorageData();
          await ses.clearCache();
        } catch {
          // Ignore
        }

        // Remove the directory from disk
        const dirPath = join(partitionsDir, name);
        if (existsSync(dirPath)) {
          rmSync(dirPath, { recursive: true, force: true });
        }

        deleted.push(name);
      }

      return { success: true, deleted };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Failed to delete partitions.',
        deleted,
      };
    }
  });
}

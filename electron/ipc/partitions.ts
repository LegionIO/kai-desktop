import { app, session, type IpcMain } from 'electron';
import { join, resolve, sep } from 'path';
import { existsSync, readdirSync, statSync, rmSync } from 'fs';

/**
 * Recursively calculate total size of a directory in bytes. Bounded by depth and
 * a total entry budget so a pathological/symlinked tree can't stall the main
 * thread. Does not follow symlinked directories (uses Dirent.isDirectory, false
 * for symlinks).
 */
function dirSize(dirPath: string, budget = { entriesLeft: 200_000 }, depth = 0): number {
  if (depth > 40 || budget.entriesLeft <= 0) return 0;
  let total = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (budget.entriesLeft <= 0) break;
      budget.entriesLeft--;
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += dirSize(fullPath, budget, depth + 1);
      } else if (entry.isFile()) {
        try {
          total += statSync(fullPath).size;
        } catch {
          /* skip unreadable files */
        }
      }
    }
  } catch {
    /* skip unreadable dirs */
  }
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
        // Sanitize: reject anything that isn't a plain single-segment directory
        // name. `..`/`/`/`\` are path traversal; `''` and `.` both resolve
        // join(partitionsDir, name) back to partitionsDir itself, which would
        // rmSync the ENTIRE partitions directory. Require a non-empty name that
        // resolves to a DIRECT child of partitionsDir.
        if (typeof name !== 'string' || name === '' || name === '.' || name === '..') continue;
        if (name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('\0')) {
          continue;
        }
        const dirPath = join(partitionsDir, name);
        // Defense in depth: the resolved path must be a strict child of
        // partitionsDir (not partitionsDir itself, not an escape).
        const relative = resolve(dirPath);
        if (relative === resolve(partitionsDir) || !relative.startsWith(resolve(partitionsDir) + sep)) {
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

        // Remove the directory from disk (dirPath validated above).
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

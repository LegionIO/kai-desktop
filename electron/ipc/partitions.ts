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

/**
 * Whether `name` is safe to delete as a DIRECT child directory of
 * `partitionsDir`. Rejects (returns null) anything that could escape or that
 * resolves back to `partitionsDir` itself (which would rmSync the ENTIRE
 * partitions tree): non-strings, ''/'.'/'..' , names containing '..' / '/' /
 * '\\' / NUL, and any path that doesn't resolve to a strict child. On success
 * returns the resolved absolute directory path to delete.
 */
export function resolveSafePartitionDir(name: unknown, partitionsDir: string): string | null {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..') return null;
  if (name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    return null;
  }
  const dirPath = join(partitionsDir, name);
  const relative = resolve(dirPath);
  if (relative === resolve(partitionsDir) || !relative.startsWith(resolve(partitionsDir) + sep)) {
    return null;
  }
  return dirPath;
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
        // Reject anything that isn't a plain single-segment name resolving to a
        // DIRECT child of partitionsDir (see resolveSafePartitionDir). `''`/`.`
        // would otherwise resolve back to partitionsDir and rmSync the whole tree.
        const dirPath = resolveSafePartitionDir(name, partitionsDir);
        if (dirPath === null) continue;

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
          const ses = session.fromPartition(name as string);
          await ses.clearStorageData();
          await ses.clearCache();
        } catch {
          // Ignore
        }

        // Remove the directory from disk (dirPath validated above).
        if (existsSync(dirPath)) {
          rmSync(dirPath, { recursive: true, force: true });
        }

        deleted.push(name as string);
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

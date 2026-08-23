import { app, type IpcMain } from 'electron';
import { join, resolve, sep } from 'path';
import { existsSync, readdirSync, statSync, rmSync } from 'fs';
import {
  isInAppBrowserPartition,
  isInAppBrowserPartitionName,
  MAX_PLUGIN_BROWSER_PARTITION_CLEAR_NAMES,
} from '../browser/session.js';
import { clearPluginBrowserPartitions } from '../browser/plugin-partitions.js';
import {
  clearCorruptPluginBrowserQuarantineMarkers,
  inspectQuarantinedPluginBrowserPartitions,
  listKnownPluginBrowserPartitionNames,
} from '../plugins/browser-window/lifecycle.js';

export const CORRUPT_PLUGIN_BROWSER_QUARANTINE_RECOVERY_ID = '\0kai:recover-plugin-browser-quarantine';

type PartitionEntry = {
  name: string;
  displayName?: string;
  sizeBytes: number;
  quarantined?: boolean;
  recoveryRequired?: 'all-plugin-partitions';
  corruptMarkerCount?: number;
};

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

function listPluginPartitionDirectoryNames(partitionsDir: string): string[] {
  if (!existsSync(partitionsDir)) return [];
  return readdirSync(partitionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !isInAppBrowserPartitionName(entry.name))
    .map((entry) => entry.name);
}

export function registerPartitionHandlers(ipcMain: IpcMain): void {
  const partitionsDir = join(app.getPath('userData'), 'Partitions');

  ipcMain.handle('partitions:list', async () => {
    const partitions = new Map<string, PartitionEntry>();
    try {
      for (const name of listPluginPartitionDirectoryNames(partitionsDir)) {
        partitions.set(name, { name, sizeBytes: dirSize(join(partitionsDir, name)) });
      }
    } catch (error) {
      // Durable quarantine rows remain useful even when Chromium's Partitions
      // directory is temporarily unreadable, so do not collapse the whole list.
      console.warn('[Partitions] Failed to enumerate Chromium partitions:', error);
    }

    const quarantine = inspectQuarantinedPluginBrowserPartitions();
    for (const name of quarantine.partitionNames) {
      if (isInAppBrowserPartitionName(name) || resolveSafePartitionDir(name, partitionsDir) === null) continue;
      const existing = partitions.get(name);
      partitions.set(name, {
        name,
        sizeBytes: existing?.sizeBytes ?? 0,
        quarantined: true,
      });
    }
    if (quarantine.corruptMarkerCount > 0 || quarantine.directoryUnreadable) {
      partitions.set(CORRUPT_PLUGIN_BROWSER_QUARANTINE_RECOVERY_ID, {
        name: CORRUPT_PLUGIN_BROWSER_QUARANTINE_RECOVERY_ID,
        displayName: 'Unreadable plugin Browser cleanup state',
        sizeBytes: 0,
        quarantined: true,
        recoveryRequired: 'all-plugin-partitions',
        corruptMarkerCount: quarantine.corruptMarkerCount,
      });
    }

    return [...partitions.values()];
  });

  ipcMain.handle('partitions:delete', async (_event, names: string[]) => {
    if (!Array.isArray(names) || names.length === 0) {
      return { error: 'No partition names provided.' };
    }
    // Bound the request count (R181): each name that survives the safe-path
    // filter installs a durable clear-fence, enqueues a partition clear, and
    // constructs an Electron Session — so an unbounded name list (thousands of
    // fabricated names) synchronously creates that many fences / sessions /
    // queue entries even when no such profile exists on disk. A real inventory
    // never approaches this, so cap defensively.
    if (names.length > MAX_PLUGIN_BROWSER_PARTITION_CLEAR_NAMES) {
      return { error: 'Too many partition names provided.' };
    }

    const deleted: string[] = [];

    try {
      const recoverAll = names.includes(CORRUPT_PLUGIN_BROWSER_QUARANTINE_RECOVERY_ID);
      const requestedNames = new Set(names.filter((name) => name !== CORRUPT_PLUGIN_BROWSER_QUARANTINE_RECOVERY_ID));
      if (recoverAll) {
        for (const name of listPluginPartitionDirectoryNames(partitionsDir)) requestedNames.add(name);
        const quarantine = inspectQuarantinedPluginBrowserPartitions();
        for (const name of quarantine.partitionNames) requestedNames.add(name);
        for (const name of listKnownPluginBrowserPartitionNames()) requestedNames.add(name);
      }
      const validPartitions = [...requestedNames].filter((name): name is string => {
        if (typeof name !== 'string') return false;
        // In-app Browser profiles have their own lifecycle-aware clearing path.
        // Never let the legacy plugin-partition manager tear one down behind a
        // live WebContentsView or contradict the settings UI's scope controls.
        if (isInAppBrowserPartition(name)) return false;
        // Reject anything that isn't a plain single-segment name resolving to a
        // DIRECT child of partitionsDir (see resolveSafePartitionDir). `''`/`.`
        // would otherwise resolve back to partitionsDir and rmSync the whole tree.
        return resolveSafePartitionDir(name, partitionsDir) !== null;
      });
      await clearPluginBrowserPartitions(validPartitions, {
        removePersistentData: (name) => {
          const dirPath = resolveSafePartitionDir(name, partitionsDir)!;
          if (existsSync(dirPath)) {
            rmSync(dirPath, { recursive: true, force: true });
          }
          deleted.push(name);
        },
      });

      const recoveredCorruptMarkers = recoverAll ? clearCorruptPluginBrowserQuarantineMarkers() : 0;

      return {
        success: true,
        deleted,
        ...(recoverAll ? { recoveredCorruptMarkers } : {}),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Failed to delete partitions.',
        deleted,
      };
    }
  });
}

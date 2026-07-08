import type { IpcMain } from 'electron';
import type { AppConfig } from '../config/schema.js';
import type { FileDiff } from '../../shared/diff-types.js';
import {
  clearConversationDiffs,
  getDiff,
  listDiffsForConversation,
  revertDiff,
  revertHunk,
  revertToOp,
} from '../tools/diff-tracker.js';
import { isPathAllowed } from '../tools/file-access.js';

export function registerDiffHandlers(ipcMain: IpcMain, getConfig: () => AppConfig): void {
  const allowed = (path: string): boolean => isPathAllowed(path, getConfig()).allowed;

  ipcMain.handle('diffs:list', (_event, conversationId: string): FileDiff[] => {
    if (typeof conversationId !== 'string') return [];
    // Honor current file-access policy: a path tracked while allowed may since
    // have been denied (or file access disabled).
    return listDiffsForConversation(conversationId).filter((d) => allowed(d.path));
  });

  ipcMain.handle('diffs:get', (_event, conversationId: string, path: string): FileDiff | null => {
    if (typeof conversationId !== 'string' || typeof path !== 'string') return null;
    if (!allowed(path)) return null;
    return getDiff(conversationId, path);
  });

  ipcMain.handle('diffs:revert', (_event, conversationId: string, path: string) => {
    if (typeof conversationId !== 'string' || typeof path !== 'string') {
      return { success: false, error: 'Invalid arguments' };
    }
    if (!allowed(path)) return { success: false, error: 'Path is not currently allowed by file-access policy.' };
    return revertDiff(conversationId, path);
  });

  ipcMain.handle('diffs:revertAll', (_event, conversationId: string) => {
    if (typeof conversationId !== 'string') return { success: false, reverted: 0, skipped: [] };
    // Only revert paths still permitted by the current policy.
    const targets = listDiffsForConversation(conversationId).filter((d) => allowed(d.path));
    let reverted = 0;
    const skipped: string[] = [];
    for (const d of targets) {
      const r = revertDiff(conversationId, d.path);
      if (r.success) reverted++;
      else skipped.push(d.path);
    }
    return { success: skipped.length === 0, reverted, skipped };
  });

  ipcMain.handle('diffs:revertHunk', (_event, conversationId: string, path: string, hunkIndex: number) => {
    if (typeof conversationId !== 'string' || typeof path !== 'string' || typeof hunkIndex !== 'number') {
      return { success: false, error: 'Invalid arguments' };
    }
    if (!allowed(path)) return { success: false, error: 'Path is not currently allowed by file-access policy.' };
    return revertHunk(conversationId, path, hunkIndex);
  });

  ipcMain.handle('diffs:revertToOp', (_event, conversationId: string, path: string, opIndex: number) => {
    if (typeof conversationId !== 'string' || typeof path !== 'string' || typeof opIndex !== 'number') {
      return { success: false, error: 'Invalid arguments' };
    }
    if (!allowed(path)) return { success: false, error: 'Path is not currently allowed by file-access policy.' };
    return revertToOp(conversationId, path, opIndex);
  });

  ipcMain.handle('diffs:clear', (_event, conversationId: string) => {
    if (typeof conversationId !== 'string') return { success: false };
    clearConversationDiffs(conversationId);
    return { success: true };
  });
}

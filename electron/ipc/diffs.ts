import type { IpcMain } from 'electron';
import type { FileDiff } from '../../shared/diff-types.js';
import {
  clearConversationDiffs,
  getDiff,
  listDiffsForConversation,
  revertDiff,
} from '../tools/diff-tracker.js';

export function registerDiffHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('diffs:list', (_event, conversationId: string): FileDiff[] => {
    if (typeof conversationId !== 'string') return [];
    return listDiffsForConversation(conversationId);
  });

  ipcMain.handle('diffs:get', (_event, conversationId: string, path: string): FileDiff | null => {
    if (typeof conversationId !== 'string' || typeof path !== 'string') return null;
    return getDiff(conversationId, path);
  });

  ipcMain.handle('diffs:revert', (_event, conversationId: string, path: string) => {
    if (typeof conversationId !== 'string' || typeof path !== 'string') {
      return { success: false, error: 'Invalid arguments' };
    }
    return revertDiff(conversationId, path);
  });

  ipcMain.handle('diffs:clear', (_event, conversationId: string) => {
    if (typeof conversationId !== 'string') return { success: false };
    clearConversationDiffs(conversationId);
    return { success: true };
  });
}

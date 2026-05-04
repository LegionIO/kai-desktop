import type { IpcMain } from 'electron';
import { dialog, BrowserWindow } from 'electron';
import { stat } from 'fs/promises';
import { randomUUID } from 'crypto';
import { basename } from 'path';
import type { AppConfig, Workspace } from '../config/schema.js';
import { nextWorkspaceColor } from '../config/workspaces.js';

/**
 * Register IPC handlers for workspace CRUD operations.
 *
 * Workspaces are stored as an array inside `config.ui.workspaces`.
 * All mutations go through `setConfig` which persists to desktop.json
 * and broadcasts changes to all renderer windows automatically.
 */
export function registerWorkspaceHandlers(
  ipcMain: IpcMain,
  _appHome: string,
  getConfig: () => AppConfig,
  setConfig: (path: string, value: unknown) => void,
): void {
  // ── Create ──────────────────────────────────────────────────────────────

  ipcMain.handle(
    'workspaces:create',
    async (_event, args: { name: string; directory: string }): Promise<Workspace> => {
      const { name, directory } = args;

      // Validate directory exists
      const dirStat = await stat(directory).catch(() => null);
      if (!dirStat?.isDirectory()) {
        throw new Error(`Directory does not exist: ${directory}`);
      }

      const config = getConfig();
      const workspaces = config.ui?.workspaces ?? [];

      // Prevent duplicate directory
      const existing = workspaces.find((w) => w.directory === directory);
      if (existing) {
        throw new Error(`A workspace already exists for this directory: ${existing.name}`);
      }

      const workspace: Workspace = {
        id: randomUUID(),
        name: name.trim(),
        directory,
        color: nextWorkspaceColor(workspaces),
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
        lastActiveConversationId: null,
      };

      setConfig('ui.workspaces', [...workspaces, workspace]);
      setConfig('ui.activeWorkspaceId', workspace.id);

      return workspace;
    },
  );

  // ── Rename ──────────────────────────────────────────────────────────────

  ipcMain.handle(
    'workspaces:rename',
    async (_event, args: { id: string; name: string }): Promise<void> => {
      const config = getConfig();
      const workspaces = [...(config.ui?.workspaces ?? [])];
      const idx = workspaces.findIndex((w) => w.id === args.id);
      if (idx === -1) throw new Error(`Workspace not found: ${args.id}`);

      workspaces[idx] = { ...workspaces[idx], name: args.name.trim() };
      setConfig('ui.workspaces', workspaces);
    },
  );

  // ── Delete ──────────────────────────────────────────────────────────────

  ipcMain.handle(
    'workspaces:delete',
    async (_event, args: { id: string }): Promise<void> => {
      const config = getConfig();
      const workspaces = (config.ui?.workspaces ?? []).filter((w) => w.id !== args.id);
      setConfig('ui.workspaces', workspaces);

      // If the deleted workspace was active, fall back to most-recent or null
      if (config.ui?.activeWorkspaceId === args.id) {
        if (workspaces.length > 0) {
          const sorted = [...workspaces].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
          setConfig('ui.activeWorkspaceId', sorted[0].id);
        } else {
          setConfig('ui.activeWorkspaceId', null);
        }
      }
    },
  );

  // ── Set Active ──────────────────────────────────────────────────────────

  ipcMain.handle(
    'workspaces:set-active',
    async (_event, args: { id: string | null }): Promise<void> => {
      const config = getConfig();
      const workspaces = [...(config.ui?.workspaces ?? [])];

      // Update lastActiveAt on the target workspace
      if (args.id) {
        const idx = workspaces.findIndex((w) => w.id === args.id);
        if (idx !== -1) {
          workspaces[idx] = { ...workspaces[idx], lastActiveAt: Date.now() };
          setConfig('ui.workspaces', workspaces);
        }
      }

      setConfig('ui.activeWorkspaceId', args.id);
    },
  );

  // ── Save Last Active Conversation for a Workspace ──────────────────────

  ipcMain.handle(
    'workspaces:save-last-conversation',
    async (_event, args: { workspaceId: string; conversationId: string | null }): Promise<void> => {
      const config = getConfig();
      const workspaces = [...(config.ui?.workspaces ?? [])];
      const idx = workspaces.findIndex((w) => w.id === args.workspaceId);
      if (idx === -1) return;

      workspaces[idx] = { ...workspaces[idx], lastActiveConversationId: args.conversationId };
      setConfig('ui.workspaces', workspaces);
    },
  );

  // ── Browse Directory ───────────────────────────────────────────────────

  ipcMain.handle('workspaces:browse-directory', async (): Promise<{ path: string; name: string } | null> => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0], {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select workspace directory',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const dirPath = result.filePaths[0];
    return { path: dirPath, name: basename(dirPath) };
  });
}

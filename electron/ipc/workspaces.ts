import type { IpcMain } from 'electron';
import { dialog, BrowserWindow } from 'electron';
import { stat, realpath } from 'fs/promises';
import { randomUUID } from 'crypto';
import { basename, isAbsolute } from 'path';
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

  ipcMain.handle('workspaces:create', async (_event, args: { name: string; directory: string }): Promise<Workspace> => {
    const { name, directory } = args;

    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) throw new Error('Workspace name is required');
    if (trimmedName.length > 200) throw new Error('Workspace name is too long');
    if (typeof directory !== 'string' || !isAbsolute(directory)) {
      throw new Error('Workspace directory must be an absolute path');
    }

    // Validate the directory exists AND canonicalize it (resolve symlinks/..)
    // so the stored path is stable — and so duplicate detection can't be
    // bypassed by a symlink / trailing-slash / `..` alias of an existing one.
    const dirStat = await stat(directory).catch(() => null);
    if (!dirStat?.isDirectory()) {
      throw new Error(`Directory does not exist: ${directory}`);
    }
    const canonicalDir = await realpath(directory).catch(() => null);
    if (!canonicalDir) {
      throw new Error(`Directory could not be resolved: ${directory}`);
    }

    const config = getConfig();
    const workspaces = config.ui?.workspaces ?? [];

    // Prevent duplicate directory (compare canonical paths on both sides so an
    // alias of an existing workspace's directory is still caught).
    let dup: Workspace | undefined;
    for (const w of workspaces) {
      const wCanon = await realpath(w.directory).catch(() => w.directory);
      if (wCanon === canonicalDir) {
        dup = w;
        break;
      }
    }
    if (dup) {
      throw new Error(`A workspace already exists for this directory: ${dup.name}`);
    }

    const workspace: Workspace = {
      id: randomUUID(),
      name: trimmedName,
      directory: canonicalDir,
      color: nextWorkspaceColor(workspaces),
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
      lastActiveConversationId: null,
    };

    setConfig('ui.workspaces', [...workspaces, workspace]);
    setConfig('ui.activeWorkspaceId', workspace.id);

    return workspace;
  });

  // ── Rename ──────────────────────────────────────────────────────────────

  ipcMain.handle('workspaces:rename', async (_event, args: { id: string; name: string }): Promise<void> => {
    const config = getConfig();
    const workspaces = [...(config.ui?.workspaces ?? [])];
    const idx = workspaces.findIndex((w) => w.id === args.id);
    if (idx === -1) throw new Error(`Workspace not found: ${args.id}`);

    workspaces[idx] = { ...workspaces[idx], name: args.name.trim() };
    setConfig('ui.workspaces', workspaces);
  });

  // ── Delete ──────────────────────────────────────────────────────────────

  ipcMain.handle('workspaces:delete', async (_event, args: { id: string }): Promise<void> => {
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
  });

  // ── Set Active ──────────────────────────────────────────────────────────

  ipcMain.handle('workspaces:set-active', async (_event, args: { id: string | null }): Promise<void> => {
    const config = getConfig();
    const workspaces = [...(config.ui?.workspaces ?? [])];

    // Update lastActiveAt on the target workspace. Reject an unknown non-null
    // id so we never persist a dangling activeWorkspaceId (a stale/bogus id
    // from the renderer would otherwise leave the UI pointing at nothing).
    if (args.id) {
      const idx = workspaces.findIndex((w) => w.id === args.id);
      if (idx === -1) throw new Error(`Workspace not found: ${args.id}`);
      workspaces[idx] = { ...workspaces[idx], lastActiveAt: Date.now() };
      setConfig('ui.workspaces', workspaces);
    }

    setConfig('ui.activeWorkspaceId', args.id);
  });

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
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const opts = {
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
      title: 'Select workspace directory',
    };
    // Use the parent-window overload only when a window exists; passing a
    // null/undefined parent hits the wrong showOpenDialog overload.
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    const dirPath = result.filePaths[0];
    return { path: dirPath, name: basename(dirPath) };
  });
}

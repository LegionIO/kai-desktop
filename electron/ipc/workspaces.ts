import type { IpcMain } from 'electron';
import { dialog, BrowserWindow } from 'electron';
import { stat, realpath } from 'fs/promises';
import { randomUUID } from 'crypto';
import { basename, isAbsolute } from 'path';
import type { AppConfig, Workspace } from '../config/schema.js';
import type { WorkspaceConfigMutation } from './config.js';
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
): { invalidateMutationProvenance: (mutation: WorkspaceConfigMutation) => void } {
  const normalizeMutationToken = (mutationToken: unknown): string | null =>
    typeof mutationToken === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(mutationToken) ? mutationToken : null;
  let activeWorkspaceMutationToken: string | null = null;
  let mutationTokenWorkspaceId = getConfig().ui?.activeWorkspaceId ?? null;
  // Process-local monotonic selection revision. The workspace id alone cannot
  // detect A -> B -> A while an asynchronous Browser-attention lookup is in
  // flight, so every authoritative selection mutation advances this counter.
  let activeWorkspaceRevision = 0;
  let internalActiveWorkspaceMutationDepth = 0;
  const advanceActiveWorkspaceRevision = (): number => {
    activeWorkspaceRevision += 1;
    return activeWorkspaceRevision;
  };
  const recordActiveWorkspaceMutation = (workspaceId: string | null, mutationToken?: string): void => {
    mutationTokenWorkspaceId = workspaceId;
    activeWorkspaceMutationToken = normalizeMutationToken(mutationToken);
    advanceActiveWorkspaceRevision();
  };
  const setActiveWorkspaceConfig = (workspaceId: string | null, mutationToken?: string): void => {
    internalActiveWorkspaceMutationDepth += 1;
    try {
      setConfig('ui.activeWorkspaceId', workspaceId);
    } finally {
      internalActiveWorkspaceMutationDepth -= 1;
    }
    recordActiveWorkspaceMutation(workspaceId, mutationToken);
  };
  const activeWorkspaceState = () => {
    const config = getConfig();
    const activeWorkspaceId = config.ui?.activeWorkspaceId ?? null;
    if (mutationTokenWorkspaceId !== activeWorkspaceId) {
      mutationTokenWorkspaceId = activeWorkspaceId;
      activeWorkspaceMutationToken = null;
      advanceActiveWorkspaceRevision();
    }
    return {
      activeWorkspaceId,
      activeWorkspaceRevision,
      activeWorkspaceLastConversationId:
        config.ui?.workspaces?.find((workspace) => workspace.id === activeWorkspaceId)?.lastActiveConversationId ??
        null,
      activeWorkspaceMutationToken,
    };
  };
  const lastConversationMutations = new Map<string, { conversationId: string | null; mutationToken: string | null }>();
  const getLastConversationMutationToken = (workspaceId: string, conversationId: string | null): string | null => {
    const mutation = lastConversationMutations.get(workspaceId);
    if (!mutation || mutation.conversationId !== conversationId) {
      lastConversationMutations.delete(workspaceId);
      return null;
    }
    return mutation.mutationToken;
  };
  const recordLastConversationMutation = (
    workspaceId: string,
    conversationId: string | null,
    mutationToken?: string,
  ): string | null => {
    const normalized = normalizeMutationToken(mutationToken);
    lastConversationMutations.set(workspaceId, { conversationId, mutationToken: normalized });
    return normalized;
  };
  const invalidateMutationProvenance = (mutation: WorkspaceConfigMutation): void => {
    if (mutation.activeWorkspaceChanged) {
      mutationTokenWorkspaceId = getConfig().ui?.activeWorkspaceId ?? null;
      activeWorkspaceMutationToken = null;
      if (internalActiveWorkspaceMutationDepth === 0) advanceActiveWorkspaceRevision();
    }
    if (mutation.lastConversationStateChanged) lastConversationMutations.clear();
  };

  // ── Create ──────────────────────────────────────────────────────────────

  ipcMain.handle(
    'workspaces:create',
    async (_event, args: { name: string; directory: string; mutationToken?: string }): Promise<Workspace> => {
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
      setActiveWorkspaceConfig(workspace.id, args.mutationToken);

      return workspace;
    },
  );

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

  ipcMain.handle('workspaces:delete', async (_event, args: { id: string; mutationToken?: string }): Promise<void> => {
    const config = getConfig();
    const workspaces = (config.ui?.workspaces ?? []).filter((w) => w.id !== args.id);
    setConfig('ui.workspaces', workspaces);
    lastConversationMutations.delete(args.id);

    // If the deleted workspace was active, fall back to most-recent or null
    if (config.ui?.activeWorkspaceId === args.id) {
      if (workspaces.length > 0) {
        const sorted = [...workspaces].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
        setActiveWorkspaceConfig(sorted[0].id, args.mutationToken);
      } else {
        setActiveWorkspaceConfig(null, args.mutationToken);
      }
    }
  });

  // ── Set Active ──────────────────────────────────────────────────────────

  ipcMain.handle('workspaces:get-active-state', async () => activeWorkspaceState());

  ipcMain.handle(
    'workspaces:set-active',
    async (
      _event,
      args: {
        id: string | null;
        expectedCurrentId?: string | null;
        expectedCurrentRevision?: number;
        expectedCurrentMutationToken?: string | null;
        mutationToken?: string;
      },
    ): Promise<{
      ok: boolean;
      error?: 'active-workspace-changed';
      activeWorkspaceId?: string | null;
      activeWorkspaceLastConversationId?: string | null;
      activeWorkspaceRevision: number;
      activeWorkspaceMutationToken?: string | null;
    }> => {
      const config = getConfig();
      const workspaces = [...(config.ui?.workspaces ?? [])];
      const current = activeWorkspaceState();
      const { activeWorkspaceId } = current;

      if (
        (args.expectedCurrentId !== undefined && args.expectedCurrentId !== activeWorkspaceId) ||
        (args.expectedCurrentRevision !== undefined && args.expectedCurrentRevision !== activeWorkspaceRevision) ||
        (args.expectedCurrentMutationToken !== undefined &&
          args.expectedCurrentMutationToken !== activeWorkspaceMutationToken)
      ) {
        const activeWorkspaceLastConversationId =
          workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.lastActiveConversationId ?? null;
        return {
          ok: false,
          error: 'active-workspace-changed',
          activeWorkspaceId,
          activeWorkspaceLastConversationId,
          activeWorkspaceRevision,
          ...(args.expectedCurrentMutationToken !== undefined || activeWorkspaceMutationToken
            ? { activeWorkspaceMutationToken }
            : {}),
        };
      }

      // Update lastActiveAt on the target workspace. Reject an unknown non-null
      // id so we never persist a dangling activeWorkspaceId (a stale/bogus id
      // from the renderer would otherwise leave the UI pointing at nothing).
      if (args.id) {
        const idx = workspaces.findIndex((w) => w.id === args.id);
        if (idx === -1) throw new Error(`Workspace not found: ${args.id}`);
        workspaces[idx] = { ...workspaces[idx], lastActiveAt: Date.now() };
        setConfig('ui.workspaces', workspaces);
      }

      setActiveWorkspaceConfig(args.id, args.mutationToken);
      return {
        ok: true,
        activeWorkspaceId: args.id,
        activeWorkspaceRevision,
        ...(activeWorkspaceMutationToken ? { activeWorkspaceMutationToken } : {}),
      };
    },
  );

  // ── Save Last Active Conversation for a Workspace ──────────────────────

  ipcMain.handle(
    'workspaces:save-last-conversation',
    async (
      _event,
      args: {
        workspaceId: string;
        conversationId: string | null;
        expectedCurrentConversationId?: string | null;
        expectedCurrentMutationToken?: string | null;
        mutationToken?: string;
      },
    ): Promise<{
      ok: boolean;
      error?: 'workspace-not-found' | 'last-conversation-changed';
      previousConversationId?: string | null;
      lastActiveConversationId?: string | null;
      lastActiveConversationMutationToken?: string | null;
    }> => {
      const config = getConfig();
      const workspaces = [...(config.ui?.workspaces ?? [])];
      const idx = workspaces.findIndex((w) => w.id === args.workspaceId);
      if (idx === -1) return { ok: false, error: 'workspace-not-found' };

      const previousConversationId = workspaces[idx].lastActiveConversationId ?? null;
      const previousMutationToken = getLastConversationMutationToken(args.workspaceId, previousConversationId);
      if (
        (args.expectedCurrentConversationId !== undefined &&
          args.expectedCurrentConversationId !== previousConversationId) ||
        (args.expectedCurrentMutationToken !== undefined && args.expectedCurrentMutationToken !== previousMutationToken)
      ) {
        return {
          ok: false,
          error: 'last-conversation-changed',
          lastActiveConversationId: previousConversationId,
          ...(previousMutationToken ? { lastActiveConversationMutationToken: previousMutationToken } : {}),
        };
      }

      workspaces[idx] = { ...workspaces[idx], lastActiveConversationId: args.conversationId };
      setConfig('ui.workspaces', workspaces);
      const mutationToken = recordLastConversationMutation(args.workspaceId, args.conversationId, args.mutationToken);
      return {
        ok: true,
        previousConversationId,
        lastActiveConversationId: args.conversationId,
        ...(mutationToken ? { lastActiveConversationMutationToken: mutationToken } : {}),
      };
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

  return { invalidateMutationProvenance };
}

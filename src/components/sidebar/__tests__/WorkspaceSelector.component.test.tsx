import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { WorkspaceSelector } from '../WorkspaceSelector';

afterEach(() => uninstallAppBridgeStub());

const workspaceState = (
  activeWorkspaceId: string | null = 'workspace-a',
  activeWorkspaceRevision = 0,
  activeWorkspaceMutationToken: string | null = null,
) => ({
  activeWorkspaceId,
  activeWorkspaceRevision,
  activeWorkspaceLastConversationId: null,
  activeWorkspaceMutationToken,
});

const installWorkspaceBridge = (
  setActive: unknown,
  getActiveState: () => Promise<ReturnType<typeof workspaceState>> = async () => workspaceState(),
) => installAppBridgeStub({ workspaces: { setActive, getActiveState } });

describe('WorkspaceSelector', () => {
  it('lets the empty-workspace title-bar control shrink and truncate cleanly', () => {
    render(
      <WorkspaceSelector
        workspaces={[]}
        activeWorkspaceId={null}
        activeWorkspace={null}
        onWorkspaceNavigationIntent={() => 1}
        isWorkspaceNavigationIntentCurrent={() => true}
        createLocalWorkspaceMutationToken={() => 'local-user_request-empty'}
        isLocalWorkspaceMutationToken={() => false}
        onWorkspaceNavigationFailure={() => undefined}
      />,
    );

    const trigger = screen.getByRole('button', { name: /open a workspace/i });
    expect(trigger).toHaveClass('min-w-0', 'max-w-full');
    expect(trigger.querySelector('span')).toHaveClass('truncate');
  });

  it('does not cancel restoration when the active workspace is selected again', async () => {
    const user = userEvent.setup();
    const setActive = vi.fn(async () => ({ ok: true, activeWorkspaceId: 'workspace-a' }));
    installWorkspaceBridge(setActive);
    const onWorkspaceNavigationIntent = vi.fn(() => 7);
    const workspace = {
      id: 'workspace-a',
      name: 'Workspace A',
      directory: '/work/a',
      color: '#123456',
      lastActiveAt: 2,
      createdAt: 1,
      lastActiveConversationId: 'chat-a',
    };

    render(
      <WorkspaceSelector
        workspaces={[workspace]}
        activeWorkspaceId={workspace.id}
        activeWorkspace={workspace}
        onWorkspaceNavigationIntent={onWorkspaceNavigationIntent}
        isWorkspaceNavigationIntentCurrent={() => true}
        createLocalWorkspaceMutationToken={() => 'local-user_request-same'}
        isLocalWorkspaceMutationToken={() => false}
        onWorkspaceNavigationFailure={() => undefined}
      />,
    );

    await user.click(screen.getByRole('button', { name: /workspace a/i }));
    await user.click(await screen.findByRole('menuitem', { name: /workspace a/i }));

    expect(onWorkspaceNavigationIntent).not.toHaveBeenCalled();
    expect(setActive).not.toHaveBeenCalled();
  });

  it('requests restoration retry when a workspace selection loses its CAS', async () => {
    const user = userEvent.setup();
    const setActive = vi.fn(async () => ({
      ok: false,
      error: 'active-workspace-changed' as const,
      activeWorkspaceId: 'workspace-a',
      activeWorkspaceRevision: 1,
    }));
    installWorkspaceBridge(setActive);
    const onWorkspaceNavigationIntent = vi.fn(() => 11);
    const onWorkspaceNavigationFailure = vi.fn();
    const workspaceA = {
      id: 'workspace-a',
      name: 'Workspace A',
      directory: '/work/a',
      color: '#123456',
      lastActiveAt: 2,
      createdAt: 1,
      lastActiveConversationId: 'chat-a',
    };
    const workspaceB = {
      ...workspaceA,
      id: 'workspace-b',
      name: 'Workspace B',
      directory: '/work/b',
      lastActiveAt: 1,
    };

    render(
      <WorkspaceSelector
        workspaces={[workspaceA, workspaceB]}
        activeWorkspaceId={workspaceA.id}
        activeWorkspace={workspaceA}
        onWorkspaceNavigationIntent={onWorkspaceNavigationIntent}
        isWorkspaceNavigationIntentCurrent={() => true}
        createLocalWorkspaceMutationToken={() => 'local-user_request-failed'}
        isLocalWorkspaceMutationToken={() => false}
        onWorkspaceNavigationFailure={onWorkspaceNavigationFailure}
      />,
    );

    await user.click(screen.getByRole('button', { name: /workspace a/i }));
    await user.click(await screen.findByRole('menuitem', { name: /workspace b/i }));

    expect(onWorkspaceNavigationIntent).toHaveBeenCalledOnce();
    expect(setActive).toHaveBeenCalledWith({
      id: 'workspace-b',
      expectedCurrentId: 'workspace-a',
      expectedCurrentRevision: 0,
      mutationToken: 'local-user_request-failed',
    });
    expect(onWorkspaceNavigationFailure).toHaveBeenCalledWith('workspace-a', 11);
  });

  it('rebases the newest user selection over an older local Browser mutation', async () => {
    const user = userEvent.setup();
    const setActive = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'active-workspace-changed' as const,
        activeWorkspaceId: 'workspace-browser',
        activeWorkspaceRevision: 1,
        activeWorkspaceMutationToken: 'local-browser_request-1',
      })
      .mockResolvedValueOnce({ ok: true, activeWorkspaceId: 'workspace-b', activeWorkspaceRevision: 2 });
    installWorkspaceBridge(setActive);
    const onWorkspaceNavigationFailure = vi.fn();
    const workspaceA = {
      id: 'workspace-a',
      name: 'Workspace A',
      directory: '/work/a',
      color: '#123456',
      lastActiveAt: 2,
      createdAt: 1,
      lastActiveConversationId: 'chat-a',
    };
    const workspaceB = {
      ...workspaceA,
      id: 'workspace-b',
      name: 'Workspace B',
      directory: '/work/b',
      lastActiveAt: 1,
    };

    render(
      <WorkspaceSelector
        workspaces={[workspaceA, workspaceB]}
        activeWorkspaceId={workspaceA.id}
        activeWorkspace={workspaceA}
        onWorkspaceNavigationIntent={() => 12}
        isWorkspaceNavigationIntentCurrent={() => true}
        createLocalWorkspaceMutationToken={() => 'local-user_request-rebase'}
        isLocalWorkspaceMutationToken={(token) => token?.startsWith('local-') === true}
        onWorkspaceNavigationFailure={onWorkspaceNavigationFailure}
      />,
    );

    await user.click(screen.getByRole('button', { name: /workspace a/i }));
    await user.click(await screen.findByRole('menuitem', { name: /workspace b/i }));

    expect(setActive).toHaveBeenNthCalledWith(1, {
      id: 'workspace-b',
      expectedCurrentId: 'workspace-a',
      expectedCurrentRevision: 0,
      mutationToken: 'local-user_request-rebase',
    });
    expect(setActive).toHaveBeenNthCalledWith(2, {
      id: 'workspace-b',
      expectedCurrentId: 'workspace-browser',
      expectedCurrentRevision: 1,
      expectedCurrentMutationToken: 'local-browser_request-1',
      mutationToken: 'local-user_request-rebase',
    });
    expect(onWorkspaceNavigationFailure).not.toHaveBeenCalled();
  });

  it('protects a rapid newer click from an older selection rollback with workspace revisions', async () => {
    const user = userEvent.setup();
    let navigationGeneration = 0;
    let backendWorkspaceId = 'workspace-a';
    let backendWorkspaceRevision = 0;
    let backendMutationToken: string | null = null;
    let resolveFirstSelection: (result: {
      ok: true;
      activeWorkspaceId: string;
      activeWorkspaceRevision: number;
    }) => void = () => {};
    const setActive = vi.fn(
      async (args: {
        id: string;
        expectedCurrentId: string | null;
        expectedCurrentRevision?: number;
        expectedCurrentMutationToken?: string | null;
        mutationToken?: string;
      }) => {
        if (args.expectedCurrentRevision !== backendWorkspaceRevision) {
          return {
            ok: false,
            error: 'active-workspace-changed' as const,
            activeWorkspaceId: backendWorkspaceId,
            activeWorkspaceRevision: backendWorkspaceRevision,
            activeWorkspaceMutationToken: backendMutationToken,
          };
        }
        if (
          args.expectedCurrentMutationToken !== undefined &&
          args.expectedCurrentMutationToken !== backendMutationToken
        ) {
          return {
            ok: false,
            error: 'active-workspace-changed' as const,
            activeWorkspaceId: backendWorkspaceId,
            activeWorkspaceRevision: backendWorkspaceRevision,
            activeWorkspaceMutationToken: backendMutationToken,
          };
        }
        if (args.id === 'workspace-b') {
          backendWorkspaceId = args.id;
          backendWorkspaceRevision += 1;
          backendMutationToken = args.mutationToken ?? null;
          return new Promise<{ ok: true; activeWorkspaceId: string; activeWorkspaceRevision: number }>((resolve) => {
            resolveFirstSelection = resolve;
          });
        }
        if (args.expectedCurrentId !== backendWorkspaceId) {
          return {
            ok: false,
            error: 'active-workspace-changed' as const,
            activeWorkspaceId: backendWorkspaceId,
            activeWorkspaceRevision: backendWorkspaceRevision,
            activeWorkspaceMutationToken: backendMutationToken,
          };
        }
        backendWorkspaceId = args.id;
        backendWorkspaceRevision += 1;
        backendMutationToken = args.mutationToken ?? null;
        return { ok: true, activeWorkspaceId: backendWorkspaceId, activeWorkspaceRevision: backendWorkspaceRevision };
      },
    );
    installWorkspaceBridge(setActive, async () =>
      workspaceState(backendWorkspaceId, backendWorkspaceRevision, backendMutationToken),
    );
    const onWorkspaceNavigationFailure = vi.fn();
    const workspaceA = {
      id: 'workspace-a',
      name: 'Workspace A',
      directory: '/work/a',
      color: '#123456',
      lastActiveAt: 3,
      createdAt: 1,
      lastActiveConversationId: 'chat-a',
    };
    const workspaceB = {
      ...workspaceA,
      id: 'workspace-b',
      name: 'Workspace B',
      directory: '/work/b',
      lastActiveAt: 2,
    };
    const workspaceC = {
      ...workspaceA,
      id: 'workspace-c',
      name: 'Workspace C',
      directory: '/work/c',
      lastActiveAt: 1,
    };

    render(
      <WorkspaceSelector
        workspaces={[workspaceA, workspaceB, workspaceC]}
        activeWorkspaceId={workspaceA.id}
        activeWorkspace={workspaceA}
        onWorkspaceNavigationIntent={() => ++navigationGeneration}
        isWorkspaceNavigationIntentCurrent={(generation) => generation === navigationGeneration}
        createLocalWorkspaceMutationToken={() => `local-user_request-${navigationGeneration}`}
        isLocalWorkspaceMutationToken={(token) => token?.startsWith('local-user_') === true}
        onWorkspaceNavigationFailure={onWorkspaceNavigationFailure}
      />,
    );

    await user.click(screen.getByRole('button', { name: /workspace a/i }));
    await user.click(await screen.findByRole('menuitem', { name: /workspace b/i }));
    await vi.waitFor(() => expect(setActive).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: /workspace a/i }));
    await user.click(await screen.findByRole('menuitem', { name: /workspace c/i }));
    await vi.waitFor(() => expect(setActive).toHaveBeenCalledTimes(2));
    resolveFirstSelection({ ok: true, activeWorkspaceId: 'workspace-b', activeWorkspaceRevision: 1 });
    await vi.waitFor(() => expect(setActive).toHaveBeenCalledTimes(3));

    expect(setActive).toHaveBeenNthCalledWith(1, {
      id: 'workspace-b',
      expectedCurrentId: 'workspace-a',
      expectedCurrentRevision: 0,
      mutationToken: 'local-user_request-1',
    });
    expect(setActive).toHaveBeenNthCalledWith(2, {
      id: 'workspace-c',
      expectedCurrentId: 'workspace-b',
      expectedCurrentRevision: 1,
      mutationToken: 'local-user_request-2',
    });
    expect(setActive).toHaveBeenNthCalledWith(3, {
      id: 'workspace-a',
      expectedCurrentId: 'workspace-b',
      expectedCurrentRevision: 1,
      expectedCurrentMutationToken: 'local-user_request-1',
      mutationToken: 'local-user_request-1',
    });
    expect(onWorkspaceNavigationFailure).not.toHaveBeenCalled();
  });

  it('stops rebasing when a newer user intent supersedes the selection', async () => {
    const user = userEvent.setup();
    const setActive = vi.fn(async () => ({
      ok: false,
      error: 'active-workspace-changed' as const,
      activeWorkspaceId: 'workspace-browser',
      activeWorkspaceRevision: 1,
      activeWorkspaceMutationToken: 'local-browser_request-1',
    }));
    installWorkspaceBridge(setActive);
    const isWorkspaceNavigationIntentCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const workspaceA = {
      id: 'workspace-a',
      name: 'Workspace A',
      directory: '/work/a',
      color: '#123456',
      lastActiveAt: 2,
      createdAt: 1,
      lastActiveConversationId: 'chat-a',
    };
    const workspaceB = {
      ...workspaceA,
      id: 'workspace-b',
      name: 'Workspace B',
      directory: '/work/b',
      lastActiveAt: 1,
    };

    render(
      <WorkspaceSelector
        workspaces={[workspaceA, workspaceB]}
        activeWorkspaceId={workspaceA.id}
        activeWorkspace={workspaceA}
        onWorkspaceNavigationIntent={() => 13}
        isWorkspaceNavigationIntentCurrent={isWorkspaceNavigationIntentCurrent}
        createLocalWorkspaceMutationToken={() => 'local-user_request-superseded'}
        isLocalWorkspaceMutationToken={(token) => token?.startsWith('local-') === true}
        onWorkspaceNavigationFailure={() => undefined}
      />,
    );

    await user.click(screen.getByRole('button', { name: /workspace a/i }));
    await user.click(await screen.findByRole('menuitem', { name: /workspace b/i }));

    expect(setActive).toHaveBeenCalledOnce();
  });

  it('does not restore or overwrite the workspace after another window wins the selection CAS', async () => {
    const user = userEvent.setup();
    const setActive = vi.fn(async () => ({
      ok: false,
      error: 'active-workspace-changed' as const,
      activeWorkspaceId: 'workspace-c',
      activeWorkspaceRevision: 1,
      activeWorkspaceMutationToken: 'foreign-renderer_request-1',
    }));
    installWorkspaceBridge(setActive);
    const onWorkspaceNavigationFailure = vi.fn();
    const workspaceA = {
      id: 'workspace-a',
      name: 'Workspace A',
      directory: '/work/a',
      color: '#123456',
      lastActiveAt: 2,
      createdAt: 1,
      lastActiveConversationId: 'chat-a',
    };
    const workspaceB = {
      ...workspaceA,
      id: 'workspace-b',
      name: 'Workspace B',
      directory: '/work/b',
      lastActiveAt: 1,
    };

    render(
      <WorkspaceSelector
        workspaces={[workspaceA, workspaceB]}
        activeWorkspaceId={workspaceA.id}
        activeWorkspace={workspaceA}
        onWorkspaceNavigationIntent={() => 14}
        isWorkspaceNavigationIntentCurrent={() => true}
        createLocalWorkspaceMutationToken={() => 'local-user_request-foreign'}
        isLocalWorkspaceMutationToken={(token) => token?.startsWith('local-') === true}
        onWorkspaceNavigationFailure={onWorkspaceNavigationFailure}
      />,
    );

    await user.click(screen.getByRole('button', { name: /workspace a/i }));
    await user.click(await screen.findByRole('menuitem', { name: /workspace b/i }));

    expect(setActive).toHaveBeenCalledOnce();
    expect(onWorkspaceNavigationFailure).not.toHaveBeenCalled();
  });
});

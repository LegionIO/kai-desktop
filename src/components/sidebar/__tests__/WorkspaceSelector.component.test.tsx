import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { WorkspaceSelector } from '../WorkspaceSelector';

afterEach(() => uninstallAppBridgeStub());

describe('WorkspaceSelector', () => {
  it('lets the empty-workspace title-bar control shrink and truncate cleanly', () => {
    render(
      <WorkspaceSelector
        workspaces={[]}
        activeWorkspaceId={null}
        activeWorkspace={null}
        onWorkspaceNavigationIntent={() => 1}
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
    installAppBridgeStub({ workspaces: { setActive } });
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
    }));
    installAppBridgeStub({ workspaces: { setActive } });
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
        onWorkspaceNavigationFailure={onWorkspaceNavigationFailure}
      />,
    );

    await user.click(screen.getByRole('button', { name: /workspace a/i }));
    await user.click(await screen.findByRole('menuitem', { name: /workspace b/i }));

    expect(onWorkspaceNavigationIntent).toHaveBeenCalledOnce();
    expect(setActive).toHaveBeenCalledWith({ id: 'workspace-b', expectedCurrentId: 'workspace-a' });
    expect(onWorkspaceNavigationFailure).toHaveBeenCalledWith('workspace-a', 11);
  });

  it('does not restore the old workspace after another window wins the selection CAS', async () => {
    const user = userEvent.setup();
    const setActive = vi.fn(async () => ({
      ok: false,
      error: 'active-workspace-changed' as const,
      activeWorkspaceId: 'workspace-c',
    }));
    installAppBridgeStub({ workspaces: { setActive } });
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
        onWorkspaceNavigationFailure={onWorkspaceNavigationFailure}
      />,
    );

    await user.click(screen.getByRole('button', { name: /workspace a/i }));
    await user.click(await screen.findByRole('menuitem', { name: /workspace b/i }));

    expect(onWorkspaceNavigationFailure).not.toHaveBeenCalled();
  });
});

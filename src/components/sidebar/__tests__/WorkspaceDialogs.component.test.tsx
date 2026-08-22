import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { CreateWorkspaceDialog } from '../CreateWorkspaceDialog';
import { DeleteWorkspaceDialog } from '../DeleteWorkspaceDialog';

afterEach(() => uninstallAppBridgeStub());

const workspace = {
  id: 'workspace-b',
  name: 'Workspace B',
  directory: '/work/b',
  color: '#123456',
  lastActiveAt: 2,
  createdAt: 1,
  lastActiveConversationId: 'chat-b',
};

describe('workspace mutation dialogs', () => {
  it('requests restoration retry when workspace creation fails', async () => {
    const user = userEvent.setup();
    const create = vi.fn(async () => {
      throw new Error('Create failed');
    });
    installAppBridgeStub({
      workspaces: {
        browseDirectory: async () => ({ path: '/work/new', name: 'New workspace' }),
        create,
      },
    });
    const onWorkspaceNavigationIntent = vi.fn(() => 13);
    const onWorkspaceNavigationFailure = vi.fn();

    render(
      <CreateWorkspaceDialog
        open
        onOpenChange={() => undefined}
        onWorkspaceNavigationIntent={onWorkspaceNavigationIntent}
        onWorkspaceNavigationFailure={onWorkspaceNavigationFailure}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Browse…' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(create).toHaveBeenCalledWith({ name: 'New workspace', directory: '/work/new' });
    expect(onWorkspaceNavigationIntent).toHaveBeenCalledOnce();
    expect(onWorkspaceNavigationFailure).toHaveBeenCalledWith(13);
    expect(await screen.findByText('Create failed')).toBeInTheDocument();
  });

  it('does not invalidate active-workspace restoration when deleting an inactive workspace', async () => {
    const user = userEvent.setup();
    const deleteWorkspace = vi.fn(async () => undefined);
    installAppBridgeStub({ workspaces: { delete: deleteWorkspace } });
    const onWorkspaceNavigationIntent = vi.fn(() => 17);
    const onWorkspaceNavigationFailure = vi.fn();

    render(
      <DeleteWorkspaceDialog
        workspace={workspace}
        activeWorkspaceId="workspace-a"
        open
        onOpenChange={() => undefined}
        onWorkspaceNavigationIntent={onWorkspaceNavigationIntent}
        onWorkspaceNavigationFailure={onWorkspaceNavigationFailure}
      />,
    );

    await user.type(screen.getByPlaceholderText('Workspace B'), 'Workspace B');
    await user.click(screen.getByRole('button', { name: 'Delete Workspace' }));

    expect(deleteWorkspace).toHaveBeenCalledWith({ id: 'workspace-b' });
    expect(onWorkspaceNavigationIntent).not.toHaveBeenCalled();
    expect(onWorkspaceNavigationFailure).not.toHaveBeenCalled();
  });

  it('requests restoration retry when deleting the active workspace fails', async () => {
    const user = userEvent.setup();
    const deleteWorkspace = vi.fn(async () => {
      throw new Error('Delete failed');
    });
    installAppBridgeStub({ workspaces: { delete: deleteWorkspace } });
    const onWorkspaceNavigationIntent = vi.fn(() => 19);
    const onWorkspaceNavigationFailure = vi.fn();

    render(
      <DeleteWorkspaceDialog
        workspace={workspace}
        activeWorkspaceId={workspace.id}
        open
        onOpenChange={() => undefined}
        onWorkspaceNavigationIntent={onWorkspaceNavigationIntent}
        onWorkspaceNavigationFailure={onWorkspaceNavigationFailure}
      />,
    );

    await user.type(screen.getByPlaceholderText('Workspace B'), 'Workspace B');
    await user.click(screen.getByRole('button', { name: 'Delete Workspace' }));

    expect(onWorkspaceNavigationIntent).toHaveBeenCalledOnce();
    expect(onWorkspaceNavigationFailure).toHaveBeenCalledWith(19);
    expect(await screen.findByText('Delete failed')).toBeInTheDocument();
  });
});

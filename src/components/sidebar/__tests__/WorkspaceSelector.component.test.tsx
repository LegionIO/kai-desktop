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
        onWorkspaceNavigationIntent={() => undefined}
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
    const onWorkspaceNavigationIntent = vi.fn();
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
      />,
    );

    await user.click(screen.getByRole('button', { name: /workspace a/i }));
    await user.click(await screen.findByRole('menuitem', { name: /workspace a/i }));

    expect(onWorkspaceNavigationIntent).not.toHaveBeenCalled();
    expect(setActive).not.toHaveBeenCalled();
  });
});

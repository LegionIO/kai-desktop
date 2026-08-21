import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkspaceSelector } from '../WorkspaceSelector';

describe('WorkspaceSelector', () => {
  it('lets the empty-workspace title-bar control shrink and truncate cleanly', () => {
    render(<WorkspaceSelector workspaces={[]} activeWorkspaceId={null} activeWorkspace={null} />);

    const trigger = screen.getByRole('button', { name: /open a workspace/i });
    expect(trigger).toHaveClass('min-w-0', 'max-w-full');
    expect(trigger.querySelector('span')).toHaveClass('truncate');
  });
});

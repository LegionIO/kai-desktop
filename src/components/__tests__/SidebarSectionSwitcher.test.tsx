/**
 * Component test — `SidebarSectionSwitcher`.
 *
 * The Radix-Tabs wrapper has two distinct callback paths:
 *   1. `onValueChange`  — fired when the active section changes
 *   2. `on*Reselect`    — fired when the user clicks the already-active tab
 *
 * Both code paths matter for the sidebar's "click the active tab to scroll
 * to top" UX, so we lock them down explicitly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../../test-utils/render';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../test-utils/app-bridge-stub';
import { SidebarSectionSwitcher } from '../SidebarSectionSwitcher';

describe('SidebarSectionSwitcher', () => {
  beforeEach(() => {
    installAppBridgeStub();
  });

  afterEach(() => {
    uninstallAppBridgeStub();
  });

  it('renders three tabs with the brand labels for threads, tasks, and plugins', () => {
    renderWithProviders(
      <SidebarSectionSwitcher value="threads" onValueChange={() => undefined} />,
    );

    expect(screen.getByRole('tab', { name: 'Chats' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Plugins' })).toBeInTheDocument();
  });

  it('marks the active tab via aria-selected', () => {
    renderWithProviders(
      <SidebarSectionSwitcher value="tasks" onValueChange={() => undefined} />,
    );

    expect(screen.getByRole('tab', { name: 'Tasks' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Chats' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Plugins' })).toHaveAttribute('aria-selected', 'false');
  });

  it('calls onValueChange with the new section when an inactive tab is activated', () => {
    const onValueChange = vi.fn();
    renderWithProviders(
      <SidebarSectionSwitcher value="threads" onValueChange={onValueChange} />,
    );

    // Radix Tabs triggers fire onValueChange on mouseDown (not click).
    act(() => {
      fireEvent.mouseDown(screen.getByRole('tab', { name: 'Tasks' }));
    });

    expect(onValueChange).toHaveBeenCalledWith('tasks');
  });

  it('does NOT call onValueChange when the active tab is clicked again', () => {
    const onValueChange = vi.fn();
    const onThreadsReselect = vi.fn();
    renderWithProviders(
      <SidebarSectionSwitcher
        value="threads"
        onValueChange={onValueChange}
        onThreadsReselect={onThreadsReselect}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Chats' }));

    // Reselect callback fires; section-change callback must not.
    expect(onThreadsReselect).toHaveBeenCalledTimes(1);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('routes reselect callbacks to the right handler per tab', () => {
    const onThreadsReselect = vi.fn();
    const onTasksReselect = vi.fn();
    const onExtensionsReselect = vi.fn();
    renderWithProviders(
      <SidebarSectionSwitcher
        value="tasks"
        onValueChange={() => undefined}
        onThreadsReselect={onThreadsReselect}
        onTasksReselect={onTasksReselect}
        onExtensionsReselect={onExtensionsReselect}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Tasks' }));

    expect(onTasksReselect).toHaveBeenCalledTimes(1);
    expect(onThreadsReselect).not.toHaveBeenCalled();
    expect(onExtensionsReselect).not.toHaveBeenCalled();
  });
});

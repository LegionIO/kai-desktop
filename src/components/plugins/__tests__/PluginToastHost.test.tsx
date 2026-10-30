import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginNotificationDescriptor } from '@/providers/PluginProvider';
import { PluginToastHost } from '../PluginToastHost';

const plugin = vi.hoisted(() => ({
  uiState: { notifications: [] as PluginNotificationDescriptor[] },
  injectNavigationRequest: vi.fn(),
}));
vi.mock('@/providers/PluginProvider', () => ({ usePlugins: () => plugin }));

const POSITION_KEY = 'kai.plugin-toast-position';
let resizeStack: () => void;
let stackHeight: number;
let stackWidth: number;

function notification(overrides: Partial<PluginNotificationDescriptor> = {}): PluginNotificationDescriptor {
  return {
    id: 'sync',
    pluginName: 'pim',
    title: 'AWS Sync',
    body: 'Waiting for approval',
    visible: true,
    target: { type: 'action', targetId: 'pim', action: 'aws-sync-show' },
    ...overrides,
  };
}

function handle(name = 'Open notification: AWS Sync') {
  const button = screen.getByRole('button', { name });
  button.setPointerCapture = vi.fn();
  button.hasPointerCapture = vi.fn(() => true);
  button.releasePointerCapture = vi.fn();
  return button;
}

// jsdom has no PointerEvent constructor; preserve mouse coordinates and pointer identity.
function pointer(target: HTMLElement, type: string, x: number, y: number, id = 1, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button });
  Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: true } });
  fireEvent(target, event);
}

beforeEach(() => {
  window.localStorage.clear();
  plugin.uiState.notifications = [notification()];
  plugin.injectNavigationRequest.mockReset();
  stackHeight = 180;
  stackWidth = 384;
  vi.stubGlobal('innerWidth', 1000);
  vi.stubGlobal('innerHeight', 800);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, stackWidth, stackHeight),
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeStack = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PluginToastHost positioning', () => {
  it('moves the stack without navigating or dismissing, including during progress updates', () => {
    const view = render(<PluginToastHost />);
    const grip = handle();
    expect(screen.queryByRole('button', { name: 'Move notifications' })).toBeNull();
    pointer(grip, 'pointerdown', 950, 600);
    pointer(grip, 'pointermove', 750, 500);
    expect(screen.getByRole('region')).toHaveStyle({ right: '216px', bottom: '116px' });
    expect(grip.setPointerCapture).toHaveBeenCalledWith(1);

    plugin.uiState.notifications = [notification({ body: 'Syncing credentials' })];
    view.rerender(<PluginToastHost />);
    pointer(grip, 'pointermove', 700, 450);
    pointer(grip, 'pointerup', 700, 450);
    fireEvent.click(grip, { detail: 1 }); // A browser emits a click after pointerup.
    expect(grip.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(screen.getByRole('region')).toHaveStyle({ right: '266px', bottom: '166px' });
    expect(screen.getByText('Syncing credentials')).toBeInTheDocument();
    expect(plugin.injectNavigationRequest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('AWS Sync'));
    expect(plugin.injectNavigationRequest).toHaveBeenCalledWith('pim', notification().target);
    expect(screen.getByText('AWS Sync')).toBeInTheDocument();
  });

  it('preserves one-shot dismissal when the toast body is clicked', () => {
    plugin.uiState.notifications = [notification({ autoDismissMs: 6000 })];
    render(<PluginToastHost />);
    fireEvent.click(screen.getByText('AWS Sync'));
    expect(plugin.injectNavigationRequest).toHaveBeenCalledOnce();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('distinguishes dragging a one-shot toast from a click with slight pointer jitter', () => {
    plugin.uiState.notifications = [notification({ autoDismissMs: 6000 })];
    render(<PluginToastHost />);
    const grip = handle();
    pointer(grip, 'pointerdown', 900, 700);
    pointer(grip, 'pointermove', 800, 600);
    pointer(grip, 'pointerup', 800, 600);
    fireEvent.click(grip, { detail: 1 });
    expect(plugin.injectNavigationRequest).not.toHaveBeenCalled();
    expect(screen.getByText('AWS Sync')).toBeInTheDocument();

    pointer(grip, 'pointerdown', 800, 600);
    pointer(grip, 'pointermove', 801, 601);
    pointer(grip, 'pointerup', 801, 601);
    expect(screen.getByRole('region')).toHaveStyle({ right: '116px', bottom: '116px' });
    fireEvent.click(grip, { detail: 1 });
    expect(plugin.injectNavigationRequest).toHaveBeenCalledOnce();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('keeps reset and minimize inside the toast without dragging, navigating, or dismissing', () => {
    plugin.uiState.notifications = [notification({ autoDismissMs: 6000 })];
    render(<PluginToastHost />);
    fireEvent.keyDown(handle(), { key: 'ArrowLeft', shiftKey: true });
    const toast = within(screen.getByRole('group', { name: 'AWS Sync' }));
    const reset = toast.getByRole('button', { name: 'Reset notification position' });
    pointer(reset, 'pointerdown', 900, 700);
    pointer(reset, 'pointermove', 800, 600);
    pointer(reset, 'pointerup', 800, 600);
    expect(screen.getByRole('region')).toHaveStyle({ right: '56px', bottom: '16px' });
    fireEvent.click(reset, { detail: 1 });
    expect(screen.getByRole('region')).toHaveStyle({ right: '16px', bottom: '16px' });
    fireEvent.click(toast.getByRole('button', { name: 'Minimize notifications' }));
    expect(screen.getByRole('button', { name: 'Expand notifications (1)' })).toHaveFocus();
    expect(plugin.injectNavigationRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Expand notifications (1)' }));
    expect(handle()).toHaveFocus();
    expect(screen.getByText('AWS Sync')).toBeInTheDocument();
  });

  it('keeps a draggable bubble at the selected position and expands only on a click', () => {
    render(<PluginToastHost />);
    fireEvent.keyDown(handle(), { key: 'ArrowLeft', shiftKey: true });
    stackHeight = stackWidth = 44;
    fireEvent.click(screen.getByRole('button', { name: 'Minimize notifications' }));
    expect(screen.queryByText('AWS Sync')).toBeNull();
    expect(screen.getByRole('region')).toHaveStyle({ right: '56px', bottom: '16px' });
    const bubble = handle('Expand notifications (1)');
    pointer(bubble, 'pointerdown', 900, 700);
    pointer(bubble, 'pointermove', 700, 600);
    pointer(bubble, 'pointerup', 700, 600);
    fireEvent.click(bubble, { detail: 1 });
    expect(screen.getByRole('button', { name: 'Expand notifications (1)' })).toBe(bubble);
    expect(screen.getByRole('region')).toHaveStyle({ right: '256px', bottom: '116px' });
    expect(JSON.parse(window.localStorage.getItem(POSITION_KEY)!)).toEqual({ right: 256, bottom: 116 });
    expect(plugin.injectNavigationRequest).not.toHaveBeenCalled();

    stackWidth = 384;
    stackHeight = 180;
    pointer(bubble, 'pointerdown', 700, 600);
    pointer(bubble, 'pointerup', 700, 600);
    fireEvent.click(bubble, { detail: 1 });
    expect(screen.getByText('AWS Sync')).toBeInTheDocument();
    expect(screen.getByRole('region')).toHaveStyle({ right: '256px', bottom: '116px' });
  });

  it('updates the minimized count and content, and shows a new stack after all notifications expire', () => {
    const view = render(<PluginToastHost />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize notifications' }));
    plugin.uiState.notifications = [
      notification({ body: 'Syncing credentials' }),
      notification({ id: 'done', title: 'Azure Sync', level: 'success' }),
      notification({ id: 'hidden', visible: false }),
    ];
    view.rerender(<PluginToastHost />);
    const bubble = screen.getByRole('button', { name: 'Expand notifications (2)' });
    expect(within(bubble).getByText('2')).toBeInTheDocument();
    expect(screen.queryByText('Azure Sync')).toBeNull();
    fireEvent.click(bubble);
    expect(screen.getByText('Syncing credentials')).toBeInTheDocument();
    expect(screen.getByText('Azure Sync')).toBeInTheDocument();
    expect(handle('Open notification: Azure Sync')).toHaveFocus();
    fireEvent.click(screen.getAllByRole('button', { name: 'Minimize notifications' })[0]);

    plugin.uiState.notifications = [notification()];
    view.rerender(<PluginToastHost />);
    expect(screen.getByRole('button', { name: 'Expand notifications (1)' })).toBeInTheDocument();
    plugin.uiState.notifications = [];
    view.rerender(<PluginToastHost />);
    expect(screen.queryByRole('region')).toBeNull();
    plugin.uiState.notifications = [notification({ id: 'new', title: 'New sync' })];
    view.rerender(<PluginToastHost />);
    expect(screen.getByText('New sync')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Expand notifications/ })).toBeNull();
  });

  it('keeps the bubble and expanded stack reachable after dragging to the edge or resizing', () => {
    render(<PluginToastHost />);
    stackHeight = stackWidth = 44;
    fireEvent.click(screen.getByRole('button', { name: 'Minimize notifications' }));
    const bubble = handle('Expand notifications (1)');
    pointer(bubble, 'pointerdown', 900, 700);
    pointer(bubble, 'pointermove', -1000, -1000);
    pointer(bubble, 'pointerup', -1000, -1000);
    fireEvent.click(bubble, { detail: 1 });
    expect(screen.getByRole('region')).toHaveStyle({ right: '940px', bottom: '740px' });
    vi.stubGlobal('innerWidth', 600);
    vi.stubGlobal('innerHeight', 400);
    fireEvent(window, new Event('resize'));
    expect(screen.getByRole('region')).toHaveStyle({ right: '540px', bottom: '340px' });
    fireEvent.keyDown(bubble, { key: 'ArrowRight', shiftKey: true });
    expect(screen.getByRole('region')).toHaveStyle({ right: '500px', bottom: '340px' });

    stackWidth = 384;
    stackHeight = 180;
    fireEvent.click(bubble);
    expect(screen.getByRole('region')).toHaveStyle({ right: '200px', bottom: '204px' });
    stackHeight = stackWidth = 44;
    fireEvent.click(screen.getByRole('button', { name: 'Minimize notifications' }));
    fireEvent.keyDown(handle('Expand notifications (1)'), { key: 'Home' });
    expect(screen.getByRole('region')).toHaveStyle({ right: '16px', bottom: '16px' });
  });

  it('keeps the selected position across empty stacks and remounts and supports keyboard/reset', () => {
    const view = render(<PluginToastHost />);
    fireEvent.keyDown(handle(), { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    expect(screen.getByRole('region')).toHaveStyle({ right: '56px', bottom: '26px' });
    plugin.uiState.notifications = [];
    view.rerender(<PluginToastHost />);
    expect(screen.queryByRole('region')).toBeNull();
    plugin.uiState.notifications = [notification()];
    view.rerender(<PluginToastHost />);
    expect(screen.getByRole('region')).toHaveStyle({ right: '56px', bottom: '26px' });
    view.unmount();
    render(<PluginToastHost />);
    expect(screen.getByRole('region')).toHaveStyle({ right: '56px', bottom: '26px' });
    fireEvent.click(screen.getByRole('button', { name: 'Reset notification position' }));
    expect(screen.getByRole('region')).toHaveStyle({ right: '16px', bottom: '16px' });
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    fireEvent.keyDown(handle(), { key: 'Home' });
    expect(JSON.parse(window.localStorage.getItem(POSITION_KEY)!)).toEqual({ right: 16, bottom: 16 });
  });

  it('clamps dragging and adjusts when the window shrinks or the toast stack grows', () => {
    render(<PluginToastHost />);
    const grip = handle();
    pointer(grip, 'pointerdown', 900, 700);
    pointer(grip, 'pointermove', -1000, -1000);
    pointer(grip, 'pointerup', -1000, -1000);
    expect(screen.getByRole('region')).toHaveStyle({ right: '600px', bottom: '604px' });

    vi.stubGlobal('innerWidth', 600);
    vi.stubGlobal('innerHeight', 400);
    fireEvent(window, new Event('resize'));
    expect(screen.getByRole('region')).toHaveStyle({ right: '200px', bottom: '204px' });
    stackHeight = 300;
    act(() => resizeStack());
    expect(screen.getByRole('region')).toHaveStyle({ right: '200px', bottom: '84px' });
    pointer(grip, 'pointerdown', 100, 100);
    pointer(grip, 'pointermove', 5000, 5000);
    pointer(grip, 'pointerup', 5000, 5000);
    expect(screen.getByRole('region')).toHaveStyle({ right: '16px', bottom: '16px' });
  });

  it('ignores unrelated pointers and stops movement after cancellation or capture loss', () => {
    render(<PluginToastHost />);
    const grip = handle();
    pointer(grip, 'pointerdown', 900, 700, 1, 2);
    pointer(grip, 'pointermove', 800, 600);
    expect(screen.getByRole('region')).toHaveStyle({ right: '16px', bottom: '16px' });
    for (const ending of ['pointercancel', 'lostpointercapture']) {
      pointer(grip, 'pointerdown', 900, 700);
      pointer(grip, 'pointermove', 800, 600, 2);
      pointer(grip, ending, 900, 700);
      pointer(grip, 'pointermove', 800, 600);
      expect(screen.getByRole('region')).toHaveStyle({ right: '16px', bottom: '16px' });
    }
  });

  it('releases a drag when its toast disappears while other notifications remain', () => {
    const remaining = notification({ id: 'azure', title: 'Azure Sync' });
    plugin.uiState.notifications = [notification(), remaining];
    const view = render(<PluginToastHost />);
    const grip = handle();
    pointer(grip, 'pointerdown', 900, 700);
    pointer(grip, 'pointermove', 800, 600);
    plugin.uiState.notifications = [remaining];
    view.rerender(<PluginToastHost />);
    expect(grip).not.toBeInTheDocument();

    const nextGrip = handle('Open notification: Azure Sync');
    pointer(nextGrip, 'pointerdown', 800, 600, 2);
    pointer(nextGrip, 'pointermove', 700, 500, 2);
    pointer(nextGrip, 'pointerup', 700, 500, 2);
    fireEvent.click(nextGrip, { detail: 1 });
    expect(screen.getByRole('region')).toHaveStyle({ right: '216px', bottom: '216px' });
    expect(JSON.parse(window.localStorage.getItem(POSITION_KEY)!)).toEqual({ right: 216, bottom: 216 });
    expect(plugin.injectNavigationRequest).not.toHaveBeenCalled();
  });

  it('recovers from invalid saved coordinates and unavailable storage', () => {
    window.localStorage.setItem(POSITION_KEY, '{"right":"bad","bottom":null}');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage blocked');
    });
    render(<PluginToastHost />);
    expect(screen.getByRole('region')).toHaveStyle({ right: '16px', bottom: '16px' });
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    expect(screen.getByRole('region')).toHaveStyle({ bottom: '26px' });
  });
});

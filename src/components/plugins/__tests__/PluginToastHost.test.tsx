import { act, fireEvent, render, screen } from '@testing-library/react';
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

function handle() {
  const button = screen.getByRole('button', { name: 'Move notifications' });
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
  vi.stubGlobal('innerWidth', 1000);
  vi.stubGlobal('innerHeight', 800);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, 384, stackHeight),
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
    pointer(grip, 'pointerdown', 950, 600);
    pointer(grip, 'pointermove', 750, 500);
    expect(screen.getByRole('region')).toHaveStyle({ right: '216px', bottom: '116px' });
    expect(grip.setPointerCapture).toHaveBeenCalledWith(1);

    plugin.uiState.notifications = [notification({ body: 'Syncing credentials' })];
    view.rerender(<PluginToastHost />);
    pointer(grip, 'pointermove', 700, 450);
    pointer(grip, 'pointerup', 700, 450);
    fireEvent.click(grip); // A browser emits a click after pointerup.
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

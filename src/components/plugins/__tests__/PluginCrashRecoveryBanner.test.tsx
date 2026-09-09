import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { PluginCrashRecoveryBanner } from '../PluginCrashRecoveryBanner';

afterEach(() => {
  cleanup();
  uninstallAppBridgeStub();
});

describe('PluginCrashRecoveryBanner', () => {
  it('renders nothing when no plugins are degraded', async () => {
    installAppBridgeStub({
      plugins: {
        getDegradedPlugins: async () => [],
        onDegradedChanged: () => () => undefined,
        restartApp: async () => ({ success: true }),
      },
    });
    const { container } = render(<PluginCrashRecoveryBanner />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('names the single degraded plugin and offers a restart', async () => {
    installAppBridgeStub({
      plugins: {
        getDegradedPlugins: async () => ['msgraph'],
        onDegradedChanged: () => () => undefined,
        restartApp: async () => ({ success: true }),
      },
    });
    render(<PluginCrashRecoveryBanner />);
    expect(await screen.findByText(/“msgraph” stopped running after a recovery/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart Kai' })).toBeInTheDocument();
  });

  it('summarizes when multiple plugins are degraded', async () => {
    installAppBridgeStub({
      plugins: {
        getDegradedPlugins: async () => ['a', 'b', 'c'],
        onDegradedChanged: () => () => undefined,
        restartApp: async () => ({ success: true }),
      },
    });
    render(<PluginCrashRecoveryBanner />);
    expect(await screen.findByText('3 plugins stopped running after a recovery')).toBeInTheDocument();
  });

  it('invokes restartApp when the button is clicked', async () => {
    const restartApp = vi.fn(async () => ({ success: true }));
    installAppBridgeStub({
      plugins: {
        getDegradedPlugins: async () => ['msgraph'],
        onDegradedChanged: () => () => undefined,
        restartApp,
      },
    });
    render(<PluginCrashRecoveryBanner />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart Kai' }));
    await waitFor(() => expect(restartApp).toHaveBeenCalledTimes(1));
  });

  it('updates live when the degraded set changes via onDegradedChanged', async () => {
    const holder: { emit: (data: { plugins: string[] }) => void } = { emit: () => undefined };
    installAppBridgeStub({
      plugins: {
        getDegradedPlugins: async () => [],
        onDegradedChanged: (cb: (data: { plugins: string[] }) => void) => {
          holder.emit = cb;
          return () => undefined;
        },
        restartApp: async () => ({ success: true }),
      },
    });
    const { container } = render(<PluginCrashRecoveryBanner />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    holder.emit({ plugins: ['rally'] });
    expect(await screen.findByText(/“rally” stopped running after a recovery/)).toBeInTheDocument();
  });
});

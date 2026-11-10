import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PluginBridgeApi, BridgeSnapshot } from '../../../../shared/plugin-bridge';
import { bridgePluginFixture, bridgeSnapshotFixture } from '../../../../test-utils/plugin-bridge-ui';
import { PluginBridgeSettings } from '../PluginBridgeSettings';

describe('Plugin Bridge human settings', () => {
  let snapshot: BridgeSnapshot, api: PluginBridgeApi;
  const originalApp = window.app;
  beforeEach(() => {
    snapshot = bridgeSnapshotFixture();
    api = {
      snapshot: vi.fn(async () => structuredClone(snapshot)),
      discover: vi.fn(async () => structuredClone(snapshot)),
      mutate: vi.fn(async (change) => {
        if (change.action === 'imports') snapshot.importsEnabled = change.enabled;
        if (change.action === 'sharing') snapshot.sharingEnabled = change.enabled;
        if (change.action === 'remote') snapshot.remoteEnabled = change.enabled;
        return structuredClone(snapshot);
      }),
      previewClient: vi.fn(async (host) => ({
        id: 'preview',
        host,
        path: '/fixture/config.toml',
        configuration: '[mcp_servers.kai-mcp]\ncommand="kai"',
        conflict: true,
        expiresAt: '2026-01-01T00:10:00Z',
      })),
      applyClient: vi.fn(async () => ({ configuration: 'created configuration' })),
      createToken: vi.fn(async () => ({
        token: 'fixture-token',
        client: {
          id: 'fixture',
          name: 'Test client',
          kind: 'static' as const,
          createdAt: '2026-01-01T00:00:00Z',
          expiresAt: '2026-01-31T00:00:00Z',
        },
      })),
    };
    Object.defineProperty(window, 'app', { configurable: true, value: { pluginBridge: api } });
  });
  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'app', { configurable: true, value: originalApp });
  });

  it('starts off, loads no inventory automatically, and keeps import and export controls independent', async () => {
    const user = userEvent.setup();
    render(<PluginBridgeSettings />);
    expect(await screen.findByRole('switch', { name: 'Import installed plugins' })).toHaveAttribute(
      'data-state',
      'unchecked',
    );
    expect(api.discover).not.toHaveBeenCalled();
    expect(api.mutate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('switch', { name: 'Import installed plugins' }));
    expect(api.mutate).toHaveBeenCalledWith({ action: 'imports', enabled: true });
    await user.click(screen.getByRole('tab', { name: 'Share Kai' }));
    expect(screen.getByRole('switch', { name: 'Share Kai through MCP' })).toHaveAttribute('data-state', 'unchecked');
    expect(screen.queryByRole('button', { name: 'Connect to Codex' })).not.toBeInTheDocument();
  });

  it('submits only the reviewed component selection and preserves the source revision', async () => {
    const plugin = bridgePluginFixture();
    snapshot = bridgeSnapshotFixture({ importsEnabled: true, plugins: [plugin] });
    const user = userEvent.setup();
    render(<PluginBridgeSettings />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    expect(screen.getAllByRole('checkbox').every((c) => c.getAttribute('data-state') === 'unchecked')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Skills only' }));
    await user.click(screen.getByRole('button', { name: 'Save component approvals' }));
    expect(api.mutate).toHaveBeenCalledWith({
      action: 'approve',
      pluginId: plugin.id,
      packagePath: plugin.packagePath,
      revisions: { [plugin.components[0].id]: plugin.components[0].revision },
      allowOverlap: false,
    });
  });

  it('treats a cancelled approval as a normal outcome and preserves the switch', async () => {
    vi.mocked(api.mutate).mockRejectedValueOnce(
      new Error("Error invoking remote method 'plugin-bridge:mutate': Error: Bridge change cancelled."),
    );
    const user = userEvent.setup();
    render(<PluginBridgeSettings />);
    await user.click(await screen.findByRole('switch', { name: 'Import installed plugins' }));
    expect(await screen.findByRole('status')).toHaveTextContent('No changes applied.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Import installed plugins' })).toHaveAttribute('data-state', 'unchecked');
  });

  it('turns a source-wide grant into an explicit subset when an individual tool is unchecked', async () => {
    snapshot = bridgeSnapshotFixture({
      sharingEnabled: true,
      sources: [
        {
          id: 'plugin:msgraph',
          name: 'MSGraph',
          selected: true,
          imported: false,
          tools: ['read', 'write'].map((name) => ({
            id: `plugin:msgraph/${name}`,
            name,
            description: `${name} fixture`,
            available: true,
            selected: true,
          })),
        },
      ],
    });
    const user = userEvent.setup();
    render(<PluginBridgeSettings focusTab="sharing" />);
    await user.click(await screen.findByRole('button', { name: 'Review MSGraph tools' }));
    await user.click(screen.getByRole('checkbox', { name: 'write write fixture' }));
    await user.click(screen.getByRole('button', { name: 'Save shared tools' }));
    expect(api.mutate).toHaveBeenCalledWith({ action: 'exports', sources: [], tools: ['plugin:msgraph/read'] });
  });

  it('keeps conflicting host entries safe and retries clipboard access without creating another credential', async () => {
    snapshot = bridgeSnapshotFixture({ sharingEnabled: true });
    const user = userEvent.setup();
    const copy = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValueOnce(new Error('Clipboard unavailable'))
      .mockResolvedValue(undefined);
    render(<PluginBridgeSettings focusTab="sharing" />);
    await user.click(await screen.findByRole('button', { name: 'Connect to Codex' }));
    expect(screen.getByRole('button', { name: 'Create connector and apply' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Create connector and copy' }));
    expect(api.applyClient).toHaveBeenCalledWith('preview', false);
    expect(await screen.findByText('Clipboard unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy created configuration' }));
    expect(api.applyClient).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenLastCalledWith('created configuration');
    copy.mockRestore();
  });

  it('uses the default token expiry and removes the revealed token after remote sharing is disabled', async () => {
    snapshot = bridgeSnapshotFixture({
      sharingEnabled: true,
      remoteEnabled: true,
      publicUrl: 'https://fixture.test/mcp',
    });
    const user = userEvent.setup();
    render(<PluginBridgeSettings focusTab="sharing" />);
    await user.type(await screen.findByRole('textbox', { name: 'Token name' }), 'Remote fixture');
    await user.click(screen.getByRole('button', { name: 'Create bearer token' }));
    expect(api.createToken).toHaveBeenCalledWith('Remote fixture', 30);
    expect(await screen.findByText('fixture-token')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Allow remote MCP connections' }));
    await waitFor(() => expect(screen.queryByText('fixture-token')).not.toBeInTheDocument());
  });

  it('recovers an initial load failure and publishes the partial runtime coverage', async () => {
    vi.mocked(api.snapshot).mockRejectedValueOnce(new Error('Backend is restarting.'));
    const user = userEvent.setup();
    render(<PluginBridgeSettings />);
    await screen.findByRole('alert');
    expect(screen.queryByText('Loading Plugin Bridge…')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Runtime compatibility' }));
    expect(screen.getByText(/Native Codex tools bypass/)).toBeInTheDocument();
  });
});

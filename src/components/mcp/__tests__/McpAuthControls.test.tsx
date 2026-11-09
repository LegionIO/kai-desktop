import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { mcpApiFixture, mcpStatusFixture } from '../../../../test-utils/mcp-ui';
import { McpAuthControls, McpAuthNotice } from '../McpAuthControls';
import type { McpStatus } from '../../../../shared/mcp';
beforeEach(() => {
  vi.spyOn(window, 'open').mockImplementation(() => null);
});
afterEach(() => {
  cleanup();
  uninstallAppBridgeStub();
  vi.restoreAllMocks();
});
it('opens desktop sign-in in Kai and offers an explicit system-browser fallback', async () => {
  const openLogin = vi.fn(async () => {});
  installAppBridgeStub({ mcp: mcpApiFixture({ openLogin }) });
  const { rerender } = render(<McpAuthControls name="fixture" status={mcpStatusFixture} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
  await waitFor(() => expect(openLogin).toHaveBeenCalledWith('fixture-login', 'in-app'));
  expect(window.open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open in system browser' }));
  await waitFor(() => expect(openLogin).toHaveBeenCalledWith('fixture-login', 'system'));
  rerender(<McpAuthControls name="fixture" status={{ ...mcpStatusFixture, state: 'authenticating' }} />);
  rerender(<McpAuthControls name="fixture" status={mcpStatusFixture} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('opens sign-in on the browser client device instead of the backend desktop', async () => {
  const openLogin = vi.fn(async () => {});
  installAppBridgeStub({ __isWebBridge: true, mcp: mcpApiFixture({ openLogin }) });
  render(<McpAuthControls name="fixture" status={mcpStatusFixture} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
  await screen.findByRole('link', { name: 'Open sign-in page' });
  expect(window.open).toHaveBeenCalledWith('https://auth.test/authorize', '_blank', 'noopener,noreferrer');
  expect(openLogin).not.toHaveBeenCalled();
});
it.each([false, true])('offers an explicit reset while the sign-in page is stuck (web=%s)', async (web) => {
  const resetRegistration = vi.fn(async () => {});
  const login = vi.fn(mcpApiFixture().login);
  const completeLogin = vi.fn(async () => {});
  installAppBridgeStub({ __isWebBridge: web, mcp: mcpApiFixture({ resetRegistration, login, completeLogin }) });
  render(<McpAuthControls name="fixture" status={{ ...mcpStatusFixture, canResetRegistration: true }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
  const callback = await screen.findByLabelText('Callback URL');
  fireEvent.change(callback, { target: { value: 'http://localhost/callback?code=private-code' } });
  expect(screen.getByText(/If the sign-in page shows invalid_client/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Reset registration' }));
  await waitFor(() => expect(resetRegistration).toHaveBeenCalledExactlyOnceWith('fixture'));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(login).toHaveBeenCalledTimes(1);
  expect(completeLogin).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain('private-code');
  expect(screen.getByText(/Local registration cleared/)).toBeInTheDocument();
});
it('does not offer a registration reset for configured or metadata clients', () => {
  installAppBridgeStub({ mcp: mcpApiFixture() });
  render(
    <McpAuthControls
      name="fixture"
      status={{ ...mcpStatusFixture, canResetRegistration: false }}
      clientId="registered"
    />,
  );
  expect(screen.queryByRole('button', { name: 'Reset registration' })).not.toBeInTheDocument();
});
it('never opens a browser for background authentication notices and deduplicates updates', async () => {
  let notify!: (status: McpStatus[]) => void;
  installAppBridgeStub({
    mcp: mcpApiFixture({
      onStatusChanged: (cb) => {
        notify = cb;
        return () => {};
      },
    }),
  });
  render(<McpAuthNotice />);
  await screen.findByRole('button', { name: 'Reconnect' });
  act(() => {
    notify([mcpStatusFixture]);
    notify([mcpStatusFixture]);
  });
  expect(screen.getAllByRole('button', { name: 'Reconnect' })).toHaveLength(1);
  expect(window.open).not.toHaveBeenCalled();
});
it('accepts a callback privately, clears it, and closes after completion', async () => {
  const complete = vi.fn(async () => {});
  installAppBridgeStub({ mcp: mcpApiFixture({ completeLogin: complete }) });
  render(<McpAuthControls name="fixture" status={mcpStatusFixture} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
  const input = await screen.findByLabelText('Callback URL');
  expect(input).toHaveAttribute('type', 'password');
  fireEvent.change(input, { target: { value: 'http://localhost/callback?code=secret&state=state' } });
  fireEvent.click(screen.getByRole('button', { name: 'Complete sign-in' }));
  await waitFor(() =>
    expect(complete).toHaveBeenCalledWith('fixture-login', 'http://localhost/callback?code=secret&state=state'),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(document.body.textContent).not.toContain('code=secret');
});
it('cancels sign-in when the dialog is closed', async () => {
  const cancel = vi.fn(async () => {});
  installAppBridgeStub({ mcp: mcpApiFixture({ cancelLogin: cancel }) });
  render(<McpAuthControls name="fixture" status={mcpStatusFixture} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel sign-in' }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('fixture'));
});
it('shows session-only storage and distinguishes local sign-out from revocation', async () => {
  installAppBridgeStub({ mcp: mcpApiFixture() });
  render(<McpAuthControls name="fixture" status={{ ...mcpStatusFixture, state: 'authorized', storage: 'session' }} />);
  expect(screen.getByText(/Credentials last for this Kai session only/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByText('Signed out locally. Server revocation was not confirmed.')).toBeInTheDocument();
});
it('keeps client secrets in dedicated IPC and clears the password dialog', async () => {
  const secret = vi.fn(async () => {});
  installAppBridgeStub({ mcp: mcpApiFixture({ setClientSecret: secret }) });
  render(<McpAuthControls name="fixture" status={mcpStatusFixture} clientId="registered" />);
  fireEvent.click(screen.getByRole('button', { name: 'Set client secret' }));
  fireEvent.change(screen.getByLabelText('Client secret', { selector: 'input' }), {
    target: { value: 'private-secret' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
  await waitFor(() => expect(secret).toHaveBeenCalledWith('fixture', 'private-secret'));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(document.body.textContent).not.toContain('private-secret');
});
it('does not let a stale initial status hide a newer authentication notice', async () => {
  let resolve!: (items: McpStatus[]) => void, notify!: (items: McpStatus[]) => void;
  installAppBridgeStub({
    mcp: mcpApiFixture({
      getStatus: () =>
        new Promise((done) => {
          resolve = done;
        }),
      onStatusChanged: (cb) => {
        notify = cb;
        return () => {};
      },
    }),
  });
  render(<McpAuthNotice />);
  act(() => notify([mcpStatusFixture]));
  await act(async () => resolve([]));
  expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
});

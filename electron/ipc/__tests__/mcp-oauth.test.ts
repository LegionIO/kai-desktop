import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMain } from 'electron';
import type { AppConfig } from '../../config/schema.js';
const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  open: vi.fn(),
  inApp: vi.fn(),
  close: vi.fn(),
}));
vi.mock('../../mcp/login-window.js', () => ({
  McpLoginWindows: class {
    open = mocks.inApp;
    close = mocks.close;
  },
}));
vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: mocks.open },
}));
vi.mock('../../utils/window-send.js', () => ({ broadcastToAllWindows: mocks.broadcast }));
vi.mock('../../tools/mcp-client.js', () => ({
  setMcpOAuthService: vi.fn(),
  getMcpStatus: () => [],
  connectMcpServer: mocks.connect,
  disconnectMcpServer: mocks.disconnect,
}));
import { registerMcpHandlers } from '../mcp.js';
import { mcpCredentialKey } from '../../mcp/oauth-service.js';
import { oauthServer, oauthTokens } from '../../../test-utils/mcp-oauth.js';
let home: string, service: ReturnType<typeof registerMcpHandlers>;
const handlers = new Map<string, (...args: unknown[]) => unknown>();
const config = { mcpServers: [{ ...oauthServer, oauth: { clientId: 'registered' } }] } as AppConfig;
const reconnect = vi.fn(async () => {});
const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(null, ...args);
beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  home = mkdtempSync(join(tmpdir(), 'kai-ipc-oauth-test-'));
  const ipc = {
    handle: (channel: string, callback: (...args: unknown[]) => unknown) => handlers.set(channel, callback),
  } as unknown as IpcMain;
  mocks.connect.mockResolvedValue({ status: 'error', tools: [], error: 'Authentication required' });
  service = registerMcpHandlers(ipc, home, () => config, reconnect);
});
afterEach(() => {
  service.dispose();
  rmSync(home, { recursive: true, force: true });
});
it('keeps secrets out of status and broadcasts and disconnects after changing the client secret', async () => {
  await invoke('mcp:set-client-secret', 'fixture', 'private-value');
  expect(service.store.get(mcpCredentialKey(config.mcpServers[0])).clientSecret).toBe('private-value');
  expect(JSON.stringify(invoke('mcp:status'))).not.toContain('private-value');
  expect(JSON.stringify(mocks.broadcast.mock.calls)).not.toContain('private-value');
  expect(mocks.disconnect).toHaveBeenCalledWith('fixture');
});
it('tests a saved server with its credential identity despite its temporary connection name', async () => {
  await invoke('mcp:test-connection', config.mcpServers[0]);
  expect(mocks.connect.mock.calls[0][0].name).toMatch(/^__test__fixture__/);
  expect(mocks.connect.mock.calls[0][1]).toEqual(config.mcpServers[0]);
  expect(mocks.open).not.toHaveBeenCalled();
});
it('isolates simultaneous connection tests even when they start in the same millisecond', async () => {
  await Promise.all([
    invoke('mcp:test-connection', config.mcpServers[0]),
    invoke('mcp:test-connection', config.mcpServers[0]),
  ]);
  const names = mocks.connect.mock.calls.map(([server]) => server.name);
  expect(new Set(names).size).toBe(2);
  expect(mocks.connect.mock.calls.map(([, credential]) => credential)).toEqual([
    config.mcpServers[0],
    config.mcpServers[0],
  ]);
  expect(mocks.disconnect.mock.calls.map(([name]) => name).sort()).toEqual(names.sort());
});
it('does not report saved authorization for an unsaved configuration', async () => {
  service.store.set(mcpCredentialKey(config.mcpServers[0]), { tokens: oauthTokens });
  const result = (await invoke('mcp:test-connection', { ...oauthServer, oauth: { clientId: 'other' } })) as {
    auth?: unknown;
  };
  expect(result.auth).toBeUndefined();
});
it('rejects unknown reconnects and browser opening without an active attempt', async () => {
  await expect(invoke('mcp:reconnect', 'missing')).rejects.toThrow('Save and enable');
  expect(() => invoke('mcp:open-login', 'a'.repeat(48))).toThrow('expired');
  expect(reconnect).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
});
it('uses the validated attempt for in-app sign-in and keeps the CLI/system fallback', async () => {
  const id = 'a'.repeat(48);
  vi.spyOn(service, 'authorizationUrl').mockReturnValue('https://auth.test/authorize');
  mocks.open.mockResolvedValue(undefined);
  await invoke('mcp:open-login', id, 'in-app');
  expect(mocks.inApp).toHaveBeenCalledExactlyOnceWith(id);
  expect(mocks.open).not.toHaveBeenCalled();
  await invoke('mcp:open-login', id);
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith('https://auth.test/authorize');
  expect(mocks.close).toHaveBeenCalledExactlyOnceWith(id);
  expect(() => invoke('mcp:open-login', id, 'unknown')).toThrow();
});

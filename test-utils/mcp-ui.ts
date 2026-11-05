import type { McpApi, McpStatus } from '../shared/mcp';
export const mcpStatusFixture: McpStatus = {
  name: 'fixture',
  state: 'required',
  reason: 'expired',
  message: 'Sign in again to reconnect this MCP server.',
  storage: 'encrypted',
  hasClientSecret: false,
  hasCredentials: true,
  enabled: true,
  status: 'disconnected',
  toolCount: 0,
};
export function mcpApiFixture(overrides: Partial<McpApi> = {}): McpApi {
  return {
    testConnection: async () => ({ status: 'error', toolCount: 0 }),
    getStatus: async () => [mcpStatusFixture],
    onStatusChanged: () => () => {},
    login: async () => ({
      loginId: 'fixture-login',
      authorizationUrl: 'https://auth.test/authorize',
      expiresAt: Date.now() + 300_000,
    }),
    completeLogin: async () => {},
    cancelLogin: async () => {},
    reconnect: async () => {},
    logout: async () => ({ localCleared: true, revocation: 'unsupported' }),
    setClientSecret: async () => {},
    ...overrides,
  };
}

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  listTools: vi.fn(),
  calls: [] as ReturnType<typeof vi.fn>[],
  close: vi.fn(),
  http: vi.fn(),
  sse: vi.fn(),
  stdio: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mocks.connect;
    listTools = mocks.listTools;
    close = mocks.close;
    callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    constructor() {
      mocks.calls.push(this.callTool);
    }
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async (original) => ({
  ...(await original<object>()),
  StreamableHTTPClientTransport: class {
    close = vi.fn();
    constructor(...args: unknown[]) {
      mocks.http(...args);
    }
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    close = vi.fn();
    constructor(...args: unknown[]) {
      mocks.sse(...args);
    }
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    close = vi.fn();
    constructor(...args: unknown[]) {
      mocks.stdio(...args);
    }
  },
}));
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpOAuthError, McpOAuthService } from '../../mcp/oauth-service.js';
import { McpCredentialStore } from '../../mcp/credential-store.js';
import {
  connectMcpServer,
  disconnectAllMcpServers,
  disconnectMcpServer,
  getMcpStatus,
  setMcpOAuthService,
} from '../mcp-client.js';
import { fixtureEncryption, oauthDeferred, oauthServer } from '../../../test-utils/mcp-oauth.js';
import { mcpChatTool } from '../../../test-utils/mcp-schema.js';
let service: McpOAuthService;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.connect.mockResolvedValue(undefined);
  mocks.listTools.mockResolvedValue({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] });
  service = new McpOAuthService(
    new McpCredentialStore('/unused', { ...fixtureEncryption(), isEncryptionAvailable: () => false }),
  );
  service.configure([oauthServer]);
  setMcpOAuthService(service, () => {});
});
afterEach(() => disconnectAllMcpServers());
it('uses the shared fetch for HTTP and legacy SSE fallback', async () => {
  mocks.connect.mockRejectedValueOnce(new StreamableHTTPError(405, 'method not supported'));
  const conn = await connectMcpServer(oauthServer);
  expect(conn.status).toBe('connected');
  expect(mocks.sse).toHaveBeenCalledTimes(1);
  expect(mocks.http.mock.calls[0][1].fetch).toBe(mocks.sse.mock.calls[0][1].fetch);
});
it.each([new McpOAuthError('Sign in', 'sign-in'), new StreamableHTTPError(401, 'auth'), new Error('timeout')])(
  'does not hide authentication/network failures behind SSE (%s)',
  async (error) => {
    mocks.connect.mockRejectedValueOnce(error);
    const conn = await connectMcpServer(oauthServer);
    expect(conn.status).toBe('error');
    expect(mocks.sse).not.toHaveBeenCalled();
  },
);
it('resolves existing tool handlers against the current client after reconnect', async () => {
  const first = await connectMcpServer(oauthServer);
  const handler = first.tools[0].execute;
  await disconnectMcpServer(oauthServer.name);
  await connectMcpServer(oauthServer);
  expect(await handler({}, { toolCallId: 'fixture-call' })).toBe('ok');
  expect(mocks.calls[0]).not.toHaveBeenCalled();
  expect(mocks.calls[1]).toHaveBeenCalledTimes(1);
});
it('does not resurrect a connection when disconnected during discovery', async () => {
  let resolve!: (value: unknown) => void;
  mocks.listTools.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = connectMcpServer(oauthServer);
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  await disconnectMcpServer(oauthServer.name);
  resolve({ tools: [] });
  await pending;
  expect(getMcpStatus()).toEqual([]);
  expect(mocks.close).toHaveBeenCalled();
});
it('closes a disconnected client before replacing it', async () => {
  const first = await connectMcpServer(oauthServer);
  first.transport.onerror?.(new Error('Connection lost'));
  expect(first.status).toBe('disconnected');
  const second = await connectMcpServer(oauthServer);
  expect(second.status).toBe('connected');
  expect(second.client).not.toBe(first.client);
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(mocks.close.mock.invocationCallOrder[0]).toBeLessThan(mocks.connect.mock.invocationCallOrder[1]);
});
it('replaces a connected client when the endpoint changes', async () => {
  const first = await connectMcpServer(oauthServer);
  const replacement = { ...oauthServer, url: 'https://mcp.test/other' };
  const second = await connectMcpServer(replacement);
  expect(second.client).not.toBe(first.client);
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(mocks.http.mock.calls[1][0].href).toBe(replacement.url);
});
it('does not reuse or remove a client that reconnects while its predecessor is closing', async () => {
  const first = await connectMcpServer(oauthServer);
  const closing = oauthDeferred();
  mocks.close.mockReturnValueOnce(closing.promise);
  const disconnecting = disconnectMcpServer(oauthServer.name);
  try {
    const second = await connectMcpServer(oauthServer);
    expect(second.client).not.toBe(first.client);
    closing.resolve();
    await disconnecting;
    expect(getMcpStatus()).toEqual([{ name: 'fixture', status: 'connected', toolCount: 1, error: undefined }]);
  } finally {
    closing.resolve();
  }
});
it('does not resurrect a pending connection after shutdown', async () => {
  const discovering = oauthDeferred(),
    tools = oauthDeferred<{ tools: [] }>();
  mocks.listTools.mockImplementationOnce(() => {
    discovering.resolve();
    return tools.promise;
  });
  const pending = connectMcpServer(oauthServer);
  await discovering.promise;
  await disconnectAllMcpServers();
  tools.resolve({ tools: [] });
  await pending;
  expect(getMcpStatus()).toEqual([]);
  expect(mocks.close).toHaveBeenCalled();
});
it('coalesces simultaneous connects and leaves stdio unauthenticated', async () => {
  const server = { name: 'local', command: 'fixture', args: ['serve'] };
  await Promise.all([connectMcpServer(server), connectMcpServer(server)]);
  expect(mocks.stdio).toHaveBeenCalledTimes(1);
  expect(mocks.http).not.toHaveBeenCalled();
});

it.each([
  { label: 'plain text', content: 'Hello' },
  { label: 'content parts', content: [{ type: 'text', text: 'Hello' }] },
])('validates and executes a discovered chat tool with $label', async ({ content }) => {
  mocks.listTools.mockResolvedValueOnce({ tools: [mcpChatTool()] });
  const conn = await connectMcpServer(oauthServer);
  const args = { messages: [{ role: 'user', content }] };
  const parsed = conn.tools[0].inputSchema.parse(args);
  expect(parsed).toEqual(args);
  expect(await conn.tools[0].execute(parsed, { toolCallId: 'chat-fixture' })).toBe('ok');
  expect(mocks.calls[0].mock.calls[0][0]).toEqual({ name: 'chat', arguments: args });
});

it('rejects chat content outside the advertised alternatives', async () => {
  mocks.listTools.mockResolvedValueOnce({ tools: [mcpChatTool()] });
  const conn = await connectMcpServer(oauthServer);
  for (const content of [42, null, { text: 'Hello' }, ['Hello']]) {
    expect(conn.tools[0].inputSchema.safeParse({ messages: [{ role: 'user', content }] }).success).toBe(false);
  }
  expect(mocks.calls[0]).not.toHaveBeenCalled();
});

it('keeps chat alternatives in the schema exposed to model runtimes', async () => {
  mocks.listTools.mockResolvedValueOnce({ tools: [mcpChatTool()] });
  const conn = await connectMcpServer(oauthServer);
  expect(z.toJSONSchema(conn.tools[0].inputSchema)).toMatchObject({
    properties: {
      messages: {
        items: {
          properties: {
            content: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] },
          },
        },
      },
    },
  });
});

it.each([
  { keyword: 'oneOf', integerAccepted: false },
  { keyword: 'anyOf', integerAccepted: true },
])('preserves $keyword semantics when alternatives overlap', async ({ keyword, integerAccepted }) => {
  mocks.listTools.mockResolvedValueOnce({
    tools: [mcpChatTool({ [keyword]: [{ type: 'number' }, { type: 'integer' }] })],
  });
  const conn = await connectMcpServer(oauthServer);
  const accepts = (content: unknown) =>
    conn.tools[0].inputSchema.safeParse({ messages: [{ role: 'user', content }] }).success;
  expect(accepts(1.5)).toBe(true);
  expect(accepts(1)).toBe(integerAccepted);
  expect(accepts('1')).toBe(false);
});

it('preserves base constraints alongside alternatives', async () => {
  mocks.listTools.mockResolvedValueOnce({
    tools: [mcpChatTool({ type: 'string', minLength: 3, anyOf: [{ enum: ['ok', 'ready'] }, { enum: ['pending'] }] })],
  });
  const conn = await connectMcpServer(oauthServer);
  const accepts = (content: string) =>
    conn.tools[0].inputSchema.safeParse({ messages: [{ role: 'user', content }] }).success;
  expect(accepts('ready')).toBe(true);
  expect(accepts('pending')).toBe(true);
  expect(accepts('ok')).toBe(false);
  expect(accepts('unknown')).toBe(false);
});

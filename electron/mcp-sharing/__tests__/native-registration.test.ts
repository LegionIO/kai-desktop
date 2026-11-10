import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { nativeToolRegistrationFixture } from '../../../test-utils/plugin-registration.js';
import { bridgeFixture } from '../../../test-utils/plugin-bridge.js';
import { KaiMcpService, exportSourceId } from '../service.js';
import type { ToolDefinition } from '../../tools/types.js';

describe('native registration through Kai MCP sharing', () => {
  let f: ReturnType<typeof bridgeFixture>;
  let native: ReturnType<typeof nativeToolRegistrationFixture>;
  let service: KaiMcpService;
  let client: Client;
  beforeEach(() => {
    f = bridgeFixture();
    native = nativeToolRegistrationFixture();
    service = new KaiMcpService(
      f.store,
      () => f.config,
      () => native.instance.registeredTools,
      () => true,
      (p) => f.credentials.active(p),
    );
    client = new Client({ name: 'fixture-consumer', version: '1' });
  });
  afterEach(async () => {
    await client.close();
    await service.stop();
    f.cleanup();
  });
  async function connect() {
    f.enableSharing();
    service.select([exportSourceId(native.instance.registeredTools[0])], []);
    const [local, remote] = InMemoryTransport.createLinkedPair();
    await service.connect(f.localClient().principal, remote);
    await client.connect(local);
  }

  it('preserves JSON schema constraints, registered names, account ownership and results', async () => {
    const schema = {
      type: 'object',
      properties: {
        folder: { type: 'string', default: 'inbox' },
        filter: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: { type: 'string' } }] },
      },
      additionalProperties: false,
      dependentRequired: { filter: ['folder'] },
    };
    const account = { id: 'fixture-account-one', secret: 'fixture-internal-plugin-secret' };
    const execute = vi.fn(async (input: unknown) => {
      // The existing plugin owns the account state; MCP only invokes its registered tool.
      return {
        content: [{ type: 'text', text: 'Fixture mail' }],
        structuredContent: { input, count: 1, account: account.id },
      };
    });
    native.api.tools.register([
      {
        name: 'list-mail',
        description: 'Read fixture mail',
        inputSchema: schema as unknown as z.ZodType,
        execute,
      },
    ]);
    const [registered] = native.instance.registeredTools;
    const nativeName = registered.name;
    expect(registered.originalName).toBe('list-mail');
    expect(registered.inputSchema.safeParse({ folder: 123 }).success).toBe(false);
    await connect();
    const listed = await client.listTools();
    expect(listed.tools[0].name).toBe(nativeName);
    expect(listed.tools[0].inputSchema).toEqual(schema);
    expect(JSON.stringify(listed)).not.toContain(account.secret);
    const input = { folder: 'inbox', filter: { subject: 'fixture' } };
    const result = await client.callTool({ name: nativeName, arguments: input });
    expect(result.structuredContent).toEqual({ input, count: 1, account: 'fixture-account-one' });
    expect(execute).toHaveBeenCalledWith(input, expect.objectContaining({ isHeadless: true }));
    expect(JSON.stringify(result)).not.toContain(account.secret);
    account.id = 'fixture-account-two';
    expect(await client.callTool({ name: nativeName, arguments: input })).toMatchObject({
      structuredContent: { account: 'fixture-account-two' },
    });
    native.disable();
    expect(await client.callTool({ name: nativeName, arguments: input })).toMatchObject({ isError: true });
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('retains Zod validation and native activation guards without an export-specific executor', async () => {
    const schema = z.object({ folder: z.string().min(3) });
    const execute = vi.fn(async () => ({ mail: [] }));
    native.api.tools.register([
      { name: 'list_mail', description: 'Fixture', inputSchema: schema, execute } satisfies ToolDefinition,
    ]);
    const [registered] = native.instance.registeredTools;
    expect(registered.inputSchema).toBe(schema);
    expect(registered.executeMcp).toBeUndefined();
    await connect();
    expect(await client.callTool({ name: registered.name, arguments: { folder: 'x' } })).toMatchObject({
      isError: true,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(await client.callTool({ name: registered.name, arguments: { folder: 'inbox' } })).toMatchObject({
      structuredContent: { mail: [] },
    });
  });
});

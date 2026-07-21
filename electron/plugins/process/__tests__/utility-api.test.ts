import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PluginManifest } from '../../types.js';
import type { UtilityTransport } from '../utility-transport.js';

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));

const { createUtilityPluginAPI } = await import('../utility-api.js');

const allPermissions: PluginManifest['permissions'] = [
  'config:read',
  'config:write',
  'tools:register',
  'ui:banner',
  'ui:modal',
  'ui:settings',
  'ui:panel',
  'ui:navigation',
  'messages:hook',
  'network:fetch',
  'auth:window',
  'http:listen',
  'notifications:send',
  'conversations:read',
  'conversations:write',
  'navigation:open',
  'state:publish',
  'events:publish',
  'events:subscribe',
  'agent:generate',
  'agent:hook',
  'agent:inference-provider',
  'agent:register-cli-tool',
  'safe-storage',
  'browser:window',
  'exec:whitelisted',
  'tools:detect',
  'system:env',
  'lifecycle:hook',
];

function setup() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const functions = new Map<string, (...args: unknown[]) => unknown>();
  let functionId = 0;
  const transport = {
    syncCall: vi.fn((method: string, args: unknown[] = []) => {
      calls.push({ method, args });
      if (method === 'config.get') return { ui: { theme: 'dark' } };
      if (method === 'config.getPluginData') return { enabled: true };
      if (method === 'safeStorage.encryptString') return `cipher:${String(args[0])}`;
      if (method === 'safeStorage.decryptString') return String(args[0]).replace(/^cipher:/, '');
      if (method === 'safeStorage.isEncryptionAvailable') return true;
      return undefined;
    }),
    asyncCall: vi.fn(async (method: string, args: unknown[] = []) => {
      calls.push({ method, args });
      if (method === 'agent.generate') return { text: 'ok', modelKey: 'test', toolCalls: [] };
      return undefined;
    }),
    streamCall: vi.fn(async function* () {
      yield { type: 'text-delta', text: 'streamed', conversationId: 'c1' };
    }),
    registerFunction: vi.fn((fn: (...args: unknown[]) => unknown) => {
      const id = `fn-${++functionId}`;
      functions.set(id, fn);
      return id;
    }),
  } as unknown as UtilityTransport;
  const manifest: PluginManifest = {
    name: 'compat-test',
    displayName: 'Compatibility Test',
    version: '1.0.0',
    description: 'fixture',
    permissions: allPermissions,
  };
  const api = createUtilityPluginAPI({
    manifest,
    pluginDir: '/tmp/compat-test',
    apiVersion: '1.2.3',
    capabilities: ['events:publish'],
    transport,
  });
  return { api, calls, functions, transport };
}

describe('utility-process plugin API compatibility proxy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps legacy synchronous getters and safe-storage calls synchronous', () => {
    const { api } = setup();
    expect(api.host.apiVersion()).toBe('1.2.3');
    expect(api.host.hasCapability('events:publish')).toBe(true);
    expect(api.config.get()).toEqual({ ui: { theme: 'dark' } });
    expect(api.config.getPluginData()).toEqual({ enabled: true });
    expect(api.safeStorage.isEncryptionAvailable()).toBe(true);
    expect(api.safeStorage.encryptString('secret')).toBe('cipher:secret');
    expect(api.safeStorage.decryptString('cipher:secret')).toBe('secret');
  });

  it('maintains plugin-owned state locally while mirroring writes to the host', () => {
    const { api, calls } = setup();
    api.state.replace({ nested: { count: 1 } });
    api.state.set('nested.count', 2);
    expect(api.state.get()).toEqual({ nested: { count: 2 } });
    expect(calls.filter((call) => call.method.startsWith('state.'))).toEqual([
      { method: 'state.replace', args: [{ nested: { count: 1 } }] },
      { method: 'state.set', args: ['nested.count', 2] },
    ]);
  });

  it('converts Zod tool schemas while preserving refinements and transforms in the remote callback', async () => {
    const { api, calls } = setup();
    const execute = vi.fn(async () => ({ ok: true }));
    api.tools.register([
      {
        name: 'echo',
        description: 'Echo a value',
        inputSchema: z.object({
          value: z
            .string()
            .min(3)
            .transform((value) => value.toUpperCase()),
        }),
        execute,
      },
    ]);

    const registration = calls.find((call) => call.method === 'tools.register');
    const tool = (registration?.args[0] as Array<Record<string, unknown>>)[0];
    expect(tool.inputSchema).toMatchObject({ type: 'object', properties: { value: { type: 'string' } } });
    const remoteExecute = tool.execute as (input: unknown, context: never) => Promise<unknown>;
    await expect(remoteExecute({ value: 'no' }, {} as never)).rejects.toThrow();
    await expect(remoteExecute({ value: 'valid' }, {} as never)).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith({ value: 'VALID' }, {});
  });

  it('registers inference callbacks by id and preserves async generate/stream behavior', async () => {
    const { api, calls, functions } = setup();
    api.agent.registerInferenceProvider({
      name: 'Fixture',
      isAvailable: () => true,
      stream: async function* () {
        yield { type: 'done', conversationId: 'provider' };
      },
    });
    const registration = calls.find((call) => call.method === 'agent.registerInferenceProvider');
    const descriptor = registration?.args[0] as { available: boolean; isAvailableId: string; streamId: string };
    expect(descriptor.available).toBe(true);
    expect(functions.has(descriptor.isAvailableId)).toBe(true);
    expect(functions.has(descriptor.streamId)).toBe(true);

    await expect(api.agent.generate({ messages: [] })).resolves.toMatchObject({ text: 'ok' });
    const events = [];
    for await (const event of api.agent.stream({ messages: [] })) events.push(event);
    expect(events).toEqual([{ type: 'text-delta', text: 'streamed', conversationId: 'c1' }]);
  });
});

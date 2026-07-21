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
    releaseFunction: vi.fn((id: string) => {
      functions.delete(id);
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

  it('releases prior inference-provider callback ids on re-register and unregister', () => {
    const { api, calls, functions } = setup();
    const makeProvider = () => ({
      name: 'Fixture',
      isAvailable: () => true,
      stream: async function* () {
        yield { type: 'done' as const, conversationId: 'p' };
      },
    });

    api.agent.registerInferenceProvider(makeProvider());
    const first = calls.find((c) => c.method === 'agent.registerInferenceProvider')!.args[0] as {
      isAvailableId: string;
      streamId: string;
    };
    expect(functions.has(first.isAvailableId)).toBe(true);
    expect(functions.has(first.streamId)).toBe(true);

    // Re-registering must release the FIRST registration's ids only AFTER the
    // new registration succeeds (they'd otherwise leak — .bind() makes fresh
    // functions each call, so there's never any id reuse to rely on).
    api.agent.registerInferenceProvider(makeProvider());
    expect(functions.has(first.isAvailableId)).toBe(false);
    expect(functions.has(first.streamId)).toBe(false);

    const second = calls.filter((c) => c.method === 'agent.registerInferenceProvider')[1].args[0] as {
      isAvailableId: string;
      streamId: string;
    };
    expect(functions.has(second.isAvailableId)).toBe(true);

    // Unregister releases the live registration's ids too.
    api.agent.unregisterInferenceProvider();
    expect(functions.has(second.isAvailableId)).toBe(false);
    expect(functions.has(second.streamId)).toBe(false);
  });

  it('keeps the prior provider intact and cleans up new ids when replacement fails', () => {
    const { api, calls, functions, transport } = setup();
    const makeProvider = () => ({
      name: 'Fixture',
      isAvailable: () => true,
      stream: async function* () {
        yield { type: 'done' as const, conversationId: 'p' };
      },
    });

    api.agent.registerInferenceProvider(makeProvider());
    const first = calls.find((c) => c.method === 'agent.registerInferenceProvider')!.args[0] as {
      isAvailableId: string;
      streamId: string;
    };

    // Make the NEXT host handoff fail.
    (transport.syncCall as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce((method: string) => {
      if (method === 'agent.registerInferenceProvider') throw new Error('handoff failed');
      return undefined;
    });

    const idsBefore = [...functions.keys()];
    expect(() => api.agent.registerInferenceProvider(makeProvider())).toThrow('handoff failed');

    // Prior provider's ids must survive (host still points to them)…
    expect(functions.has(first.isAvailableId)).toBe(true);
    expect(functions.has(first.streamId)).toBe(true);
    // …and the just-registered (now-orphaned) ids must be cleaned up, so no leak.
    expect([...functions.keys()].sort()).toEqual(idsBefore.sort());
  });

  it('keeps BOTH id sets alive when provider replacement TIMES OUT (ambiguous)', async () => {
    const { PluginCallTimeoutError } = await import('../utility-transport.js');
    const { api, calls, functions, transport } = setup();
    const makeProvider = () => ({
      name: 'Fixture',
      isAvailable: () => true,
      stream: async function* () {
        yield { type: 'done' as const, conversationId: 'p' };
      },
    });

    api.agent.registerInferenceProvider(makeProvider());
    const first = calls.find((c) => c.method === 'agent.registerInferenceProvider')!.args[0] as {
      isAvailableId: string;
      streamId: string;
    };

    // Next handoff TIMES OUT — the host may still adopt the queued request, so
    // neither the new ids NOR the old ids may be freed (freeing either could
    // strand a live provider on an unknown callback).
    (transport.syncCall as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce((method: string) => {
      if (method === 'agent.registerInferenceProvider') throw new PluginCallTimeoutError('timed out');
      return undefined;
    });

    expect(() => api.agent.registerInferenceProvider(makeProvider())).toThrow('timed out');

    // Old ids preserved (host might still be using the prior provider).
    expect(functions.has(first.isAvailableId)).toBe(true);
    expect(functions.has(first.streamId)).toBe(true);
    // New ids preserved too (host might have adopted the new provider). 4 total.
    expect(functions.size).toBe(4);
  });
});

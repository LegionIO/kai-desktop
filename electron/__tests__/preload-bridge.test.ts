/**
 * Preload bridge contract test.
 *
 * `electron/preload.ts` is the single point where the renderer talks to the
 * main process — the entire `window.app.*` surface is defined there via
 * `contextBridge.exposeInMainWorld('app', appAPI)`. A regression that
 * deletes or renames a namespace would break the renderer silently (the
 * IPC seam smoke test only exercises a single `config:get` round-trip).
 *
 * This test mocks `electron` so we can:
 *   1. Capture the `appAPI` object passed to `exposeInMainWorld`.
 *   2. Assert each top-level namespace is present with the methods consumer
 *      code in `src/lib/` and `src/providers/` depends on.
 *   3. For pure invoke methods, drive the function and verify the channel
 *      name reaches `ipcRenderer.invoke` — catching channel-string drift
 *      between preload and the IPC handler registrar.
 *
 * NOT in scope: full event-handler symmetry (`on*` subscribers) or the
 * tool-approval long-poll flow. Those are exercised by the runtime adapter
 * tests; this file pins only the wire-channel contract.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// Capture the object passed to `contextBridge.exposeInMainWorld`.
let exposedAPI: Record<string, Record<string, unknown>> | undefined;
const invokeMock = vi.fn();
const onMock = vi.fn();
const removeListenerMock = vi.fn();

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((_key: string, api: Record<string, Record<string, unknown>>) => {
      exposedAPI = api;
    }),
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => {
      invokeMock(...args);
      // Return a deterministic promise so callers' `.then(...)` chains do
      // not blow up with "Cannot read property of undefined".
      return Promise.resolve(undefined);
    },
    on: onMock,
    removeListener: removeListenerMock,
  },
}));

beforeAll(async () => {
  // Import for side effect — `preload.ts` invokes `exposeInMainWorld` at
  // module-load time.
  await import('../preload.js');
});

describe('preload bridge contract', () => {
  it('exposes the `app` namespace via contextBridge.exposeInMainWorld', () => {
    expect(exposedAPI).toBeDefined();
  });

  // Every namespace the renderer code consumes from `window.app.*`. If a new
  // namespace is added, append it here; if one is removed, delete from here
  // — the test stays in lockstep with the actual wire surface.
  const requiredNamespaces = [
    'config',
    'agent',
    'conversations',
    'workspaces',
    'memory',
    'mcp',
    'cliTools',
    'skills',
    'plugins',
    'realtime',
    'dialog',
    'clipboard',
    'image',
    'shell',
    'platform',
    'webServer',
    'fs',
    'plans',
    'tasks',
    'agents',
    'computerUse',
    'mic',
    'usage',
    'autoUpdate',
    'partitions',
    'debug',
    'dictation',
  ] as const;

  it.each(requiredNamespaces)('exposes the `%s` namespace', (ns) => {
    expect(exposedAPI?.[ns]).toBeDefined();
    expect(typeof exposedAPI?.[ns]).toBe('object');
  });

  // Spot-check a handful of namespace methods the renderer hot-path depends
  // on. Picked one method per namespace whose name is unique enough that
  // the assertion catches a typo/rename without being overly brittle.
  const namespaceMethodChecks: Array<{ ns: keyof typeof exposedAPIShape; methods: string[] }> = [
    { ns: 'config', methods: ['get', 'set', 'onChanged'] },
    { ns: 'agent', methods: ['stream', 'cancelStream', 'approveToolCall', 'rejectToolCall', 'onStreamEvent'] },
    { ns: 'conversations', methods: ['list', 'get', 'put', 'delete', 'getActiveId', 'setActiveId'] },
    { ns: 'workspaces', methods: ['create', 'rename', 'delete', 'setActive'] },
    { ns: 'memory', methods: ['clear', 'testEmbedding'] },
    { ns: 'mcp', methods: ['testConnection'] },
    { ns: 'plugins', methods: ['pause', 'resume', 'kill', 'disable', 'enable'] },
    { ns: 'dialog', methods: [] },
  ];

  it.each(namespaceMethodChecks)('`$ns` namespace exposes the methods consumer code reads', ({ ns, methods }) => {
    const namespace = exposedAPI?.[ns];
    expect(namespace).toBeDefined();
    for (const method of methods) {
      expect(typeof namespace?.[method]).toBe('function');
    }
  });

  it('config.get() routes through ipcRenderer.invoke with the `config:get` channel', async () => {
    invokeMock.mockClear();
    const configNs = exposedAPI?.config as { get: () => Promise<unknown> };
    await configNs.get();
    expect(invokeMock).toHaveBeenCalledWith('config:get');
  });

  it('conversations.put(...) passes the channel name plus payload through invoke', async () => {
    invokeMock.mockClear();
    const conversationsNs = exposedAPI?.conversations as {
      put: (c: unknown) => Promise<unknown>;
    };
    const payload = { id: 'c1', title: 't' };
    await conversationsNs.put(payload);
    expect(invokeMock).toHaveBeenCalledWith('conversations:put', payload);
  });

  it('config.onChanged subscribes via ipcRenderer.on and returns an unsubscribe', () => {
    onMock.mockClear();
    removeListenerMock.mockClear();
    const configNs = exposedAPI?.config as {
      onChanged: (cb: (c: unknown) => void) => () => void;
    };
    const cb = vi.fn();
    const unsubscribe = configNs.onChanged(cb);

    expect(onMock).toHaveBeenCalledWith('config:changed', expect.any(Function));
    expect(typeof unsubscribe).toBe('function');

    unsubscribe();
    expect(removeListenerMock).toHaveBeenCalledWith('config:changed', expect.any(Function));
  });

  it.each([
    ['pause', 'plugin:pause'],
    ['resume', 'plugin:resume'],
    ['kill', 'plugin:kill'],
  ] as const)('plugins.%s routes through the matching control channel', async (method, channel) => {
    invokeMock.mockClear();
    const pluginsNs = exposedAPI?.plugins as Record<string, (pluginName: string) => Promise<unknown>>;
    await pluginsNs[method]('fixture-plugin');
    expect(invokeMock).toHaveBeenCalledWith(channel, 'fixture-plugin');
  });
});

// Local shape map — keyof drives the `it.each` type narrowing above.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used as a type via keyof
const exposedAPIShape = {
  config: 1,
  agent: 1,
  conversations: 1,
  workspaces: 1,
  memory: 1,
  mcp: 1,
  plugins: 1,
  dialog: 1,
} as const;

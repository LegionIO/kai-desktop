import { describe, expect, it, vi } from 'vitest';
import type { PluginAPI, PluginManifest } from '../../types.js';

vi.mock('electron', () => ({
  app: { getAppMetrics: () => [] },
  utilityProcess: { fork: vi.fn() },
}));

import { PluginProcessHost } from '../plugin-process-host.js';

type HostInternals = {
  child: { postMessage: (message: unknown) => void } | null;
  invokeChildStream: (callbackId: string, args: unknown[]) => AsyncGenerator<unknown>;
  inboundStreams: Map<number, unknown>;
  mainFunctions: Map<string, unknown>;
};

describe('PluginProcessHost callback streams', () => {
  it('releases stream bookkeeping and encoded callbacks when posting fails', async () => {
    const manifest: PluginManifest = {
      name: 'post-failure-fixture',
      displayName: 'Post failure fixture',
      version: '1.0.0',
      description: 'Exercises synchronous post failures',
      permissions: [],
    };
    const host = new PluginProcessHost({
      manifest,
      pluginDir: '/tmp/plugin',
      backendPath: '/tmp/plugin/backend.js',
      backendHash: '0'.repeat(64),
      api: {} as PluginAPI,
      utilityEntryPath: '/tmp/plugin-host.js',
      syncWorkerPath: '/tmp/plugin-sync-worker.js',
      onUnexpectedExit: vi.fn(),
    });
    const internals = host as unknown as HostInternals;
    internals.child = {
      postMessage: () => {
        throw new Error('post failed');
      },
    };

    expect(() => internals.invokeChildStream('fixture', [() => 'callback'])).toThrow('post failed');
    expect(internals.inboundStreams.size).toBe(0);
    expect(internals.mainFunctions.size).toBe(0);
    internals.child = null;
    await host.stop(true);
  });
});

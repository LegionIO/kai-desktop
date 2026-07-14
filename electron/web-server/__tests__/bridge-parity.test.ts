/**
 * Web-bridge ↔ preload parity.
 *
 * The renderer is the same bundle whether it runs in Electron (where
 * `window.app` comes from preload.ts via contextBridge) or in a browser tab
 * served by the web server (where `window.app` is the inline bridge script
 * from getBridgeScript()). Any method added to preload's `app.plugins` that
 * the renderer calls unconditionally will throw `... is not a function` in
 * web mode unless the bridge script keeps pace.
 *
 * Regression: `app.plugins.getAvailableUpdateCount` landed in preload but
 * not the web shim, crashing the web UI on mount.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { runInNewContext } from 'node:vm';
import type * as NodeOs from 'node:os';

let preloadAPI: Record<string, unknown> | undefined;

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
      preloadAPI = api;
    },
  },
  ipcRenderer: {
    invoke: () => Promise.resolve(undefined),
    on: () => {},
    removeListener: () => {},
    send: () => {},
  },
}));

// web-server.ts touches ~/.<slug>/data at module load; redirect to tmpdir.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('os');
  return { ...actual, homedir: () => actual.tmpdir() };
});
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return { ...actual, homedir: () => actual.tmpdir() };
});

// Avoid pulling node-forge / IPC registry into the test graph.
vi.mock('../self-signed.js', () => ({ ensureSelfSignedCert: () => ({ cert: '', key: '' }) }));
vi.mock('../ipc-bridge.js', () => ({ invokeHandler: async () => undefined }));

let getBridgeScript: () => string;

beforeAll(async () => {
  await import('../../preload.js');
  ({ getBridgeScript } = await import('../web-server.js'));
});

function evalBridgeScript(): Record<string, unknown> {
  const html = getBridgeScript();
  const body = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
  const sandbox = {
    window: {} as Record<string, unknown>,
    location: { protocol: 'https:', host: 'localhost' },
    navigator: { clipboard: { writeText: () => {} } },
    WebSocket: class {
      static OPEN = 1;
      readyState = 0;
      send() {}
      close() {}
    },
    setTimeout: () => 0,
    console,
  };
  runInNewContext(body, sandbox);
  return sandbox.window.app as Record<string, unknown>;
}

describe('web bridge ↔ preload parity', () => {
  // Namespaces required to be a full method-level mirror of preload. Other
  // namespaces (dialog, mic, image…) are intentionally degraded in web mode.
  const fullMirrorNamespaces = [
    'plugins',
    'tasks',
    'agents',
    'workspaces',
    'shell',
    'partitions',
    'cli',
    'autoUpdate',
    'dictation',
    'appshots',
    'alerts',
  ] as const;

  it.each(fullMirrorNamespaces)('web shim `app.%s` exposes every method preload does', (ns) => {
    expect(preloadAPI).toBeDefined();
    const webApp = evalBridgeScript();

    const preloadNs = preloadAPI![ns] as Record<string, unknown>;
    const webNs = webApp[ns] as Record<string, unknown> | undefined;
    expect(webNs).toBeDefined();

    const preloadKeys = Object.keys(preloadNs).filter((k) => typeof preloadNs[k] === 'function');
    const missing = preloadKeys.filter((k) => typeof webNs![k] !== 'function');
    expect(missing).toEqual([]);
  });

  it('web shim `app.plugins.getAvailableUpdateCount` is callable', () => {
    const webApp = evalBridgeScript();
    const plugins = webApp.plugins as Record<string, unknown>;
    expect(typeof plugins.getAvailableUpdateCount).toBe('function');
    expect(typeof plugins.onUpdatesAvailable).toBe('function');
  });
});

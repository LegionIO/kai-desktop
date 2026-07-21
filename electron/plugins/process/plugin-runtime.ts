import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { PluginManifest, PluginModule } from '../types.js';
import type { PluginMessagePort } from './message-port.js';
import { createUtilityConfigMirror, createUtilityPluginAPI } from './utility-api.js';
import { UtilityTransport, type SyncBridgeInit } from './utility-transport.js';
import { installZodWireCodec, isZodWireCodecLoaded, serializeWireError } from './wire.js';

export const PLUGIN_PROCESS_PROTOCOL_VERSION = 3;

export type PluginRuntimeInit = {
  type: 'init';
  protocolVersion: number;
  manifest: PluginManifest;
  pluginDir: string;
  backendPath: string;
  fileHash: string;
  apiVersion: string;
  capabilities: string[];
  initialConfig: Record<string, unknown>;
  initialPluginData: Record<string, unknown>;
  syncBridge: SyncBridgeInit;
};

export type PluginRuntimeOptions = {
  parentPort: PluginMessagePort;
  init: PluginRuntimeInit;
  fetchImpl?: typeof globalThis.fetch;
  createFetchImpl?: (transport: UtilityTransport) => typeof globalThis.fetch;
};

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function installFatalErrorReporting(parentPort: PluginMessagePort): void {
  process.on('uncaughtExceptionMonitor', (error) => {
    try {
      parentPort.postMessage({ type: 'diagnostic', kind: 'uncaughtException', error: formatError(error) });
    } catch {
      // The process is already failing; never mask the original exception.
    }
  });

  process.on('unhandledRejection', (reason) => {
    try {
      parentPort.postMessage({ type: 'diagnostic', kind: 'unhandledRejection', error: formatError(reason) });
    } finally {
      // An unhandled rejection invalidates the plugin activation just like an
      // uncaught exception. Only this plugin host is terminated.
      process.exitCode = 1;
      setImmediate(() => process.exit(1));
    }
  });
}

async function verifyBackend(init: PluginRuntimeInit): Promise<void> {
  const bytes = await readFile(init.backendPath);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== init.fileHash) {
    throw new Error(`Plugin "${init.manifest.name}" backend changed after integrity verification`);
  }
}

/**
 * Run one plugin using the production compatibility transport. This module has
 * no Electron imports, so it is shared byte-for-byte by the Electron utility
 * entry point and the lighter Node SEA host.
 */
export async function runPluginRuntime(options: PluginRuntimeOptions): Promise<void> {
  const { parentPort, init } = options;
  if (init.protocolVersion !== PLUGIN_PROCESS_PROTOCOL_VERSION) {
    throw new Error(
      `Plugin process protocol mismatch: host=${init.protocolVersion}, runtime=${PLUGIN_PROCESS_PROTOCOL_VERSION}`,
    );
  }

  installFatalErrorReporting(parentPort);
  process.title = `Kai Plugin: ${init.manifest.name}`;

  const transport = new UtilityTransport(parentPort);
  transport.configureSyncBridge(init.syncBridge);
  const fetchImpl = options.fetchImpl ?? options.createFetchImpl?.(transport) ?? globalThis.fetch;
  const configMirror = createUtilityConfigMirror(init.initialConfig, init.initialPluginData);
  let pluginModule: PluginModule | null = null;

  const reportResourceUsage = (): void => {
    try {
      parentPort.postMessage({
        type: 'resource-usage',
        syncWorkerRunning: transport.hasSyncWorker,
        zodCodecLoaded: isZodWireCodecLoaded(),
      });
    } catch {
      // Metrics are best-effort and must never affect plugin functionality.
    }
  };

  transport.setSyncWorkerStateChangeHandler(reportResourceUsage);

  try {
    await verifyBackend(init);
    if (init.manifest.permissions.includes('tools:register')) {
      const { zodWireCodec } = await import('./zod-wire-codec.js');
      installZodWireCodec(zodWireCodec);
    }
    const api = createUtilityPluginAPI({
      manifest: init.manifest,
      pluginDir: init.pluginDir,
      apiVersion: init.apiVersion,
      capabilities: init.capabilities,
      transport,
      configMirror,
      fetchImpl,
    });

    transport.setControlHandler(async (command, args) => {
      if (command === 'deactivate') {
        await pluginModule?.deactivate?.();
        return null;
      }
      if (command === 'config-changed') {
        configMirror.config = structuredClone((args[0] as Record<string, unknown>) ?? {});
        configMirror.pluginData = structuredClone((args[1] as Record<string, unknown>) ?? {});
        pluginModule?.onConfigChanged?.(args[0] as never);
        return null;
      }
      if (command === 'plugin-config-changed') {
        configMirror.pluginData = structuredClone((args[0] as Record<string, unknown>) ?? {});
        return null;
      }
      throw new Error(`Unknown plugin process command: ${command}`);
    });

    const moduleUrl = `${pathToFileURL(init.backendPath).href}?v=${encodeURIComponent(init.fileHash)}`;
    pluginModule = (await import(moduleUrl)) as PluginModule;
    if (typeof pluginModule.activate !== 'function') {
      throw new Error(`Plugin "${init.manifest.name}" does not export activate(api)`);
    }
    await pluginModule.activate(api);
    await transport.flush();
    reportResourceUsage();
    parentPort.postMessage({ type: 'activated' });
  } catch (error) {
    parentPort.postMessage({ type: 'activation-error', error: serializeWireError(error) });
  }
}

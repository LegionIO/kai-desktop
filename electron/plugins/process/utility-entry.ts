import { pathToFileURL } from 'node:url';
import type { PluginManifest, PluginModule } from '../types.js';
import { createUtilityConfigMirror, createUtilityPluginAPI } from './utility-api.js';
import { UtilityTransport, type SyncBridgeInit } from './utility-transport.js';
import { installZodWireCodec, isZodWireCodecLoaded, serializeWireError } from './wire.js';

type InitMessage = {
  type: 'init';
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

const parentPort = process.parentPort;
if (!parentPort) throw new Error('Plugin utility process was started without an Electron parent port');

function waitForInit(): Promise<InitMessage> {
  return new Promise((resolve) => {
    const listener = (event: Electron.MessageEvent) => {
      const message = event.data as InitMessage;
      if (message?.type !== 'init') return;
      parentPort.off('message', listener);
      resolve(message);
    };
    parentPort.on('message', listener);
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

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
    // uncaught exception. Terminating only this utility process contains it.
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  }
});

const init = await waitForInit();
process.title = `Kai Plugin: ${init.manifest.name}`;

const transport = new UtilityTransport(parentPort);
transport.configureSyncBridge(init.syncBridge);
const configMirror = createUtilityConfigMirror(init.initialConfig, init.initialPluginData);
let pluginModule: PluginModule | null = null;

function reportResourceUsage(): void {
  try {
    parentPort.postMessage({
      type: 'resource-usage',
      syncWorkerRunning: transport.hasSyncWorker,
      zodCodecLoaded: isZodWireCodecLoaded(),
    });
  } catch {
    // Metrics are best-effort and must never affect plugin functionality.
  }
}

transport.setSyncWorkerStateChangeHandler(reportResourceUsage);

try {
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

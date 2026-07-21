import { net } from 'electron';
import type { PluginMessagePort } from './message-port.js';
import { runPluginRuntime, type PluginRuntimeInit } from './plugin-runtime.js';

const electronParentPort = process.parentPort;
if (!electronParentPort) throw new Error('Plugin utility process was started without an Electron parent port');
const parentPort = electronParentPort as PluginMessagePort;

function waitForInit(): Promise<PluginRuntimeInit> {
  return new Promise((resolve) => {
    const listener = (event: { data: unknown }) => {
      const message = event.data as PluginRuntimeInit;
      if (message?.type !== 'init') return;
      parentPort.off('message', listener);
      resolve(message);
    };
    parentPort.on('message', listener);
  });
}

const init = await waitForInit();
await runPluginRuntime({
  parentPort,
  init,
  fetchImpl: ((input, options) =>
    net.fetch(input instanceof URL ? input.toString() : input, options)) as typeof globalThis.fetch,
});

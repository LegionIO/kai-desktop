/**
 * Runtime smoke test for the real Electron utility-process boundary. Run after
 * `pnpm build`; the host class is bundled separately by the verification
 * command so this test exercises the same source used by the app.
 */
import { app } from 'electron';
import { resolve } from 'node:path';
import {
  PluginProcessHost,
  getPluginProcessMetrics,
  refreshPluginProcessPrivateMemory,
} from '../out/plugin-process-smoke-host.mjs';

console.info('Starting plugin utility-process smoke verification…');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function setNested(target, path, value) {
  const parts = path.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) current = current[part] ?? (current[part] = {});
  current[parts.at(-1)] = value;
}

function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now();
  return new Promise((resolveWait, reject) => {
    const poll = () => {
      if (predicate()) return resolveWait();
      if (Date.now() - started > timeoutMs) return reject(new Error('Timed out waiting for plugin callback'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

async function run() {
  console.info('Electron ready; starting fixture plugin process…');

  const captured = {
    state: {},
    tools: [],
    configListeners: [],
    eventListeners: [],
    preSendHooks: [],
    preUpdateHooks: [],
    agentHooks: [],
    actions: new Map(),
    provider: null,
    progress: [],
    cookiePromotion: null,
    httpHandler: null,
    httpClosed: false,
    authNavigate: null,
    authVisibility: [],
  };

  const api = {
    host: {
      apiVersion: () => '1.0.0',
      capabilities: () => ['events:publish', 'agent:inference-provider'],
      hasCapability: () => true,
    },
    config: {
      get: () => ({ ui: { theme: 'dark' } }),
      set: () => {},
      getPluginData: () => ({ seed: 7 }),
      setPluginData: () => {},
      onChanged: (listener) => {
        captured.configListeners.push(listener);
        return () => captured.configListeners.splice(captured.configListeners.indexOf(listener), 1);
      },
    },
    state: {
      get: () => structuredClone(captured.state),
      replace: (next) => {
        captured.state = structuredClone(next);
      },
      set: (path, value) => setNested(captured.state, path, structuredClone(value)),
      emitEvent: () => {},
    },
    events: {
      declare: () => {},
      emit: () => {},
      on: (_key, listener) => {
        captured.eventListeners.push(listener);
        return () => captured.eventListeners.splice(captured.eventListeners.indexOf(listener), 1);
      },
    },
    tools: {
      register: (tools) => captured.tools.push(...tools),
      unregister: () => {},
    },
    messages: {
      registerPreSendHook: (hook) => captured.preSendHooks.push(hook),
      registerPostReceiveHook: () => {},
    },
    lifecycle: {
      registerPreUpdateHook: (hook) => captured.preUpdateHooks.push(hook),
      registerPostUpdateHook: () => {},
    },
    hooks: {
      register: (_event, hook) => {
        captured.agentHooks.push(hook);
        return () => {};
      },
    },
    ui: {
      showBanner: () => {},
      hideBanner: () => {},
      showModal: () => {},
      hideModal: () => {},
      updateModal: () => {},
      registerSettingsView: () => {},
      registerPanelView: () => {},
      registerNavigationItem: () => {},
      registerCommand: () => {},
      showConversationDecoration: () => {},
      hideConversationDecoration: () => {},
      showThreadDecoration: () => {},
      hideThreadDecoration: () => {},
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => `cipher:${value}`,
      decryptString: (value) => value.replace(/^cipher:/, ''),
    },
    browser: {
      open: (options) => {
        captured.cookiePromotion = options.cookiePromotion;
      },
    },
    http: {
      listen: async (_port, handler) => {
        captured.httpHandler = handler;
      },
      close: async () => {
        captured.httpClosed = true;
      },
    },
    auth: {
      openAuthWindow: async (options) => {
        await options.onReady?.({
          executeJavaScript: async (code) => Number(code),
          getURL: () => 'https://example.test/current',
          onDidNavigate: (callback) => {
            captured.authNavigate = callback;
          },
          show: () => captured.authVisibility.push('show'),
          hide: () => captured.authVisibility.push('hide'),
          close: () => captured.authVisibility.push('close'),
        });
        await captured.authNavigate?.('https://example.test/callback');
        return { success: true, params: { token: 'fixture' } };
      },
    },
    agent: {
      generate: async (options) => {
        if (options.abortSignal) {
          if (!options.abortSignal.aborted) {
            await new Promise((resolveAbort) => options.abortSignal.addEventListener('abort', resolveAbort, { once: true }));
          }
          return { text: String(options.abortSignal.reason), modelKey: 'fixture', toolCalls: [] };
        }
        return { text: 'generated', modelKey: 'fixture', toolCalls: [] };
      },
      stream: async function* () {
        yield { conversationId: 'fixture', type: 'text-delta', text: 'stream' };
        yield { conversationId: 'fixture', type: 'done' };
      },
      registerInferenceProvider: (provider) => {
        captured.provider = provider;
      },
      unregisterInferenceProvider: () => {
        captured.provider = null;
      },
      registerCliTool: () => {},
    },
    onAction: (targetId, handler) => captured.actions.set(targetId, handler),
  };

  const manifest = {
    name: 'process-smoke',
    displayName: 'Process Smoke',
    version: '1.0.0',
    description: 'Utility process smoke fixture',
    permissions: [
      'config:read',
      'config:write',
      'state:publish',
      'ui:panel',
      'events:subscribe',
      'tools:register',
      'messages:hook',
      'lifecycle:hook',
      'agent:hook',
      'agent:generate',
      'agent:inference-provider',
      'safe-storage',
      'browser:window',
      'http:listen',
      'auth:window',
    ],
  };

  const host = new PluginProcessHost({
    manifest,
    pluginDir: resolve('electron/plugins/process/__fixtures__'),
    backendPath: resolve('electron/plugins/process/__fixtures__/compat-plugin.js'),
    fileHash: 'smoke',
    api,
    utilityEntryPath: resolve('out/main/plugin-host.js'),
    syncWorkerPath: resolve('out/main/plugin-sync-worker.js'),
    onUnexpectedExit: ({ code, error }) => {
      throw new Error(`Smoke plugin exited unexpectedly (${code}): ${error ?? ''}`);
    },
  });

  try {
    await host.activate();
    assert(captured.state.activated === true, 'activation state did not cross the synchronous broker');
    assert(captured.tools.length === 2, 'tool registration did not reach the main process');
    assert(captured.actions.has('fixture'), 'action registration did not reach the main process');
    const persistentMainFunctions = host.mainFunctions.size;
    const cookieDecision = await captured.cookiePromotion({
      domain: '.example.test',
      name: 'session',
      path: '/',
      secure: true,
      httpOnly: true,
    });
    assert(cookieDecision.promote === true && cookieDecision.ttlDays === 2, 'cookie callback proxy failed');
    const httpResult = await captured.httpHandler({ method: 'POST', url: '/callback', headers: {}, query: {}, body: 'ok' });
    assert(httpResult.status === 201 && httpResult.body === 'POST:/callback:ok', 'HTTP handler proxy failed');

    await captured.configListeners[0]({});
    await captured.eventListeners[0]({ source: 'fixture', event: 'event', key: 'fixture:event' });
    const toolResult = await captured.tools[0].execute(
      { value: 'echoed' },
      { toolCallId: 'tool-1', onProgress: (event) => captured.progress.push(event) },
    );
    assert(toolResult.echoed === 'echoed', 'tool callback result did not return from the utility process');
    assert(toolResult.configChanges === 1 && toolResult.eventCount === 1, 'main-to-plugin callbacks lost state');
    assert(captured.progress.length === 1, 'tool progress callback did not cross back to the main process');

    const abortController = new AbortController();
    const abortResultPromise = captured.tools[1].execute(
      {},
      { toolCallId: 'tool-abort', abortSignal: abortController.signal },
    );
    abortController.abort('main-abort');
    const abortResult = await abortResultPromise;
    assert(abortResult.aborted === true && abortResult.reason === 'main-abort', 'tool abort signal did not propagate');

    const preSend = await captured.preSendHooks[0]({ messages: [], modelKey: 'fixture', config: {} });
    assert(preSend.systemPrompt === '|fixture', 'message hook callback failed');
    const preUpdate = await captured.preUpdateHooks[0]({ version: 'blocked', artifactPath: '/tmp/update' });
    assert(preUpdate.abort === true, 'lifecycle hook callback failed');

    const action = await captured.actions.get('fixture')('run', 'hello');
    assert(action.data.generated === 'generated', 'async plugin agent.generate proxy failed');
    assert(action.data.streamed.join(',') === 'text-delta,done', 'async generator proxy failed');
    assert(action.data.decrypted === 'secret', 'synchronous safeStorage compatibility failed');
    const reverseAbortAction = await captured.actions.get('fixture')('run', 'abort-test');
    assert(reverseAbortAction.data.generated === 'utility-abort', 'reverse abort signal did not propagate');
    const authAction = await captured.actions.get('fixture')('run', 'auth-test');
    assert(authAction.data.auth.success === true, 'auth window result proxy failed');
    assert(authAction.data.state.authExecuted === 42, 'async auth helper Promise semantics failed');
    assert(authAction.data.state.authUrl === 'https://example.test/current', 'synchronous auth helper proxy failed');
    assert(authAction.data.state.authNavigate === 'https://example.test/callback', 'nested auth callback proxy failed');
    assert(captured.authVisibility.join(',') === 'hide,show', 'auth helper controls did not reach main');
    assert(host.mainFunctions.size === persistentMainFunctions, 'ephemeral callback references leaked in main');
    assert(host.remoteAbortControllers.size === 0, 'completed abort-signal proxies leaked in main');

    assert(captured.provider?.isAvailable() === true, 'inference provider availability was not registered');
    const providerEvents = [];
    for await (const event of captured.provider.stream({
      conversationId: 'provider-test',
      messages: [],
      systemPrompt: '',
      tools: [
        {
          name: 'provider_tool',
          description: 'Verify an async main callback retains Promise semantics.',
          inputSchema: { type: 'object' },
          execute: async ({ value }) => value + 1,
        },
      ],
    })) providerEvents.push(event);
    assert(providerEvents.map((event) => event.type).join(',') === 'text-delta,done', 'provider stream proxy failed');
    assert(providerEvents[0].data.toolValue === 42, 'async callback Promise semantics were not preserved');

    host.notifyConfigChanged({});
    await waitFor(() => captured.state.moduleConfigChanged === true);

    await refreshPluginProcessPrivateMemory(true);
    const metric = getPluginProcessMetrics().find((entry) => entry.pluginName === manifest.name);
    assert(metric?.pid && metric.status === 'running', 'plugin process metrics were not attributed to the plugin');
    assert(metric.privateMemoryBytes > 0, 'plugin private/physical footprint was not reported by the utility');
    assert(metric.memorySource === 'private', 'plugin footprint did not take priority over RSS');
    assert(metric.syncWorkerRunning === true, 'a true synchronous API did not start the bridge worker');
    assert(metric.zodCodecLoaded === true, 'schema-capable plugin did not load the Zod transport chunk');

    const workerlessManifest = {
      name: 'process-workerless-smoke',
      displayName: 'Process Workerless Smoke',
      version: '1.0.0',
      description: 'Mirrored config and registration-only fixture',
      permissions: ['config:read', 'config:write', 'state:publish', 'events:publish', 'ui:settings', 'ui:modal'],
    };
    const workerlessHost = new PluginProcessHost({
      manifest: workerlessManifest,
      pluginDir: resolve('electron/plugins/process/__fixtures__'),
      backendPath: resolve('electron/plugins/process/__fixtures__/workerless-plugin.js'),
      fileHash: 'workerless-smoke',
      api,
      utilityEntryPath: resolve('out/main/plugin-host.js'),
      syncWorkerPath: resolve('out/main/plugin-sync-worker.js'),
      onUnexpectedExit: ({ code, error }) => {
        throw new Error(`Workerless plugin exited unexpectedly (${code}): ${error ?? ''}`);
      },
    });
    await workerlessHost.activate();
    assert(captured.state.workerlessActivated === true, 'workerless ordered state write was not flushed');
    assert(captured.actions.has('workerless'), 'workerless action registration was not flushed');
    const workerlessAction = await captured.actions.get('workerless')('read');
    assert(workerlessAction.data.theme === 'light', 'mirrored config did not preserve read-after-write');
    assert(workerlessAction.data.count === 8, 'mirrored plugin config did not preserve read-after-write');
    await refreshPluginProcessPrivateMemory(true);
    const workerlessMetric = getPluginProcessMetrics().find(
      (entry) => entry.pluginName === workerlessManifest.name,
    );
    assert(workerlessMetric?.privateMemoryBytes > 0, 'workerless utility did not report its footprint');
    assert(workerlessMetric.syncWorkerRunning === false, 'mirrored/registration APIs eagerly started the sync worker');
    assert(workerlessMetric.zodCodecLoaded === false, 'plugin without tools loaded the Zod transport chunk');
    console.info(
      `Workerless footprint ${(workerlessMetric.privateMemoryBytes / 1024 / 1024).toFixed(1)} MB; ` +
        `full fixture ${(metric.privateMemoryBytes / 1024 / 1024).toFixed(1)} MB`,
    );
    await workerlessHost.deactivate();

    host.pause();
    assert(
      getPluginProcessMetrics().find((entry) => entry.pluginName === manifest.name)?.status === 'paused',
      'plugin process pause was not reflected in diagnostics',
    );
    let pausedCallRejected = false;
    try {
      await captured.tools[0].execute({ value: 'paused' }, { toolCallId: 'tool-paused' });
    } catch (error) {
      pausedCallRejected = /paused/i.test(String(error));
    }
    assert(pausedCallRejected, 'a paused plugin left a new main-process callback waiting');
    host.resume();
    assert(
      getPluginProcessMetrics().find((entry) => entry.pluginName === manifest.name)?.status === 'running',
      'plugin process resume was not reflected in diagnostics',
    );

    await host.deactivate();
    assert(captured.httpClosed, 'plugin HTTP server cleanup did not run during deactivation');
    assert(
      getPluginProcessMetrics().every((entry) => entry.pluginName !== manifest.name),
      'process metric leaked after stop',
    );

    let crashDetails = null;
    const crashManifest = { ...manifest, name: 'process-crash-smoke', displayName: 'Process Crash Smoke' };
    const crashHost = new PluginProcessHost({
      manifest: crashManifest,
      pluginDir: resolve('electron/plugins/process/__fixtures__'),
      backendPath: resolve('electron/plugins/process/__fixtures__/crash-plugin.js'),
      fileHash: 'crash-smoke',
      api,
      utilityEntryPath: resolve('out/main/plugin-host.js'),
      syncWorkerPath: resolve('out/main/plugin-sync-worker.js'),
      onUnexpectedExit: (details) => {
        crashDetails = details;
      },
    });
    await crashHost.activate();
    await captured.actions.get('crash')('run');
    await waitFor(() => crashDetails !== null);
    assert(crashDetails.code === 23, 'utility process crash exit code was not attributed');
    const crashedMetric = getPluginProcessMetrics().find((entry) => entry.pluginName === crashManifest.name);
    assert(crashedMetric?.status === 'crashed' && crashedMetric.crashCount === 1, 'crash metric was not retained');
    assert(crashedMetric.pid === null, 'an exited PID remained eligible for resource attribution');
    assert(crashHost.server === null && crashHost.outputTimers.length === 0, 'crashed host resources were retained');
    await crashHost.stop(true);

    let floodContained = false;
    const floodManifest = { ...manifest, name: 'process-flood-smoke', displayName: 'Process Flood Smoke' };
    const floodHost = new PluginProcessHost({
      manifest: floodManifest,
      pluginDir: resolve('electron/plugins/process/__fixtures__'),
      backendPath: resolve('electron/plugins/process/__fixtures__/flood-plugin.js'),
      fileHash: 'flood-smoke',
      api,
      utilityEntryPath: resolve('out/main/plugin-host.js'),
      syncWorkerPath: resolve('out/main/plugin-sync-worker.js'),
      onUnexpectedExit: () => {
        floodContained = true;
      },
    });
    await floodHost.activate();
    await captured.actions.get('flood')('run').catch(() => {});
    await waitFor(() => floodContained, 5_000);
    const floodMetric = getPluginProcessMetrics().find((entry) => entry.pluginName === floodManifest.name);
    assert(floodMetric?.status === 'crashed', 'IPC flood did not remain isolated to its plugin process');
    assert(floodMetric.lastError?.includes('IPC messages per second'), 'IPC flood reason was not retained');
    await floodHost.stop(true);

    let killed = false;
    const killManifest = { ...manifest, name: 'process-kill-smoke', displayName: 'Process Kill Smoke' };
    const killHost = new PluginProcessHost({
      manifest: killManifest,
      pluginDir: resolve('electron/plugins/process/__fixtures__'),
      backendPath: resolve('electron/plugins/process/__fixtures__/crash-plugin.js'),
      fileHash: 'kill-smoke',
      api,
      utilityEntryPath: resolve('out/main/plugin-host.js'),
      syncWorkerPath: resolve('out/main/plugin-sync-worker.js'),
      onUnexpectedExit: () => {
        killed = true;
      },
    });
    await killHost.activate();
    await killHost.kill();
    assert(killed, 'host kill did not run isolated-process cleanup');
    assert(
      getPluginProcessMetrics().find((entry) => entry.pluginName === killManifest.name)?.status === 'crashed',
      'host kill was not reflected in diagnostics',
    );
    await killHost.stop(true);

    console.info('Plugin utility-process smoke verification passed.');
    app.quit();
  } catch (error) {
    await host.stop(true).catch(() => {});
    console.error(error);
    app.exit(1);
  }
}

app
  .whenReady()
  .then(run)
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

/**
 * Runtime smoke test for the real Electron utility-process boundary. Run after
 * `pnpm build`; the host class is bundled separately by the verification
 * command so this test exercises the same source used by the app.
 */
import { app } from 'electron';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  PluginProcessHost,
  getPluginProcessMetrics,
  refreshPluginProcessPrivateMemory,
} from '../out/plugin-process-smoke-host.mjs';

const seaHostPath = process.env.KAI_PLUGIN_SEA_HOST ? resolve(process.env.KAI_PLUGIN_SEA_HOST) : null;
const pluginProcessProtocolVersion = JSON.parse(
  readFileSync(resolve('package.json'), 'utf8'),
).pluginProcessProtocolVersion;
const runtimeOptions = seaHostPath
  ? { runtime: 'node-sea', seaHostPath, runtimeReason: 'real-process SEA smoke' }
  : { runtime: 'electron-utility', runtimeReason: 'real-process Electron smoke' };

console.info(`Starting plugin ${seaHostPath ? 'Node SEA' : 'Electron utility-process'} smoke verification…`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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

async function verifySeaRejectsUnauthenticatedControlPeer() {
  if (!seaHostPath) return;
  console.info('Verifying SEA control-channel server authentication…');
  let helloReceived = false;
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      const hello = JSON.parse(buffered.slice(0, newline));
      helloReceived = hello.type === 'hello' && hello.channel === 'control';
      socket.end(`${JSON.stringify({ type: 'ready', tokenProof: '0'.repeat(64) })}\n`);
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'could not bind fake SEA control server');
  const backendPath = resolve('electron/plugins/process/__fixtures__/workerless-plugin.js');
  const child = spawn(seaHostPath, [], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdin.end(
    `${JSON.stringify({
      type: 'init',
      protocolVersion: pluginProcessProtocolVersion,
      manifest: {
        name: 'sea-auth-smoke',
        displayName: 'SEA auth smoke',
        version: '1.0.0',
        description: 'Rejects a fake control server',
        permissions: [],
      },
      pluginDir: resolve('electron/plugins/process/__fixtures__'),
      backendPath,
      fileHash: hashFile(backendPath),
      apiVersion: '1.0.0',
      capabilities: [],
      initialConfig: {},
      initialPluginData: {},
      syncBridge: { host: '127.0.0.1', port: address.port, token: 'a'.repeat(64) },
    })}\n`,
  );
  const exitCode = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out waiting for SEA authentication rejection'));
    }, 5_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  }).finally(
    () =>
      new Promise((resolveClose) => {
        server.close(resolveClose);
      }),
  );
  assert(helloReceived, 'SEA host did not initiate its authenticated control handshake');
  assert(exitCode !== 0, 'SEA host trusted a control server without a valid HMAC proof');
  assert(/proof failed|authentication failed/i.test(stderr), 'SEA host did not report control authentication failure');
}

async function run() {
  console.info('Electron ready; starting fixture plugin process…');
  await verifySeaRejectsUnauthenticatedControlPeer();

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
    fetchRequests: [],
    fetchAbortObserved: false,
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
            await new Promise((resolveAbort) =>
              options.abortSignal.addEventListener('abort', resolveAbort, { once: true }),
            );
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
    fetch: async (input, init = {}) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://plugin-fetch.test/abort') {
        return new Promise((_resolve, reject) => {
          const abort = () => {
            captured.fetchAbortObserved = true;
            reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          };
          if (init.signal?.aborted) abort();
          else init.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      assert(url === 'https://plugin-fetch.test/stream', `unexpected brokered fetch URL: ${url}`);
      const requestChunks = [];
      if (init.body) {
        const reader = init.body.getReader();
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          requestChunks.push(new TextDecoder().decode(next.value));
        }
      }
      captured.fetchRequests.push({
        url,
        method: init.method,
        header: new Headers(init.headers).get('x-plugin-fetch'),
        chunks: requestChunks,
      });
      const responseChunks = ['streamed-', 'download'];
      const response = new Response(
        new ReadableStream({
          pull(controller) {
            const next = responseChunks.shift();
            if (next === undefined) controller.close();
            else controller.enqueue(new TextEncoder().encode(next));
          },
        }),
        { status: 206, headers: { 'x-main-fetch': 'fixture' } },
      );
      Object.defineProperties(response, {
        url: { value: 'https://plugin-fetch.test/final' },
        redirected: { value: true },
        type: { value: 'basic' },
      });
      return response;
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
      'network:fetch',
    ],
  };

  const host = new PluginProcessHost({
    ...runtimeOptions,
    manifest,
    pluginDir: resolve('electron/plugins/process/__fixtures__'),
    backendPath: resolve('electron/plugins/process/__fixtures__/compat-plugin.js'),
    backendHash: hashFile(resolve('electron/plugins/process/__fixtures__/compat-plugin.js')),
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
    const httpResult = await captured.httpHandler({
      method: 'POST',
      url: '/callback',
      headers: {},
      query: {},
      body: 'ok',
    });
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
    if (seaHostPath) {
      const fetchAction = await captured.actions.get('fixture')('run', 'fetch-test');
      assert(captured.fetchRequests.length === 1, 'SEA fetch did not reach the mocked main-process broker');
      assert(captured.fetchRequests[0].method === 'POST', 'SEA fetch method was not preserved');
      assert(captured.fetchRequests[0].header === 'fixture', 'SEA fetch request headers were not preserved');
      assert(captured.fetchRequests[0].chunks.join('') === 'streamed-upload', 'SEA fetch upload did not stream');
      assert(fetchAction.data.fetchResult.status === 206, 'SEA fetch response status was not preserved');
      assert(fetchAction.data.fetchResult.url === 'https://plugin-fetch.test/final', 'SEA fetch URL was not preserved');
      assert(fetchAction.data.fetchResult.redirected === true, 'SEA fetch redirect metadata was not preserved');
      assert(fetchAction.data.fetchResult.header === 'fixture', 'SEA fetch response headers were not preserved');
      assert(fetchAction.data.fetchResult.chunks.join('') === 'streamed-download', 'SEA fetch response did not stream');

      const fetchAbortAction = await captured.actions.get('fixture')('run', 'fetch-abort-test');
      assert(captured.fetchAbortObserved, 'SEA fetch abort did not reach the mocked main-process broker');
      assert(fetchAbortAction.data.fetchResult.aborted === true, 'SEA fetch abort did not reject in the plugin');
      assert(fetchAbortAction.data.fetchResult.reason === 'fixture-fetch-abort', 'SEA fetch abort reason was lost');
    }
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
          inputSchema: z.object({ value: z.number() }),
          execute: async ({ value }) => value + 1,
        },
      ],
    }))
      providerEvents.push(event);
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
    assert(metric.zodCodecLoaded === true, 'an inbound Zod schema did not load the optional decoder on demand');

    const workerlessManifest = {
      name: 'process-workerless-smoke',
      displayName: 'Process Workerless Smoke',
      version: '1.0.0',
      description: 'Mirrored config and registration-only fixture',
      permissions: ['config:read', 'config:write', 'state:publish', 'events:publish', 'ui:settings', 'ui:modal'],
    };
    const workerlessHost = new PluginProcessHost({
      ...runtimeOptions,
      manifest: workerlessManifest,
      pluginDir: resolve('electron/plugins/process/__fixtures__'),
      backendPath: resolve('electron/plugins/process/__fixtures__/workerless-plugin.js'),
      backendHash: hashFile(resolve('electron/plugins/process/__fixtures__/workerless-plugin.js')),
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
    const workerlessMetric = getPluginProcessMetrics().find((entry) => entry.pluginName === workerlessManifest.name);
    assert(workerlessMetric?.privateMemoryBytes > 0, 'workerless utility did not report its footprint');
    assert(workerlessMetric.syncWorkerRunning === false, 'mirrored/registration APIs eagerly started the sync worker');
    assert(workerlessMetric.zodCodecLoaded === false, 'plugin without tools loaded the Zod transport chunk');
    console.info(
      `Workerless footprint ${(workerlessMetric.privateMemoryBytes / 1024 / 1024).toFixed(1)} MB; ` +
        `full fixture ${(metric.privateMemoryBytes / 1024 / 1024).toFixed(1)} MB`,
    );
    await workerlessHost.deactivate();

    console.info('Verifying workerless JSON Schema and Zod tool registration…');
    const toolFixtures = [
      { name: 'idle-tools-smoke', backend: 'idle-plugin.js', expectedTools: 0 },
      { name: 'json-schema-tool-smoke', backend: 'json-schema-tool-plugin.js', expectedTools: 1 },
      { name: 'zod-tool-smoke', backend: 'zod-tool-plugin.js', expectedTools: 1 },
    ];
    const toolFootprints = [];
    for (const fixture of toolFixtures) {
      const toolManifest = {
        name: fixture.name,
        displayName: fixture.name,
        version: '1.0.0',
        description: 'Workerless tool registration fixture',
        permissions: ['tools:register'],
      };
      const backendPath = resolve('electron/plugins/process/__fixtures__', fixture.backend);
      const toolsBefore = captured.tools.length;
      const toolHost = new PluginProcessHost({
        ...runtimeOptions,
        manifest: toolManifest,
        pluginDir: resolve('electron/plugins/process/__fixtures__'),
        backendPath,
        backendHash: hashFile(backendPath),
        api,
        utilityEntryPath: resolve('out/main/plugin-host.js'),
        syncWorkerPath: resolve('out/main/plugin-sync-worker.js'),
        onUnexpectedExit: ({ code, error }) => {
          throw new Error(`Tool plugin ${fixture.name} exited unexpectedly (${code}): ${error ?? ''}`);
        },
      });
      await toolHost.activate();
      assert(
        captured.tools.length === toolsBefore + fixture.expectedTools,
        `${fixture.name} registered an unexpected number of tools`,
      );
      if (fixture.expectedTools > 0) {
        const registered = captured.tools.at(-1);
        const result = await registered.execute({ value: 'tool-ok' }, { toolCallId: `${fixture.name}-call` });
        assert(result.value === 'tool-ok', `${fixture.name} tool callback failed`);
        if (fixture.name === 'zod-tool-smoke') {
          let invalidRejected = false;
          try {
            await registered.execute({ value: 42 }, { toolCallId: `${fixture.name}-invalid` });
          } catch {
            invalidRejected = true;
          }
          assert(invalidRejected, 'Zod tool validation was not preserved across the process boundary');
        }
      }
      await refreshPluginProcessPrivateMemory(true);
      const toolMetric = getPluginProcessMetrics().find((entry) => entry.pluginName === fixture.name);
      assert(toolMetric?.privateMemoryBytes > 0, `${fixture.name} did not report its footprint`);
      assert(toolMetric.syncWorkerRunning === false, `${fixture.name} eagerly started the synchronous worker`);
      assert(toolMetric.zodCodecLoaded === false, `${fixture.name} loaded the optional inbound Zod decoder`);
      toolFootprints.push(`${fixture.name} ${(toolMetric.privateMemoryBytes / 1024 / 1024).toFixed(1)} MB`);
      await toolHost.deactivate();
    }
    console.info(`Tool-only footprints: ${toolFootprints.join('; ')}`);

    if (process.env.KAI_PLUGIN_SMOKE_BACKEND && process.env.KAI_PLUGIN_SMOKE_MANIFEST) {
      console.info('Verifying an unchanged external plugin backend…');
      const externalBackend = resolve(process.env.KAI_PLUGIN_SMOKE_BACKEND);
      const externalManifest = JSON.parse(readFileSync(resolve(process.env.KAI_PLUGIN_SMOKE_MANIFEST), 'utf8'));
      const externalHost = new PluginProcessHost({
        ...runtimeOptions,
        manifest: externalManifest,
        pluginDir: dirname(externalBackend),
        backendPath: externalBackend,
        backendHash: hashFile(externalBackend),
        api,
        utilityEntryPath: resolve('out/main/plugin-host.js'),
        syncWorkerPath: resolve('out/main/plugin-sync-worker.js'),
        onUnexpectedExit: ({ code, error }) => {
          throw new Error(`External plugin exited unexpectedly (${code}): ${error ?? ''}`);
        },
      });
      await externalHost.activate();
      await refreshPluginProcessPrivateMemory(true);
      const externalMetric = getPluginProcessMetrics().find((entry) => entry.pluginName === externalManifest.name);
      assert(externalMetric?.runtime === runtimeOptions.runtime, 'external plugin used the wrong runtime');
      console.info(
        `External plugin ${externalManifest.name} footprint ` +
          `${(externalMetric.privateMemoryBytes / 1024 / 1024).toFixed(1)} MB`,
      );
      await externalHost.deactivate();
    }

    console.info('Verifying pause/resume/deactivate controls…');
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
    console.info('Verifying crash isolation…');
    const crashManifest = { ...manifest, name: 'process-crash-smoke', displayName: 'Process Crash Smoke' };
    const crashHost = new PluginProcessHost({
      ...runtimeOptions,
      manifest: crashManifest,
      pluginDir: resolve('electron/plugins/process/__fixtures__'),
      backendPath: resolve('electron/plugins/process/__fixtures__/crash-plugin.js'),
      backendHash: hashFile(resolve('electron/plugins/process/__fixtures__/crash-plugin.js')),
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
    console.info('Verifying protocol-flood containment…');
    const floodManifest = { ...manifest, name: 'process-flood-smoke', displayName: 'Process Flood Smoke' };
    const floodHost = new PluginProcessHost({
      ...runtimeOptions,
      manifest: floodManifest,
      pluginDir: resolve('electron/plugins/process/__fixtures__'),
      backendPath: resolve('electron/plugins/process/__fixtures__/flood-plugin.js'),
      backendHash: hashFile(resolve('electron/plugins/process/__fixtures__/flood-plugin.js')),
      api,
      utilityEntryPath: resolve('out/main/plugin-host.js'),
      syncWorkerPath: resolve('out/main/plugin-sync-worker.js'),
      onUnexpectedExit: () => {
        floodContained = true;
      },
    });
    await floodHost.activate();
    await captured.actions
      .get('flood')('run')
      .catch(() => {});
    await waitFor(() => floodContained, 5_000);
    const floodMetric = getPluginProcessMetrics().find((entry) => entry.pluginName === floodManifest.name);
    assert(floodMetric?.status === 'crashed', 'IPC flood did not remain isolated to its plugin process');
    assert(floodMetric.lastError?.includes('exceeded'), 'IPC flood reason was not retained');
    await floodHost.stop(true);

    let killed = false;
    console.info('Verifying explicit kill containment…');
    const killManifest = { ...manifest, name: 'process-kill-smoke', displayName: 'Process Kill Smoke' };
    const killHost = new PluginProcessHost({
      ...runtimeOptions,
      manifest: killManifest,
      pluginDir: resolve('electron/plugins/process/__fixtures__'),
      backendPath: resolve('electron/plugins/process/__fixtures__/crash-plugin.js'),
      backendHash: hashFile(resolve('electron/plugins/process/__fixtures__/crash-plugin.js')),
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

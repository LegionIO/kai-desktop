'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { readFileSync, rmSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { connect } = require('node:net');
const { tmpdir } = require('node:os');
const { dirname, isAbsolute, join } = require('node:path');
const { getAsset, isSea } = require('node:sea');
const { pathToFileURL } = require('node:url');

const MAX_INIT_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const INIT_TIMEOUT_MS = 5_000;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

if (!isSea()) {
  process.stderr.write('kai-plugin-host must run from its SEA executable\n');
  process.exit(64);
}

// A SEA is an application, not a generic Node interpreter. Refuse all CLI
// input; initialization arrives through an inherited private stdin pipe.
if (process.argv.slice(2).length > 0) {
  process.stderr.write('kai-plugin-host does not accept command-line arguments\n');
  process.exit(64);
}

function readInit() {
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for host initialization')), INIT_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onError = (error) => fail(error);
    const onEnd = () => fail(new Error('Initialization pipe closed before a complete frame'));
    const onData = (chunk) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered) > MAX_INIT_BYTES) {
        fail(new Error('Initialization frame exceeded its byte limit'));
        return;
      }
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      const trailing = buffered.slice(newline + 1).trim();
      if (trailing) {
        fail(new Error('Initialization pipe contained unexpected trailing data'));
        return;
      }
      cleanup();
      try {
        resolve(JSON.parse(buffered.slice(0, newline)));
      } catch (error) {
        reject(new Error('Initialization frame was not valid JSON', { cause: error }));
      }
    };

    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
  });
}

function validateInit(value) {
  if (!value || typeof value !== 'object') throw new Error('Initialization payload must be an object');
  const init = value;
  if (init.host !== '127.0.0.1') throw new Error('SEA proof broker must be bound to IPv4 loopback');
  if (!Number.isInteger(init.port) || init.port < 1 || init.port > 65_535) throw new Error('Invalid broker port');
  if (typeof init.token !== 'string' || !TOKEN_PATTERN.test(init.token)) throw new Error('Invalid broker token');
  if (typeof init.pluginName !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(init.pluginName)) {
    throw new Error('Invalid plugin name');
  }
  if (typeof init.pluginPath !== 'string' || !isAbsolute(init.pluginPath)) throw new Error('Invalid plugin path');
  if (typeof init.expectedHash !== 'string' || !HASH_PATTERN.test(init.expectedHash)) {
    throw new Error('Invalid plugin hash');
  }
  return init;
}

function assignNested(root, dottedPath, value) {
  const parts = dottedPath.split('.').filter(Boolean);
  if (parts.length === 0 || parts.some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))) return;
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    const current = cursor[part];
    if (!current || typeof current !== 'object' || Array.isArray(current)) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

function createFramedSocket(init) {
  const socket = connect({ host: init.host, port: init.port });
  socket.setNoDelay(true);
  socket.setEncoding('utf8');
  let buffered = '';
  const listeners = new Set();

  socket.on('data', (chunk) => {
    buffered += chunk;
    if (Buffer.byteLength(buffered) > MAX_FRAME_BYTES) {
      socket.destroy(new Error('Broker frame buffer exceeded its byte limit'));
      return;
    }
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        socket.destroy(new Error('Broker sent invalid JSON'));
        return;
      }
      for (const listener of listeners) listener(message);
    }
  });

  return {
    socket,
    send(message) {
      socket.write(`${JSON.stringify(message)}\n`);
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function loadDiskLoader() {
  const loaderSource = getAsset('disk-loader.cjs', 'utf8');
  const nonce = randomBytes(12).toString('hex');
  const loaderDir = join(tmpdir(), `kai-sea-loader-${process.pid}-${nonce}`);
  const loaderPath = join(loaderDir, 'disk-loader.cjs');
  require('node:fs').mkdirSync(loaderDir, { mode: 0o700 });
  writeFileSync(loaderPath, loaderSource, { mode: 0o400, flag: 'wx' });
  const requireFromDisk = createRequire(loaderPath);
  const loader = requireFromDisk(loaderPath);
  // The module is resident after require(). Removing its private extraction
  // directory closes the persistent tampering window before plugin code runs.
  rmSync(loaderDir, { recursive: true, force: true });
  return loader.loadExternalModule;
}

function createProofApi(init, transport, ready) {
  const actions = new Map();
  const config = structuredClone(ready.config ?? {});
  const pluginData = structuredClone(ready.pluginData ?? {});
  const state = {};
  const operation = (namespace, method, args) => transport.send({ type: 'operation', namespace, method, args });

  return {
    api: {
      pluginName: init.pluginName,
      pluginDir: dirname(init.pluginPath),
      host: {
        apiVersion: () => 'sea-proof-1',
        capabilities: () => ['sea-plugin-host-proof'],
        hasCapability: (capability) => capability === 'sea-plugin-host-proof',
      },
      config: {
        get: () => structuredClone(config),
        set: (path, value) => {
          assignNested(config, path, value);
          operation('config', 'set', [path, value]);
        },
        getPluginData: () => structuredClone(pluginData),
        setPluginData: (path, value) => {
          assignNested(pluginData, path, value);
          operation('config', 'setPluginData', [path, value]);
        },
        onChanged: () => () => {},
      },
      state: {
        get: () => structuredClone(state),
        replace: (value) => {
          for (const key of Object.keys(state)) delete state[key];
          Object.assign(state, structuredClone(value));
          operation('state', 'replace', [value]);
        },
        set: (path, value) => {
          assignNested(state, path, value);
          operation('state', 'set', [path, value]);
        },
        emitEvent: (name, payload) => operation('state', 'emitEvent', [name, payload]),
      },
      events: {
        declare: (declaration) => operation('events', 'declare', [declaration]),
        emit: (name, payload) => operation('events', 'emit', [name, payload]),
      },
      ui: {
        registerSettingsView: (descriptor) => operation('ui', 'registerSettingsView', [descriptor]),
        showModal: (descriptor) => operation('ui', 'showModal', [descriptor]),
        hideModal: (id) => operation('ui', 'hideModal', [id]),
        updateModal: (id, updates) => operation('ui', 'updateModal', [id, updates]),
      },
      log: {
        info: (...args) => operation('log', 'info', args),
        warn: (...args) => operation('log', 'warn', args),
        error: (...args) => operation('log', 'error', args),
      },
      onAction: (targetId, handler) => {
        actions.set(targetId, handler);
        operation('actions', 'register', [targetId]);
      },
    },
    actions,
  };
}

async function main() {
  const init = validateInit(await readInit());
  const bytes = readFileSync(init.pluginPath);
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== init.expectedHash) throw new Error('Plugin hash did not match the main process authorization');

  const transport = createFramedSocket(init);
  let pluginModule = null;
  let actions = new Map();

  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out authenticating with the broker')), INIT_TIMEOUT_MS);
    transport.socket.once('error', reject);
    const unsubscribe = transport.onMessage((message) => {
      if (message?.type !== 'ready') return;
      clearTimeout(timer);
      unsubscribe();
      resolve(message);
    });
    transport.socket.once('connect', () => {
      transport.send({
        type: 'hello',
        token: init.token,
        pid: process.pid,
        pluginName: init.pluginName,
        nodeVersion: process.versions.node,
        sea: isSea(),
      });
    });
  });

  const proof = createProofApi(init, transport, ready);
  actions = proof.actions;
  const loadExternalModule = loadDiskLoader();
  const pluginUrl = `${pathToFileURL(init.pluginPath).href}?sha256=${actualHash}`;
  pluginModule = await loadExternalModule(pluginUrl);
  if (typeof pluginModule.activate !== 'function') throw new Error('Plugin does not export activate(api)');
  await pluginModule.activate(proof.api);
  transport.send({ type: 'activated', pluginName: init.pluginName });

  transport.onMessage(async (message) => {
    if (message?.type !== 'control') return;
    const requestId = message.requestId;
    try {
      if (message.command === 'ping') {
        transport.send({ type: 'control-result', requestId, ok: true, value: 'pong' });
        return;
      }
      if (message.command === 'invoke-action') {
        const handler = actions.get(message.targetId);
        if (!handler) throw new Error(`Unknown action target: ${message.targetId}`);
        const value = await handler(message.action, message.payload);
        transport.send({ type: 'control-result', requestId, ok: true, value });
        return;
      }
      if (message.command === 'deactivate') {
        await pluginModule?.deactivate?.();
        transport.send({ type: 'control-result', requestId, ok: true, value: null });
        transport.socket.end();
        return;
      }
      throw new Error(`Unknown control command: ${message.command}`);
    } catch (error) {
      transport.send({
        type: 'control-result',
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});

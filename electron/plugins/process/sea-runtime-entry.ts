import { isAbsolute } from 'node:path';
import { connect, type Socket } from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createBrokerFetch } from './broker-fetch.js';
import type { PluginMessageEvent, PluginMessagePort } from './message-port.js';
import { PLUGIN_PROCESS_PROTOCOL_VERSION, runPluginRuntime, type PluginRuntimeInit } from './plugin-runtime.js';

const MAX_INIT_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const INIT_TIMEOUT_MS = 10_000;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

type SeaStartupOptions = {
  syncWorkerSource: string;
};

function readInit(): Promise<PluginRuntimeInit> {
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for host initialization')), INIT_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onError = (error: Error): void => fail(error);
    const onEnd = (): void => fail(new Error('Initialization pipe closed before a complete frame'));
    const onData = (chunk: string): void => {
      buffered += chunk;
      if (Buffer.byteLength(buffered, 'utf8') > MAX_INIT_BYTES) {
        fail(new Error('Initialization frame exceeded its byte limit'));
        return;
      }
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      if (buffered.slice(newline + 1).trim()) {
        fail(new Error('Initialization pipe contained unexpected trailing data'));
        return;
      }
      cleanup();
      try {
        resolve(JSON.parse(buffered.slice(0, newline)) as PluginRuntimeInit);
      } catch (error) {
        reject(new Error('Initialization frame was not valid JSON', { cause: error }));
      }
    };
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
  });
}

function validateInit(init: PluginRuntimeInit): void {
  if (!init || init.type !== 'init') throw new Error('Invalid plugin host initialization payload');
  if (init.protocolVersion !== PLUGIN_PROCESS_PROTOCOL_VERSION) throw new Error('Plugin process protocol mismatch');
  if (!init.manifest || typeof init.manifest.name !== 'string') throw new Error('Invalid plugin manifest');
  if (!isAbsolute(init.pluginDir) || !isAbsolute(init.backendPath)) throw new Error('Plugin paths must be absolute');
  if (!HASH_PATTERN.test(init.fileHash)) throw new Error('Invalid plugin backend hash');
  if (init.syncBridge.host !== '127.0.0.1') throw new Error('Plugin broker must use IPv4 loopback');
  if (!Number.isInteger(init.syncBridge.port) || init.syncBridge.port < 1 || init.syncBridge.port > 65_535) {
    throw new Error('Invalid plugin broker port');
  }
  if (!TOKEN_PATTERN.test(init.syncBridge.token)) throw new Error('Invalid plugin broker token');
}

class SocketMessagePort implements PluginMessagePort {
  private listeners = new Set<(event: PluginMessageEvent) => void>();
  private buffered = '';
  private ready = false;
  private queued: unknown[] = [];
  private expectedProof = '';

  private constructor(private socket: Socket) {
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.on('data', (chunk: string) => this.consume(chunk));
  }

  static connect(init: PluginRuntimeInit): Promise<SocketMessagePort> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: init.syncBridge.host, port: init.syncBridge.port });
      const port = new SocketMessagePort(socket);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Timed out authenticating the plugin control channel'));
      }, INIT_TIMEOUT_MS);
      const onError = (error: Error): void => {
        clearTimeout(timer);
        reject(error);
      };
      socket.once('error', onError);
      socket.once('close', () => {
        if (port.ready) {
          process.exitCode = 1;
          setImmediate(() => process.exit(1));
        }
      });
      port.onReady = () => {
        clearTimeout(timer);
        socket.off('error', onError);
        resolve(port);
      };
      socket.once('connect', () => {
        const challenge = randomBytes(32).toString('hex');
        port.expectedProof = createHmac('sha256', init.syncBridge.token)
          .update(`server:${challenge}:${process.pid}:${init.manifest.name}`)
          .digest('hex');
        port.write({
          type: 'hello',
          channel: 'control',
          token: init.syncBridge.token,
          protocolVersion: PLUGIN_PROCESS_PROTOCOL_VERSION,
          pluginName: init.manifest.name,
          pid: process.pid,
          challenge,
        });
      });
    });
  }

  private onReady: () => void = () => {};

  private consume(chunk: string): void {
    this.buffered += chunk;
    if (Buffer.byteLength(this.buffered, 'utf8') > MAX_FRAME_BYTES) {
      this.socket.destroy(new Error('Plugin control frame exceeded its byte limit'));
      return;
    }
    for (;;) {
      const newline = this.buffered.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.socket.destroy(new Error('Plugin control channel received malformed JSON'));
        return;
      }
      if (!this.ready) {
        const candidate = message as { type?: unknown; tokenProof?: unknown };
        if (candidate.type !== 'ready' || typeof candidate.tokenProof !== 'string') {
          this.socket.destroy(new Error('Plugin control channel authentication failed'));
          return;
        }
        // Authenticate the server too: knowing the loopback port is not enough;
        // it must prove possession of the per-launch secret from inherited stdin.
        const expected = Buffer.from(this.expectedProof);
        const actual = Buffer.from(candidate.tokenProof);
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
          this.socket.destroy(new Error('Plugin control channel proof failed'));
          return;
        }
        this.ready = true;
        this.onReady();
        for (const queued of this.queued.splice(0)) this.dispatch(queued);
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: unknown): void {
    if (this.listeners.size === 0) {
      this.queued.push(message);
      return;
    }
    const event = { data: message };
    for (const listener of [...this.listeners]) listener(event);
  }

  private write(message: unknown): void {
    if (this.socket.destroyed) throw new Error('Plugin control channel is closed');
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  postMessage(message: unknown): void {
    if (!this.ready) throw new Error('Plugin control channel is not authenticated');
    this.write(message);
  }

  on(_event: 'message', listener: (event: PluginMessageEvent) => void): this {
    this.listeners.add(listener);
    for (const queued of this.queued.splice(0)) this.dispatch(queued);
    return this;
  }

  off(_event: 'message', listener: (event: PluginMessageEvent) => void): this {
    this.listeners.delete(listener);
    return this;
  }
}

/** Called by the tiny injected SEA bootstrap after it materializes this bundle. */
export async function startSeaPluginHost(options: SeaStartupOptions): Promise<void> {
  const init = await readInit();
  validateInit(init);
  init.syncBridge.workerPath = undefined;
  init.syncBridge.workerSource = options.syncWorkerSource;
  const parentPort = await SocketMessagePort.connect(init);
  await runPluginRuntime({
    parentPort,
    init,
    createFetchImpl: createBrokerFetch,
  });
}

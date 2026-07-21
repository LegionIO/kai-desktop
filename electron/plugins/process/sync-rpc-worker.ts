/**
 * Keeps the synchronous plugin-API compatibility channel alive while the
 * utility process's JavaScript thread is blocked in Atomics.wait(). The worker
 * belongs to the same OS process, so CPU and memory remain attributable to the
 * owning plugin.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createConnection, type Socket } from 'node:net';

type WorkerInit = {
  host: string;
  port: number;
  token: string;
};

type SyncCallMessage = {
  type: 'call';
  id: number;
  payload: string;
  shared: SharedArrayBuffer;
};

type SyncCancelMessage = {
  type: 'cancel';
  id: number;
};

const init = workerData as WorkerInit;
const encoder = new TextEncoder();
const pending = new Map<number, SharedArrayBuffer>();
let buffered = '';
let socket: Socket | null = null;

function finish(shared: SharedArrayBuffer, state: 1 | 2, payload: string): void {
  const header = new Int32Array(shared, 0, 2);
  const output = new Uint8Array(shared, 8);
  let bytes = encoder.encode(payload);
  let finalState = state;
  if (bytes.byteLength > output.byteLength) {
    bytes = encoder.encode(
      `Plugin synchronous IPC response exceeded ${output.byteLength} bytes; reduce the returned config/state payload`,
    );
    finalState = 2;
  }
  output.fill(0, 0, Math.min(output.length, bytes.byteLength));
  output.set(bytes.subarray(0, output.length));
  Atomics.store(header, 1, Math.min(bytes.byteLength, output.byteLength));
  Atomics.store(header, 0, finalState);
  Atomics.notify(header, 0);
}

function failPending(message: string): void {
  for (const shared of pending.values()) finish(shared, 2, message);
  pending.clear();
}

function consumeFrames(chunk: Buffer): void {
  buffered += chunk.toString('utf8');
  for (;;) {
    const newline = buffered.indexOf('\n');
    if (newline < 0) return;
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    try {
      const response = JSON.parse(line) as { id?: unknown; type?: unknown };
      if (response.type === 'ready') {
        parentPort?.postMessage({ type: 'ready' });
        continue;
      }
      if (typeof response.id !== 'number') continue;
      const shared = pending.get(response.id);
      if (!shared) continue;
      pending.delete(response.id);
      finish(shared, 1, line);
    } catch (error) {
      failPending(`Invalid response from plugin broker: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function connect(): void {
  socket = createConnection({ host: init.host, port: init.port });
  socket.setNoDelay(true);
  socket.on('connect', () => {
    socket?.write(`${JSON.stringify({ type: 'hello', token: init.token })}\n`);
  });
  socket.on('data', consumeFrames);
  socket.on('error', (error) => {
    failPending(`Plugin broker connection failed: ${error.message}`);
    parentPort?.postMessage({ type: 'error', error: error.message });
  });
  socket.on('close', () => {
    failPending('Plugin broker connection closed');
    parentPort?.postMessage({ type: 'closed' });
  });
}

parentPort?.on('message', (message: SyncCallMessage | SyncCancelMessage) => {
  if (message?.type === 'cancel') {
    pending.delete(message.id);
    return;
  }
  if (message?.type !== 'call') return;
  if (!socket || socket.destroyed || !socket.writable) {
    finish(message.shared, 2, 'Plugin broker is not connected');
    return;
  }
  pending.set(message.id, message.shared);
  socket.write(`${message.payload}\n`, (error) => {
    if (!error) return;
    const shared = pending.get(message.id);
    if (!shared) return;
    pending.delete(message.id);
    finish(shared, 2, `Plugin broker write failed: ${error.message}`);
  });
});

connect();

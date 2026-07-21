import { Worker } from 'node:worker_threads';
import type { ParentPort } from 'electron';
import { decodeWire, deserializeWireError, encodeWire, serializeWireError } from './wire.js';

const SYNC_BUFFER_BYTES = 16 * 1024 * 1024;
const SYNC_CALL_TIMEOUT_MS = 120_000;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type StreamWaiter = {
  resolve: (result: IteratorResult<unknown>) => void;
  reject: (error: unknown) => void;
};

class RemoteAsyncIterable implements AsyncGenerator<unknown> {
  private values: unknown[] = [];
  private waiters: StreamWaiter[] = [];
  private ended = false;
  private error: Error | null = null;

  constructor(
    private requestId: number,
    private cancel: (requestId: number) => void,
  ) {}

  push(value: unknown): void {
    if (this.ended || this.error) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  finish(): void {
    if (this.ended || this.error) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: Error): void {
    if (this.ended || this.error) return;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<IteratorResult<unknown>> {
    if (this.values.length > 0) return Promise.resolve({ done: false, value: this.values.shift() });
    if (this.error) return Promise.reject(this.error);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise<IteratorResult<unknown>>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  return(): Promise<IteratorResult<unknown>> {
    if (!this.ended) this.cancel(this.requestId);
    this.finish();
    return Promise.resolve({ done: true, value: undefined });
  }

  throw(error?: unknown): Promise<IteratorResult<unknown>> {
    if (!this.ended) this.cancel(this.requestId);
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.fail(normalized);
    return Promise.reject(normalized);
  }

  [Symbol.asyncIterator](): AsyncGenerator<unknown> {
    return this;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.return().then(() => undefined);
  }
}

export type SyncBridgeInit = {
  host: string;
  port: number;
  token: string;
  workerPath: string;
};

type ControlHandler = (command: string, args: unknown[]) => Promise<unknown> | unknown;

/**
 * Thrown by syncCall when the host doesn't respond within the timeout. Distinct
 * from a confirmed host rejection: a timeout is AMBIGUOUS — the queued request
 * may still be processed by the host later — so callers must NOT treat it as
 * "the host rejected this" (e.g. freeing callback ids the host may still adopt).
 */
export class PluginCallTimeoutError extends Error {
  readonly isTimeout = true;
  constructor(message: string) {
    super(message);
    this.name = 'PluginCallTimeoutError';
  }
}

export class UtilityTransport {
  private worker: Worker | null = null;
  private syncShared = new SharedArrayBuffer(SYNC_BUFFER_BYTES + 8);
  private sequence = 0;
  private functionSequence = 0;
  private abortSequence = 0;
  private pending = new Map<number, Deferred<unknown>>();
  private streams = new Map<number, RemoteAsyncIterable>();
  private functions = new Map<string, (...args: unknown[]) => unknown>();
  private remoteAbortControllers = new Map<string, AbortController>();
  private activeCallbackStreams = new Map<number, AsyncIterator<unknown>>();
  private controlHandler: ControlHandler | null = null;
  private closed = false;

  constructor(private parentPort: ParentPort) {
    parentPort.on('message', (event) => {
      void this.handleMessage(event.data as Record<string, unknown>);
    });
  }

  async startSyncBridge(init: SyncBridgeInit): Promise<void> {
    const ready = deferred<void>();
    const worker = new Worker(init.workerPath, {
      workerData: { host: init.host, port: init.port, token: init.token },
    });
    this.worker = worker;
    worker.on('message', (message: { type?: string; error?: string }) => {
      if (message?.type === 'ready') ready.resolve();
      else if (message?.type === 'error' || message?.type === 'closed') {
        ready.reject(new Error(message.error ?? 'Plugin synchronous broker closed'));
      }
    });
    worker.on('error', (error) => ready.reject(error));
    worker.on('exit', (code) => {
      if (!this.closed && code !== 0) ready.reject(new Error(`Plugin sync worker exited with code ${code}`));
    });
    await ready.promise;
  }

  setControlHandler(handler: ControlHandler): void {
    this.controlHandler = handler;
  }

  registerFunction(fn: (...args: unknown[]) => unknown): string {
    // Deliberately NOT deduped by fn identity. If the same function object is
    // sent across the wire in separate messages, each occurrence gets its own
    // fresh id. Deduping to a shared id created a use-after-free race: after the
    // host GC'd the FIRST occurrence's stub it would queue a release for that
    // id, but a concurrent re-send of the same fn would hand the host a NEW stub
    // bound to the SAME (deduped) id — then the stale release would delete a
    // callback the host is actively using. Unique-per-occurrence ids make a
    // release unambiguous: it targets exactly the occurrence that was collected.
    const id = `u${++this.functionSequence}`;
    this.functions.set(id, fn);
    return id;
  }

  /** Drop a callback the host will no longer invoke (it released the stub for
   *  this specific occurrence, or a caller like the inference provider replaced/
   *  unregistered it). Idempotent; a stray release for an unknown id no-ops. */
  releaseFunction(id: string): void {
    if (!id) return;
    this.functions.delete(id);
  }

  private registerAbortSignal(signal: AbortSignal): string {
    const id = `ua${++this.abortSequence}`;
    const transportRef = new WeakRef(this);
    const listener = () => {
      const transport = transportRef.deref();
      transport?.parentPort.postMessage({
        type: 'abort',
        abortId: id,
        reason: transport.encode(signal.reason),
      });
    };
    if (!signal.aborted) {
      signal.addEventListener('abort', listener, { once: true });
    }
    return id;
  }

  encode(value: unknown): unknown {
    // Track ids registered during THIS encode so we can roll them back if
    // encodeWire throws partway (e.g. a callback appears before a later cyclic
    // value that aborts serialization). Without rollback, the id sits in
    // `functions` with no host stub ever created for it — so it's never
    // GC-released, and since ids are unique per occurrence, every retry leaks a
    // fresh one.
    const registeredHere: string[] = [];
    try {
      return encodeWire(value, {
        registerFunction: (fn) => {
          const id = this.registerFunction(fn);
          registeredHere.push(id);
          return { id, async: fn.constructor.name === 'AsyncFunction' };
        },
        registerAbortSignal: (signal) => this.registerAbortSignal(signal),
      });
    } catch (error) {
      for (const id of registeredHere) this.releaseFunction(id);
      throw error;
    }
  }

  decode(value: unknown, abortIds?: string[]): unknown {
    return decodeWire(value, {
      callFunction: (id, args, isAsync) =>
        isAsync ? this.asyncCall('__mainCallback', [id, args]) : this.syncCall('__mainCallback', [id, args]),
      resolveAbortSignal: (id, aborted, reason) => {
        const controller = new AbortController();
        if (aborted) controller.abort(reason);
        if (id) {
          this.remoteAbortControllers.set(id, controller);
          abortIds?.push(id);
        }
        return controller.signal;
      },
    });
  }

  private releaseRemoteAbortControllers(abortIds: string[]): void {
    for (const id of abortIds) this.remoteAbortControllers.delete(id);
  }

  syncCall(method: string, args: unknown[]): unknown {
    if (this.closed || !this.worker) throw new Error('Plugin process transport is closed');
    const id = ++this.sequence;
    const request = JSON.stringify({ id, method, args: this.encode(args) });
    const header = new Int32Array(this.syncShared, 0, 2);
    Atomics.store(header, 0, 0);
    Atomics.store(header, 1, 0);
    this.worker.postMessage({ type: 'call', id, payload: request, shared: this.syncShared });
    const waitResult = Atomics.wait(header, 0, 0, SYNC_CALL_TIMEOUT_MS);
    if (waitResult === 'timed-out') {
      // A late response must never wake a later call that reused the same
      // shared buffer. Retire this buffer and let the worker discard the old
      // request ID before any subsequent call is posted.
      this.worker.postMessage({ type: 'cancel', id });
      this.syncShared = new SharedArrayBuffer(SYNC_BUFFER_BYTES + 8);
      throw new PluginCallTimeoutError(`Plugin API call "${method}" timed out after ${SYNC_CALL_TIMEOUT_MS}ms`);
    }
    const size = Atomics.load(header, 1);
    const text = new TextDecoder().decode(new Uint8Array(this.syncShared, 8, size));
    if (Atomics.load(header, 0) === 2) throw new Error(text || `Plugin API call "${method}" failed`);
    const response = JSON.parse(text) as { ok: boolean; value?: unknown; error?: unknown };
    if (!response.ok) throw deserializeWireError(response.error);
    return this.decode(response.value);
  }

  async asyncCall(method: string, args: unknown[]): Promise<unknown> {
    if (this.closed) throw new Error('Plugin process transport is closed');
    const id = ++this.sequence;
    const item = deferred<unknown>();
    this.pending.set(id, item);
    this.parentPort.postMessage({ type: 'invoke', id, method, args: this.encode(args) });
    return item.promise;
  }

  notify(method: string, args: unknown[]): void {
    void this.asyncCall(method, args).catch((error) => {
      console.error(`[PluginProcess] ${method} failed:`, error);
    });
  }

  streamCall(method: string, args: unknown[]): AsyncGenerator<unknown> {
    if (this.closed) throw new Error('Plugin process transport is closed');
    const id = ++this.sequence;
    const stream = new RemoteAsyncIterable(id, (requestId) => {
      this.parentPort.postMessage({ type: 'stream-cancel', id: requestId, direction: 'to-main' });
      this.streams.delete(requestId);
    });
    this.streams.set(id, stream);
    this.parentPort.postMessage({ type: 'stream-invoke', id, method, args: this.encode(args) });
    return stream;
  }

  async flush(): Promise<void> {
    await this.asyncCall('__ping', []);
  }

  private async invokeFunction(message: Record<string, unknown>): Promise<void> {
    const id = Number(message.id);
    const callbackId = String(message.callbackId ?? '');
    const fn = this.functions.get(callbackId);
    if (!fn) {
      this.parentPort.postMessage({
        type: 'callback-result',
        id,
        ok: false,
        error: serializeWireError(new Error(`Unknown plugin callback: ${callbackId}`)),
      });
      return;
    }
    const abortIds: string[] = [];
    try {
      const args = this.decode(message.args, abortIds) as unknown[];
      const value = await fn(...args);
      this.parentPort.postMessage({ type: 'callback-result', id, ok: true, value: this.encode(value) });
    } catch (error) {
      this.parentPort.postMessage({ type: 'callback-result', id, ok: false, error: serializeWireError(error) });
    } finally {
      this.releaseRemoteAbortControllers(abortIds);
    }
  }

  private async invokeFunctionStream(message: Record<string, unknown>): Promise<void> {
    const id = Number(message.id);
    const callbackId = String(message.callbackId ?? '');
    const fn = this.functions.get(callbackId);
    if (!fn) {
      this.parentPort.postMessage({
        type: 'callback-stream-error',
        id,
        error: serializeWireError(new Error(`Unknown plugin stream callback: ${callbackId}`)),
      });
      return;
    }
    const abortIds: string[] = [];
    try {
      const args = this.decode(message.args, abortIds) as unknown[];
      const iterable = (await fn(...args)) as AsyncIterable<unknown>;
      if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') {
        throw new Error(`Plugin callback ${callbackId} did not return an async iterable`);
      }
      const iterator = iterable[Symbol.asyncIterator]();
      this.activeCallbackStreams.set(id, iterator);
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        this.parentPort.postMessage({ type: 'callback-stream-event', id, value: this.encode(next.value) });
      }
      this.parentPort.postMessage({ type: 'callback-stream-end', id });
    } catch (error) {
      this.parentPort.postMessage({ type: 'callback-stream-error', id, error: serializeWireError(error) });
    } finally {
      this.activeCallbackStreams.delete(id);
      this.releaseRemoteAbortControllers(abortIds);
    }
  }

  private async handleMessage(message: Record<string, unknown>): Promise<void> {
    switch (message?.type) {
      case 'invoke-result': {
        const item = this.pending.get(Number(message.id));
        if (!item) return;
        this.pending.delete(Number(message.id));
        if (message.ok === true) item.resolve(this.decode(message.value));
        else item.reject(deserializeWireError(message.error));
        return;
      }
      case 'callback':
        await this.invokeFunction(message);
        return;
      case 'release-callback': {
        // The host GC'd every stub referencing this callback id — it will never
        // invoke it again, so drop our strong reference and let the closure (and
        // whatever it captured) be collected. Idempotent.
        this.releaseFunction(String(message.callbackId ?? ''));
        return;
      }
      case 'callback-stream':
        await this.invokeFunctionStream(message);
        return;
      case 'stream-event': {
        const stream = this.streams.get(Number(message.id));
        if (stream) stream.push(this.decode(message.value));
        return;
      }
      case 'stream-end': {
        const id = Number(message.id);
        const stream = this.streams.get(id);
        if (stream) stream.finish();
        this.streams.delete(id);
        return;
      }
      case 'stream-error': {
        const id = Number(message.id);
        const stream = this.streams.get(id);
        if (stream) stream.fail(deserializeWireError(message.error));
        this.streams.delete(id);
        return;
      }
      case 'stream-cancel': {
        if (message.direction !== 'to-utility') return;
        const iterator = this.activeCallbackStreams.get(Number(message.id));
        await iterator?.return?.();
        return;
      }
      case 'abort': {
        const id = String(message.abortId ?? '');
        const controller = this.remoteAbortControllers.get(id);
        if (controller && !controller.signal.aborted) controller.abort(this.decode(message.reason));
        this.remoteAbortControllers.delete(id);
        return;
      }
      case 'control': {
        const id = Number(message.id);
        if (!this.controlHandler) {
          this.parentPort.postMessage({
            type: 'control-result',
            id,
            ok: false,
            error: serializeWireError(new Error('Plugin control handler is not ready')),
          });
          return;
        }
        const abortIds: string[] = [];
        try {
          const args = this.decode(message.args, abortIds) as unknown[];
          const value = await this.controlHandler(String(message.command ?? ''), args);
          this.parentPort.postMessage({ type: 'control-result', id, ok: true, value: this.encode(value) });
        } catch (error) {
          this.parentPort.postMessage({ type: 'control-result', id, ok: false, error: serializeWireError(error) });
        } finally {
          this.releaseRemoteAbortControllers(abortIds);
        }
        return;
      }
      default:
        return;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = new Error('Plugin process transport closed');
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
    for (const stream of this.streams.values()) stream.fail(error);
    this.streams.clear();
    for (const controller of this.remoteAbortControllers.values()) {
      if (!controller.signal.aborted) controller.abort(error);
    }
    this.remoteAbortControllers.clear();
    await this.worker?.terminate();
    this.worker = null;
  }
}

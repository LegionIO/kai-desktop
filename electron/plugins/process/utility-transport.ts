import { Worker } from 'node:worker_threads';
import type { ParentPort } from 'electron';
import { decodeWire, deserializeWireError, encodeWire, serializeWireError } from './wire.js';

const SYNC_BUFFER_BYTES = 16 * 1024 * 1024;
const SYNC_CALL_TIMEOUT_MS = 120_000;
const SYNC_BRIDGE_START_TIMEOUT_MS = 10_000;

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
  readonly isAmbiguous = true;
  constructor(message: string) {
    super(message);
    this.name = 'PluginCallTimeoutError';
  }
}

/**
 * Thrown by syncCall on a WORKER-level failure (broker disconnected, response
 * exceeded the shared buffer, socket closed before delivery). Like a timeout,
 * this is AMBIGUOUS: the host may already have processed the request and be
 * holding callbacks, but no adopted payload reached us — so callers must not
 * free callback ids on this error either.
 */
export class PluginCallAmbiguousError extends Error {
  readonly isAmbiguous = true;
  constructor(message: string) {
    super(message);
    this.name = 'PluginCallAmbiguousError';
  }
}

/** True for any error where the host's disposition of a call is UNKNOWN — the
 *  host may hold callbacks it introduced, so their ids must be preserved (never
 *  freed as if rejected). Reclamation for genuinely-orphaned ids is deferred to
 *  the drain-barrier reconcile. */
export function isAmbiguousPluginCallError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { isAmbiguous?: boolean }).isAmbiguous === true;
}

export class UtilityTransport {
  private worker: Worker | null = null;
  private syncBridge: SyncBridgeInit | null = null;
  private syncShared: SharedArrayBuffer | null = null;
  private sequence = 0;
  private orderedSequence = 0;
  private orderedPending = new Map<number, Promise<void>>();
  private orderedFailure: unknown = null;
  private disposableSequence = 0;
  private functionSequence = 0;
  private abortSequence = 0;
  private pending = new Map<number, Deferred<unknown>>();
  private streams = new Map<number, RemoteAsyncIterable>();
  private functions = new Map<string, (...args: unknown[]) => unknown>();
  // Ownership tracking for utility→host callbacks. A registered id is only
  // safe to reclaim once we KNOW the host's disposition for it — never inferred
  // from ordering (callbacks travel over two unordered channels: the TCP sync
  // broker and Electron IPC). Two host signals resolve it:
  //   • `callback-adopted {id}` — the host decoded it into a live reference and
  //     now owns its lifetime (it will send `release-callback` when GC'd). We
  //     drop the id from `unadopted` and NEVER reclaim it ourselves.
  //   • the carrying request settling (reply/confirmed-timeout) — if the id is
  //     still unadopted then, the host never took it (dropped/rejected message),
  //     so we release it. `requestCallbacks` maps a carrying-request id to the
  //     ids it introduced; released or adopted ids are pruned from it.
  // Ids the host adopts asynchronously (before the carrying request settles) are
  // removed from `unadopted` by the adopt ack, so request-settle won't free them.
  private unadopted = new Set<string>();
  private requestCallbacks = new Map<number, Set<string>>();
  // Reverse index id → carrying-request id, so release/adopt can prune the
  // requestCallbacks entry in O(1) and empty entries are dropped — otherwise a
  // timed-out request (whose settleRequest never runs) would leave its entry in
  // requestCallbacks forever, growing the map without bound.
  private callbackRequest = new Map<string, number>();
  // Snapshot of functionSequence taken when we answer a drain-ping. The reconcile
  // that follows may ONLY sweep ids created at/before this — any callback the
  // plugin registered AFTER the pong (but before the reconcile lands) hasn't
  // reached the host's held-set snapshot yet, so it must be preserved.
  private reconcileWatermark = 0;
  private remoteAbortControllers = new Map<string, AbortController>();
  private activeCallbackStreams = new Map<number, AsyncIterator<unknown>>();
  private controlHandler: ControlHandler | null = null;
  private syncWorkerStateChangeHandler: (() => void) | null = null;
  private closed = false;

  constructor(private parentPort: ParentPort) {
    parentPort.on('message', (event) => {
      void this.handleMessage(event.data as Record<string, unknown>);
    });
  }

  /** Store bridge credentials without allocating a Worker/V8 isolate. */
  configureSyncBridge(init: SyncBridgeInit): void {
    this.syncBridge = init;
  }

  get hasSyncWorker(): boolean {
    return this.worker !== null;
  }

  setSyncWorkerStateChangeHandler(handler: () => void): void {
    this.syncWorkerStateChangeHandler = handler;
  }

  private ensureSyncWorker(): Worker {
    if (this.closed) throw new Error('Plugin process transport is closed');
    if (this.worker) return this.worker;
    if (!this.syncBridge) throw new Error('Plugin synchronous bridge is not configured');

    // EventEmitter callbacks cannot run while this thread is blocked in
    // Atomics.wait, so the worker signals connection readiness directly through
    // this tiny startup buffer. The large response buffer is also allocated only
    // when a plugin first needs a genuinely synchronous host result.
    const readyShared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const readyState = new Int32Array(readyShared);
    const worker = new Worker(this.syncBridge.workerPath, {
      workerData: {
        host: this.syncBridge.host,
        port: this.syncBridge.port,
        token: this.syncBridge.token,
        readyShared,
      },
    });
    this.worker = worker;

    const retire = (): void => {
      if (this.worker !== worker) return;
      this.worker = null;
      try {
        this.syncWorkerStateChangeHandler?.();
      } catch {
        // Diagnostics reporting is best-effort during worker teardown.
      }
    };
    worker.on('message', (message: { type?: string }) => {
      if (message?.type === 'error' || message?.type === 'closed') retire();
    });
    worker.on('error', retire);
    worker.on('exit', retire);

    const waitResult = Atomics.wait(readyState, 0, 0, SYNC_BRIDGE_START_TIMEOUT_MS);
    if (waitResult === 'timed-out' || Atomics.load(readyState, 0) !== 1) {
      retire();
      void worker.terminate();
      throw new PluginCallAmbiguousError(
        waitResult === 'timed-out'
          ? `Plugin synchronous broker did not start within ${SYNC_BRIDGE_START_TIMEOUT_MS}ms`
          : 'Plugin synchronous broker failed to connect',
      );
    }
    this.syncShared = new SharedArrayBuffer(SYNC_BUFFER_BYTES + 8);
    try {
      this.syncWorkerStateChangeHandler?.();
    } catch {
      // Diagnostics reporting must not make a compatibility call fail.
    }
    return worker;
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
    this.unadopted.add(id);
    return id;
  }

  /** Drop a callback + all its ownership bookkeeping. Idempotent. */
  releaseFunction(id: string): void {
    if (!id) return;
    this.functions.delete(id);
    this.unadopted.delete(id);
    this.forgetCallbackRequest(id);
  }

  /** Host confirmed it decoded this id into a live reference — it now owns the
   *  id's lifetime (releasing via `release-callback` on GC). Remove it from the
   *  unadopted set (so request-settle/reconcile won't touch it) AND from the
   *  request bookkeeping (settle no longer needs to consider it). */
  private markAdopted(id: string): void {
    this.unadopted.delete(id);
    this.forgetCallbackRequest(id);
  }

  /** Remove an id from its carrying-request entry, dropping the entry when empty.
   *  Keeps requestCallbacks bounded even for requests whose settle never runs
   *  (e.g. a timed-out sync call reclaimed later by reconcile). */
  private forgetCallbackRequest(id: string): void {
    const requestId = this.callbackRequest.get(id);
    if (requestId === undefined) return;
    this.callbackRequest.delete(id);
    const ids = this.requestCallbacks.get(requestId);
    if (!ids) return;
    ids.delete(id);
    if (ids.size === 0) this.requestCallbacks.delete(requestId);
  }

  /** A carrying request settled (a definite host reply). Any callback ids it
   *  introduced that the host never adopted are provably orphaned — release
   *  them. Per-request scoped, so it's immune to cross-channel ordering. */
  private settleRequest(requestId: number): void {
    const ids = this.requestCallbacks.get(requestId);
    if (!ids) return;
    // releaseFunction/forgetCallbackRequest mutate these maps, so iterate a copy.
    for (const id of [...ids]) {
      if (this.unadopted.has(id)) this.releaseFunction(id);
      else this.forgetCallbackRequest(id);
    }
    this.requestCallbacks.delete(requestId);
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

  encode(value: unknown, requestId?: number): unknown {
    // Track ids registered during THIS encode so we can (a) roll them back if
    // encodeWire throws partway (e.g. a callback before a later cyclic value),
    // and (b) associate them with the carrying request so that, if that request
    // settles without the host adopting them, we can reclaim the orphans.
    const registeredHere: string[] = [];
    try {
      const encoded = encodeWire(value, {
        registerFunction: (fn) => {
          const id = this.registerFunction(fn);
          registeredHere.push(id);
          return { id, async: fn.constructor.name === 'AsyncFunction' };
        },
        registerAbortSignal: (signal) => this.registerAbortSignal(signal),
      });
      if (requestId !== undefined && registeredHere.length > 0) {
        let set = this.requestCallbacks.get(requestId);
        if (!set) {
          set = new Set<string>();
          this.requestCallbacks.set(requestId, set);
        }
        for (const id of registeredHere) {
          set.add(id);
          this.callbackRequest.set(id, requestId);
        }
      }
      return encoded;
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
    const worker = this.ensureSyncWorker();
    const syncShared = this.syncShared;
    if (!syncShared) throw new Error('Plugin synchronous response buffer is unavailable');
    const id = ++this.sequence;
    const request = JSON.stringify({
      id,
      method,
      args: this.encode(args, id),
      afterOrder: this.orderedSequence,
    });
    const header = new Int32Array(syncShared, 0, 2);
    Atomics.store(header, 0, 0);
    Atomics.store(header, 1, 0);
    worker.postMessage({ type: 'call', id, payload: request, shared: syncShared });
    const waitResult = Atomics.wait(header, 0, 0, SYNC_CALL_TIMEOUT_MS);
    if (waitResult === 'timed-out') {
      // A late response must never wake a later call that reused the same
      // shared buffer. Retire this buffer and let the worker discard the old
      // request ID before any subsequent call is posted.
      worker.postMessage({ type: 'cancel', id });
      this.syncShared = new SharedArrayBuffer(SYNC_BUFFER_BYTES + 8);
      // Do NOT settle the request here: a timeout is ambiguous — the host may
      // still process the queued broker request and adopt these ids. Their
      // disposition resolves later via an adopt-ack (host took them) or the
      // drain-barrier reconcile (host confirms it never did). Settling now would
      // free ids the host is about to use.
      throw new PluginCallTimeoutError(`Plugin API call "${method}" timed out after ${SYNC_CALL_TIMEOUT_MS}ms`);
    }
    // Worker state 2 is a WORKER-level failure (broker disconnected, response
    // exceeded the shared buffer, socket closed before delivery) — NOT proof the
    // host rejected the request. The host may already hold callback stubs, and
    // there's no adopted payload here, so treat it like a timeout: do NOT settle;
    // defer reclamation to the drain-barrier reconcile.
    const size = Atomics.load(header, 1);
    const text = new TextDecoder().decode(new Uint8Array(syncShared, 8, size));
    if (Atomics.load(header, 0) === 2) {
      throw new PluginCallAmbiguousError(text || `Plugin API call "${method}" failed`);
    }
    // A definite host reply (state 1). It carries any callback ids the host
    // ADOPTED while handling it (on this same broker channel, avoiding a
    // cross-channel race). Mark those adopted FIRST, then settle — so settle only
    // reclaims ids the host truly never took.
    const response = JSON.parse(text) as { ok: boolean; value?: unknown; error?: unknown; adopted?: unknown };
    if (Array.isArray(response.adopted)) {
      for (const adoptedId of response.adopted) this.markAdopted(String(adoptedId));
    }
    this.settleRequest(id);
    if (!response.ok) throw deserializeWireError(response.error);
    return this.decode(response.value);
  }

  async asyncCall(method: string, args: unknown[]): Promise<unknown> {
    if (this.closed) throw new Error('Plugin process transport is closed');
    const id = ++this.sequence;
    const item = deferred<unknown>();
    this.pending.set(id, item);
    this.parentPort.postMessage({
      type: 'invoke',
      id,
      method,
      args: this.encode(args, id),
      afterOrder: this.orderedSequence,
    });
    return item.promise;
  }

  /**
   * Preserve a void PluginAPI call's synchronous call shape while executing it
   * on the existing Electron IPC channel. Calls are numbered and the host runs
   * them strictly in order; every later sync/async request carries a barrier so
   * it cannot overtake these side effects on the separate broker channel.
   */
  orderedCall(method: string, args: unknown[] = []): void {
    if (this.closed) throw new Error('Plugin process transport is closed');
    if (this.orderedFailure) throw this.orderedFailure;
    const id = ++this.sequence;
    const order = ++this.orderedSequence;
    const item = deferred<unknown>();
    this.pending.set(id, item);
    this.parentPort.postMessage({ type: 'invoke', id, order, method, args: this.encode(args, id) });
    const tracked = item.promise.then(
      () => undefined,
      (error) => {
        this.orderedFailure ??= error;
      },
    );
    this.orderedPending.set(order, tracked);
    void tracked.finally(() => this.orderedPending.delete(order));
  }

  registerDisposable(method: 'config.onChanged' | 'events.on' | 'hooks.register', args: unknown[]): () => void {
    const registrationId = `d${++this.disposableSequence}`;
    let active = true;
    this.orderedCall('__registerDisposable', [registrationId, method, args]);
    return () => {
      if (!active) return;
      active = false;
      this.orderedCall('__disposeDisposable', [registrationId]);
    };
  }

  private async flushOrderedCalls(): Promise<void> {
    while (this.orderedPending.size > 0) {
      await Promise.all([...this.orderedPending.values()]);
    }
    if (this.orderedFailure) {
      const error = this.orderedFailure;
      this.orderedFailure = null;
      throw error;
    }
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
    this.parentPort.postMessage({
      type: 'stream-invoke',
      id,
      method,
      args: this.encode(args),
      afterOrder: this.orderedSequence,
    });
    return stream;
  }

  async flush(): Promise<void> {
    await this.flushOrderedCalls();
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
      await this.flushOrderedCalls();
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
        await this.flushOrderedCalls();
        this.parentPort.postMessage({ type: 'callback-stream-event', id, value: this.encode(next.value) });
      }
      await this.flushOrderedCalls();
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
        const requestId = Number(message.id);
        const item = this.pending.get(requestId);
        if (!item) return;
        this.pending.delete(requestId);
        // The host processed this request; reclaim any callback ids it carried
        // that were never adopted.
        this.settleRequest(requestId);
        if (message.ok === true) item.resolve(this.decode(message.value));
        else item.reject(deserializeWireError(message.error));
        return;
      }
      case 'callback':
        await this.invokeFunction(message);
        return;
      case 'callback-adopted': {
        // The host decoded these ids into live references and now owns their
        // lifetime (it will `release-callback` on GC). Remove them from the
        // unadopted set so request-settle / reconcile never reclaims them out
        // from under the host.
        const ids = Array.isArray(message.ids) ? (message.ids as unknown[]) : [];
        for (const id of ids) this.markAdopted(String(id));
        return;
      }
      case 'release-callback': {
        // The host GC'd every stub referencing this callback id — it will never
        // invoke it again, so drop our strong reference and let the closure (and
        // whatever it captured) be collected. Idempotent.
        this.releaseFunction(String(message.callbackId ?? ''));
        return;
      }
      case 'drain-ping': {
        // The host is establishing a two-channel drain barrier before a reconcile
        // sweep. Snapshot our creation counter NOW: the reconcile that follows may
        // only sweep ids that existed at this instant — anything registered after
        // (but before the reconcile arrives) isn't in the host's held snapshot yet
        // and must survive. Then echo the token over IPC so the host learns this
        // channel is drained past this point (making the sweep safe against
        // cross-channel reordering).
        this.reconcileWatermark = this.functionSequence;
        this.parentPort.postMessage({ type: 'drain-pong', token: message.token });
        return;
      }
      case 'reconcile-callbacks': {
        // Post-barrier authoritative sweep. `heldIds` are every callback id the
        // host still references. Because the host only sends this AFTER both
        // channels have echoed its drain barrier, every id we sent before the
        // barrier has been fully processed by the host — so any UNADOPTED id not
        // in heldIds is provably orphaned (e.g. a sync handoff that timed out and
        // the host never adopted). Reclaim those, but ONLY ids at/before the
        // watermark we snapshotted at pong time: an id created after the pong
        // hasn't reached the host's snapshot yet, so a later barrier reclaims it
        // if still orphaned — nothing leaks, nothing is prematurely freed.
        const held = new Set(Array.isArray(message.heldIds) ? (message.heldIds as unknown[]).map(String) : []);
        const watermark = this.reconcileWatermark;
        for (const id of [...this.unadopted]) {
          const seq = Number(id.slice(1)); // ids are `u<seq>`
          if (Number.isFinite(seq) && seq <= watermark && !held.has(id)) {
            this.releaseFunction(id);
          }
        }
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
          await this.flushOrderedCalls();
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
    this.syncShared = null;
  }
}

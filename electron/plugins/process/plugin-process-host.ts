import { app, utilityProcess, type UtilityProcess } from 'electron';
import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { PluginAPI, PluginInferenceProvider, PluginManifest } from '../types.js';
import { recordDiagnosticForPlugin, type DiagnosticKind } from '../../diagnostics/main-diagnostics.js';
import { decodeWire, deserializeWireError, encodeWire, serializeWireError } from './wire.js';

const BROKER_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const BROKER_MAX_CALLS_PER_SECOND = 1_000;
const CHILD_MAX_MESSAGES_PER_SECOND = 5_000;
const CHILD_MAX_INFLIGHT_INVOCATIONS = 128;
const ACTIVATION_TIMEOUT_MS = 60_000;
const DEACTIVATION_TIMEOUT_MS = 10_000;
const AVAILABILITY_POLL_MS = 5_000;
const AVAILABILITY_TIMEOUT_MS = 2_000;
// Periodic callback reconciliation. Reclaims utility-side callbacks that no host
// GC will ever release — specifically a handoff that timed out and was never
// adopted. Infrequent: it's a slow-leak backstop, not a hot path.
const CALLBACK_RECONCILE_MS = 30_000;
const OUTPUT_BYTES_PER_SECOND = 64 * 1024;
const PERSISTENT_PLUGIN_CALLBACK = Symbol.for('kai.plugin.persistent-callback');

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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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
    private onClose: () => void = () => {},
  ) {}

  private release(): void {
    const onClose = this.onClose;
    this.onClose = () => {};
    onClose();
  }

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
    this.release();
  }

  fail(error: Error): void {
    if (this.ended || this.error) return;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    this.release();
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

export type PluginProcessStatus = 'starting' | 'running' | 'paused' | 'stopping' | 'crashed';

type ProcessRecord = {
  pluginName: string;
  displayName: string;
  pid: number | null;
  status: PluginProcessStatus;
  startedAt: string;
  crashCount: number;
  lastExitCode: number | null;
  lastError: string | null;
};

export type PluginProcessMetric = ProcessRecord & {
  canPause: boolean;
  cpuPercent: number;
  cumulativeCpuSeconds: number | null;
  privateMemoryBytes: number;
  residentSetBytes: number;
};

const processRecords = new Map<string, ProcessRecord>();
const processRecordOwners = new Map<string, symbol>();
/** Session-lifetime crash totals survive disable/enable process replacement. */
const processCrashCounts = new Map<string, number>();

/** Returns live, OS-attributed resource usage for every loaded plugin backend. */
export function getPluginProcessMetrics(): PluginProcessMetric[] {
  let metrics: Electron.ProcessMetric[] = [];
  try {
    metrics = app.getAppMetrics();
  } catch {
    // App may be shutting down or a unit test may not provide Electron metrics.
  }
  const byPid = new Map(metrics.map((metric) => [metric.pid, metric]));
  return [...processRecords.values()]
    .map((record) => {
      const metric = record.pid === null ? undefined : byPid.get(record.pid);
      return {
        ...record,
        canPause: process.platform !== 'win32',
        cpuPercent: metric?.cpu.percentCPUUsage ?? 0,
        cumulativeCpuSeconds: metric?.cpu.cumulativeCPUUsage ?? null,
        privateMemoryBytes: (metric?.memory.privateBytes ?? metric?.memory.workingSetSize ?? 0) * 1024,
        residentSetBytes: (metric?.memory.workingSetSize ?? 0) * 1024,
      };
    })
    .sort((a, b) => a.pluginName.localeCompare(b.pluginName));
}

type PluginProcessHostOptions = {
  manifest: PluginManifest;
  pluginDir: string;
  backendPath: string;
  fileHash: string;
  api: PluginAPI;
  utilityEntryPath: string;
  syncWorkerPath: string;
  onUnexpectedExit: (details: { code: number; error?: string }) => void | Promise<void>;
};

type BrokerRequest = {
  id: number;
  method: string;
  args?: unknown;
};

export class PluginProcessHost {
  private child: UtilityProcess | null = null;
  private server: Server | null = null;
  private brokerSocket: Socket | null = null;
  // In-flight broker (sync-call) requests + waiters that resolve when the count
  // hits zero. Used by the reconcile drain barrier: a sync handoff whose reply
  // the utility abandoned on timeout may still be processing here and about to
  // adopt callbacks, so the sweep waits for these to finish first.
  private inFlightBrokerRequests = 0;
  private brokerDrainWaiters: Array<() => void> = [];
  private brokerToken = randomBytes(32).toString('hex');
  private brokerPort = 0;
  private sequence = 0;
  private functionSequence = 0;
  private abortSequence = 0;
  private pending = new Map<number, Deferred<unknown>>();
  private inboundStreams = new Map<number, RemoteAsyncIterable>();
  private outboundStreams = new Map<number, AsyncIterator<unknown>>();
  private mainFunctions = new Map<string, (...args: unknown[]) => unknown>();
  private mainFunctionIds = new WeakMap<(...args: unknown[]) => unknown, string>();
  private remoteAbortControllers = new Map<string, AbortController>();
  // Utility-side callback bookkeeping. The utility assigns a fresh id per wire
  // occurrence (no fn-identity dedup), so an id normally maps to exactly ONE
  // host stub. We still refcount defensively — should the same id ever decode
  // into multiple stubs, we post the release only once EVERY stub for it has
  // been garbage-collected. This lets a long-running plugin that churns
  // registrations reclaim callbacks (+ captured data), and — because release is
  // tied to GC of the host's own stubs — we never release an id the host still
  // references (no use-after-free), and a stale release can't hit a live id
  // (ids aren't reused).
  private utilityCallbackRefs = new Map<string, number>();
  private utilityCallbackFinalizer = new FinalizationRegistry<string>((id) => {
    const remaining = (this.utilityCallbackRefs.get(id) ?? 0) - 1;
    if (remaining > 0) {
      this.utilityCallbackRefs.set(id, remaining);
      return;
    }
    this.utilityCallbackRefs.delete(id);
    this.postReleaseCallback(id);
  });
  // Inference-provider callbacks (isAvailableId/streamId) travel to us as raw
  // ids the utility won't release — only we know when no in-flight turn still
  // holds the provider. We tie their release to GC of the provider OBJECT we
  // build (which the agent framework keeps alive across an in-flight turn).
  // `streamId` is held only by the provider → released on that GC.
  // `isAvailableId` is ALSO held by the poll loop → released only once the
  // provider is collected AND the poll has stopped using it (whichever is last).
  private inferenceProviderFinalizer = new FinalizationRegistry<{ isAvailableId: string; streamId: string }>(
    ({ isAvailableId, streamId }) => {
      // This provider object is gone (no in-flight turn holds it). Its streamId
      // is held ONLY by this provider, so release it and drop it from the live
      // set — every superseded provider tracks + releases its OWN streamId, so a
      // replaced-but-still-in-flight old provider keeps its stream alive until
      // its own finalizer runs (fixes the "only current streamId" regression).
      this.liveInferenceStreamIds.delete(streamId);
      this.postReleaseCallback(streamId);
      // isAvailableId is ALSO pinned by the availability poll. Release it only if
      // the poll has already moved off it; otherwise defer to when the poll stops.
      if (this.inferenceAvailabilityCallbackId !== isAvailableId) {
        this.postReleaseCallback(isAvailableId);
      } else {
        this.pendingIdleInferenceCallbackId = isAvailableId;
      }
    },
  );
  // Set when the provider object was collected while the poll still held
  // isAvailableId; released by releaseIdleInferencePollCallback once the poll
  // stops (unregister/dispose/replace).
  private pendingIdleInferenceCallbackId: string | null = null;
  // Every live inference provider's streamId — the CURRENT one plus any
  // superseded provider still captured by an in-flight turn. Each is removed by
  // its own provider finalizer. Reported as held so reconcile never sweeps a
  // stream a delayed turn may still call.
  private liveInferenceStreamIds = new Set<string>();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  // Drain-barrier bookkeeping for the reconcile sweep. Each barrier gets a token
  // echoed by the utility over IPC; we also wait until our broker inbound queue
  // is drained past the point the barrier was issued, so an adopt-ack for a
  // slow broker (sync-call) request can't still be in flight when we sweep.
  private drainBarrierToken = 0;
  private pendingDrainResolve: (() => void) | null = null;
  private activation = deferred<void>();
  private exit = deferred<number>();
  private expectedExit = false;
  private disposed = false;
  private inferenceAvailable = false;
  private inferenceAvailabilityCallbackId: string | null = null;
  private inferenceAvailabilityTimer: ReturnType<typeof setInterval> | null = null;
  private inferenceAvailabilityPollPending = false;
  private outputTimers: ReturnType<typeof setInterval>[] = [];
  private unexpectedExitCleanup: Promise<void> | null = null;
  private runtimeReleased = false;
  private childMessageWindowStartedAt = Date.now();
  private childMessagesInWindow = 0;
  private childMessageOverload = false;
  private inboundInvocations = 0;
  private readonly recordOwner = Symbol('plugin-process-record-owner');
  private hasPausedConfig = false;
  private pausedConfig: unknown;

  constructor(private options: PluginProcessHostOptions) {
    processRecordOwners.set(options.manifest.name, this.recordOwner);
    processRecords.set(options.manifest.name, {
      pluginName: options.manifest.name,
      displayName: options.manifest.displayName,
      pid: null,
      status: 'starting',
      startedAt: new Date().toISOString(),
      crashCount: processCrashCounts.get(options.manifest.name) ?? 0,
      lastExitCode: null,
      lastError: null,
    });
  }

  get pid(): number | null {
    return this.child?.pid ?? processRecords.get(this.options.manifest.name)?.pid ?? null;
  }

  get status(): PluginProcessStatus {
    if (processRecordOwners.get(this.options.manifest.name) !== this.recordOwner) return 'crashed';
    return processRecords.get(this.options.manifest.name)?.status ?? 'crashed';
  }

  get canPause(): boolean {
    return process.platform !== 'win32';
  }

  private updateRecord(updates: Partial<ProcessRecord>): void {
    if (processRecordOwners.get(this.options.manifest.name) !== this.recordOwner) return;
    const current = processRecords.get(this.options.manifest.name);
    if (current) processRecords.set(this.options.manifest.name, { ...current, ...updates });
  }

  private registerMainFunction(fn: (...args: unknown[]) => unknown): { id: string; newlyRegistered: boolean } {
    const existing = this.mainFunctionIds.get(fn);
    if (existing) {
      const newlyRegistered = !this.mainFunctions.has(existing);
      this.mainFunctions.set(existing, fn);
      return { id: existing, newlyRegistered };
    }
    const id = `m${++this.functionSequence}`;
    this.mainFunctionIds.set(fn, id);
    this.mainFunctions.set(id, fn);
    return { id, newlyRegistered: true };
  }

  private registerAbortSignal(signal: AbortSignal): string {
    const id = `ma${++this.abortSequence}`;
    const hostRef = new WeakRef(this);
    const listener = () => {
      const host = hostRef.deref();
      host?.child?.postMessage({ type: 'abort', abortId: id, reason: host.encode(signal.reason) });
    };
    if (!signal.aborted) {
      signal.addEventListener('abort', listener, { once: true });
    }
    return id;
  }

  private encode(value: unknown, scopedFunctionIds?: string[]): unknown {
    return encodeWire(value, {
      registerFunction: (fn) => {
        const registration = this.registerMainFunction(fn);
        if (
          registration.newlyRegistered &&
          (fn as { [PERSISTENT_PLUGIN_CALLBACK]?: boolean })[PERSISTENT_PLUGIN_CALLBACK] !== true
        ) {
          scopedFunctionIds?.push(registration.id);
        }
        return {
          id: registration.id,
          async: fn.constructor.name === 'AsyncFunction',
        };
      },
      registerAbortSignal: (signal) => this.registerAbortSignal(signal),
    });
  }

  private decode(value: unknown, abortIds?: string[], adoptSink?: string[]): unknown {
    return decodeWire(value, {
      callFunction: (id, args) => {
        const result = this.invokeChildCallback(id, args);
        // Some plugin API callbacks are intentionally fire-and-forget in the
        // host (event/config listeners), while tools and hooks await the same
        // Promise. Mark the rejection handled without changing what an awaiting
        // caller observes.
        void result.catch(() => {});
        return result;
      },
      onFunctionStub: (id, stub) => this.trackUtilityCallbackStub(id, stub, adoptSink),
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

  /** Register a freshly-decoded utility-callback stub for GC tracking: bump the
   *  per-id live-stub count and arm the finalizer so we post a release once the
   *  last stub for this id is collected. Also ACK adoption to the utility — this
   *  is the authoritative "the host took ownership of this id" signal, so the
   *  utility won't reclaim it on request-settle or reconcile. */
  private trackUtilityCallbackStub(id: string, stub: object, adoptSink?: string[]): void {
    this.utilityCallbackRefs.set(id, (this.utilityCallbackRefs.get(id) ?? 0) + 1);
    this.utilityCallbackFinalizer.register(stub, id, stub);
    this.postCallbackAdopted([id], adoptSink);
  }

  /** Tell the utility the host decoded these ids into live references and now
   *  owns their lifetime. When an explicit `sink` is given (a broker request in
   *  progress), route the ids into it so they ride back on the SAME broker
   *  response — otherwise a race exists where the sync reply unblocks the utility
   *  before an IPC adopt-ack arrives. With no sink, send over IPC (same channel
   *  as the async reply). Each broker handler owns its OWN sink array (passed by
   *  reference), so overlapping/timed-out handlers never corrupt each other. */
  private postCallbackAdopted(ids: string[], sink?: string[]): void {
    if (ids.length === 0) return;
    if (sink) {
      sink.push(...ids);
      return;
    }
    if (!this.child || this.disposed) return;
    try {
      this.child.postMessage({ type: 'callback-adopted', ids });
    } catch {
      /* child tearing down */
    }
  }

  /** Every utility callback id the host currently references: live wire-callback
   *  stubs (refcount > 0) plus the active inference-provider ids (poll id, any
   *  deferred idle poll id, and EVERY live provider streamId). The reconcile
   *  sweep treats any UNADOPTED id not in this set as orphaned. */
  private heldUtilityCallbackIds(): string[] {
    const held = new Set<string>(this.utilityCallbackRefs.keys());
    if (this.inferenceAvailabilityCallbackId) held.add(this.inferenceAvailabilityCallbackId);
    if (this.pendingIdleInferenceCallbackId) held.add(this.pendingIdleInferenceCallbackId);
    for (const id of this.liveInferenceStreamIds) held.add(id);
    return [...held];
  }

  /** Reclaim utility-side callbacks the host never adopted — the sole case
   *  host-GC can't cover: a sync handoff that timed out and the host never
   *  processed/adopted. Driven by an explicit two-channel DRAIN BARRIER instead
   *  of a sequence watermark: we (a) drain our broker inbound queue and (b) wait
   *  for the utility to echo an IPC barrier token, so any adopt-ack that was
   *  coming (over either channel) has definitely arrived before we ask the
   *  utility to sweep its still-unadopted, not-held ids. */
  private async reconcileUtilityCallbacks(): Promise<void> {
    if (!this.child || this.disposed) return;
    try {
      await this.awaitDrainBarrier();
      if (!this.child || this.disposed) return;
      this.child.postMessage({ type: 'reconcile-callbacks', heldIds: this.heldUtilityCallbackIds() });
    } catch {
      /* child tearing down, or barrier abandoned on dispose */
    }
  }

  /** Establish a two-channel drain barrier: flush the broker inbound queue, then
   *  ping the utility over IPC and await its pong. Resolves once BOTH channels
   *  are known-drained past this point. */
  private async awaitDrainBarrier(): Promise<void> {
    await this.drainBrokerInbound();
    if (!this.child || this.disposed) return;
    const token = ++this.drainBarrierToken;
    await new Promise<void>((resolve) => {
      this.pendingDrainResolve = resolve;
      this.child?.postMessage({ type: 'drain-ping', token });
    });
  }

  private startCallbackReconciliation(): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => void this.reconcileUtilityCallbacks(), CALLBACK_RECONCILE_MS);
  }

  private stopCallbackReconciliation(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    // Abandon any in-flight barrier so its awaiter can't hang.
    this.pendingDrainResolve?.();
    this.pendingDrainResolve = null;
  }

  /** Tell the utility it may drop a callback id. Safe + worthwhile only for a
   *  live child (a dead/disposed child already dropped its whole table). */
  private postReleaseCallback(id: string): void {
    if (this.child && !this.disposed) {
      try {
        this.child.postMessage({ type: 'release-callback', callbackId: id });
      } catch {
        /* child may be tearing down — the release is moot then */
      }
    }
  }

  /** Arm GC-release for an inference provider's raw-id callbacks, keyed to the
   *  provider object's lifetime (see the finalizer field). A fresh registration
   *  supersedes any earlier one: the prior provider object, once no in-flight
   *  turn holds it, is collected and releases its own ids independently. */
  private trackInferenceProviderCallbacks(provider: object, isAvailableId: string, streamId: string): void {
    this.inferenceProviderFinalizer.register(provider, { isAvailableId, streamId });
  }

  /** Release the isAvailableId that a collected provider left pinned by the poll
   *  loop, now that the poll has stopped using it (unregister/dispose). */
  private releaseIdleInferencePollCallback(): void {
    if (this.pendingIdleInferenceCallbackId) {
      this.postReleaseCallback(this.pendingIdleInferenceCallbackId);
      this.pendingIdleInferenceCallbackId = null;
    }
  }

  private releaseMainFunctions(functionIds: string[]): void {
    for (const id of functionIds) this.mainFunctions.delete(id);
  }

  private nextRequest(): { id: number; deferred: Deferred<unknown> } {
    const id = ++this.sequence;
    const item = deferred<unknown>();
    this.pending.set(id, item);
    return { id, deferred: item };
  }

  private invokeChildCallback(callbackId: string, args: unknown[], timeoutMs?: number): Promise<unknown> {
    if (!this.child || this.disposed) return Promise.reject(new Error('Plugin process is not running'));
    if (this.status === 'paused') return Promise.reject(new Error('Plugin process is paused'));
    const request = this.nextRequest();
    const functionIds: string[] = [];
    this.child.postMessage({ type: 'callback', id: request.id, callbackId, args: this.encode(args, functionIds) });
    // When a timeout is given, cancel (reject + REMOVE from `pending`) the
    // underlying request on expiry — not just the caller's promise. Otherwise a
    // child that never replies leaves the pending entry forever, and a periodic
    // caller (e.g. the availability poll) accretes a new orphan every interval.
    if (timeoutMs !== undefined) {
      const timer = setTimeout(() => {
        this.cancelPending(request.id, new Error(`Plugin callback timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      return request.deferred.promise.finally(() => {
        clearTimeout(timer);
        this.releaseMainFunctions(functionIds);
      });
    }
    return request.deferred.promise.finally(() => this.releaseMainFunctions(functionIds));
  }

  private invokeChildStream(callbackId: string, args: unknown[]): AsyncGenerator<unknown> {
    if (!this.child || this.disposed) throw new Error('Plugin process is not running');
    if (this.status === 'paused') throw new Error('Plugin process is paused');
    const id = ++this.sequence;
    const functionIds: string[] = [];
    const stream = new RemoteAsyncIterable(
      id,
      (requestId) => {
        this.child?.postMessage({ type: 'stream-cancel', id: requestId, direction: 'to-utility' });
        this.inboundStreams.delete(requestId);
      },
      () => this.releaseMainFunctions(functionIds),
    );
    this.inboundStreams.set(id, stream);
    this.child.postMessage({ type: 'callback-stream', id, callbackId, args: this.encode(args, functionIds) });
    return stream;
  }

  private invokeControl(command: string, args: unknown[] = []): Promise<unknown> {
    if (!this.child || this.disposed) return Promise.reject(new Error('Plugin process is not running'));
    const request = this.nextRequest();
    this.child.postMessage({ type: 'control', id: request.id, command, args: this.encode(args) });
    return request.deferred.promise;
  }

  private resolveMethod(method: string): { owner: Record<string, unknown>; fn: (...args: unknown[]) => unknown } {
    const parts = method.split('.');
    let owner = this.options.api as unknown as Record<string, unknown>;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const next = owner[parts[index]];
      if (!next || typeof next !== 'object') throw new Error(`Unknown plugin API method: ${method}`);
      owner = next as Record<string, unknown>;
    }
    const fn = owner[parts[parts.length - 1]];
    if (typeof fn !== 'function') throw new Error(`Unknown plugin API method: ${method}`);
    return { owner, fn: fn as (...args: unknown[]) => unknown };
  }

  private async dispatch(method: string, args: unknown[], adoptSink?: string[]): Promise<unknown> {
    if (method === '__ping') return null;
    if (method === '__mainCallback') {
      const callbackId = String(args[0] ?? '');
      const callback = this.mainFunctions.get(callbackId);
      if (!callback) throw new Error(`Unknown main-process plugin callback: ${callbackId}`);
      const callbackArgs = Array.isArray(args[1]) ? (args[1] as unknown[]) : [];
      return callback(...callbackArgs);
    }

    if (method === 'agent.registerInferenceProvider') {
      const descriptor = args[0] as {
        name?: unknown;
        available?: unknown;
        isAvailableId?: unknown;
        streamId?: unknown;
      };
      if (!descriptor || typeof descriptor.name !== 'string') throw new Error('Invalid inference provider descriptor');
      if (typeof descriptor.isAvailableId !== 'string' || typeof descriptor.streamId !== 'string') {
        throw new Error('Inference provider callbacks were not registered');
      }
      const isAvailableId = descriptor.isAvailableId;
      const streamId = descriptor.streamId;
      // Adopt both ids: the host now owns their lifetime (GC-driven release via
      // the provider-object finalizer + poll teardown), so the utility must not
      // reclaim them on request-settle/reconcile. Route via the caller's sink
      // (broker response) when present so the sync reply can't beat the ack.
      this.postCallbackAdopted([isAvailableId, streamId], adoptSink);
      this.inferenceAvailable = descriptor.available === true;
      this.inferenceAvailabilityCallbackId = isAvailableId;
      this.liveInferenceStreamIds.add(streamId);
      const readAvailability = () => this.status === 'running' && this.inferenceAvailable;
      const openStream = (streamOptions: Parameters<PluginInferenceProvider['stream']>[0]) =>
        this.invokeChildStream(streamId, [streamOptions]);
      const provider: PluginInferenceProvider = {
        name: descriptor.name,
        isAvailable: readAvailability,
        stream: async function* (streamOptions) {
          for await (const event of openStream(streamOptions)) {
            yield event as never;
          }
        },
      };
      // The utility no longer releases these raw-id callbacks itself (only the
      // host knows when no in-flight turn still references the provider). Tie
      // their release to GC of THIS provider object — which transitively holds
      // both ids via its stream/isAvailable closures, and which the agent
      // framework keeps alive for the duration of any in-flight turn that
      // captured it. `streamId` is held only by the provider, so it releases on
      // that GC. `isAvailableId` is ALSO held by the poll loop, so it releases
      // only once BOTH the provider is collected and the poll has moved off it.
      this.trackInferenceProviderCallbacks(provider, isAvailableId, streamId);
      this.options.api.agent.registerInferenceProvider(provider);
      this.startInferenceAvailabilityPolling();
      return null;
    }

    if (method === 'agent.unregisterInferenceProvider') {
      this.stopInferenceAvailabilityPolling();
      this.releaseIdleInferencePollCallback();
      // Do NOT drop the streamId here: an in-flight turn may still hold the
      // provider object and call stream(). Its id stays in liveInferenceStreamIds
      // until that object's finalizer runs.
      this.options.api.agent.unregisterInferenceProvider();
      return null;
    }

    const { owner, fn } = this.resolveMethod(method);
    return fn.apply(owner, args);
  }

  private startInferenceAvailabilityPolling(): void {
    this.stopInferenceAvailabilityPolling(false);
    this.inferenceAvailabilityTimer = setInterval(() => {
      if (this.inferenceAvailabilityPollPending || !this.inferenceAvailabilityCallbackId) return;
      this.inferenceAvailabilityPollPending = true;
      // Pass the timeout into invokeChildCallback so a hung/never-settling
      // isAvailable rejects AND removes its pending entry (see the method) —
      // wrapping with withTimeout alone would leak a pending request per poll.
      void this.invokeChildCallback(this.inferenceAvailabilityCallbackId, [], AVAILABILITY_TIMEOUT_MS)
        .then((available) => {
          this.inferenceAvailable = available === true;
        })
        .catch(() => {
          this.inferenceAvailable = false;
        })
        .finally(() => {
          this.inferenceAvailabilityPollPending = false;
        });
    }, AVAILABILITY_POLL_MS);
  }

  private stopInferenceAvailabilityPolling(clearIds = true): void {
    if (this.inferenceAvailabilityTimer) clearInterval(this.inferenceAvailabilityTimer);
    this.inferenceAvailabilityTimer = null;
    this.inferenceAvailabilityPollPending = false;
    if (clearIds) {
      this.inferenceAvailabilityCallbackId = null;
      this.inferenceAvailable = false;
    }
  }

  private async handleAsyncInvoke(message: Record<string, unknown>): Promise<void> {
    const id = Number(message.id);
    if (this.inboundInvocations >= CHILD_MAX_INFLIGHT_INVOCATIONS) {
      this.child?.postMessage({
        type: 'invoke-result',
        id,
        ok: false,
        error: serializeWireError(new Error('Plugin exceeded the concurrent host API call limit')),
      });
      return;
    }
    this.inboundInvocations += 1;
    const abortIds: string[] = [];
    try {
      const args = this.decode(message.args, abortIds) as unknown[];
      const value = await this.dispatch(String(message.method ?? ''), args);
      this.child?.postMessage({ type: 'invoke-result', id, ok: true, value: this.encode(value) });
    } catch (error) {
      this.child?.postMessage({ type: 'invoke-result', id, ok: false, error: serializeWireError(error) });
    } finally {
      this.releaseRemoteAbortControllers(abortIds);
      this.inboundInvocations -= 1;
    }
  }

  private async handleStreamInvoke(message: Record<string, unknown>): Promise<void> {
    const id = Number(message.id);
    if (this.inboundInvocations >= CHILD_MAX_INFLIGHT_INVOCATIONS) {
      this.child?.postMessage({
        type: 'stream-error',
        id,
        error: serializeWireError(new Error('Plugin exceeded the concurrent host stream limit')),
      });
      return;
    }
    this.inboundInvocations += 1;
    const abortIds: string[] = [];
    try {
      const args = this.decode(message.args, abortIds) as unknown[];
      const iterable = (await this.dispatch(String(message.method ?? ''), args)) as AsyncIterable<unknown>;
      if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') {
        throw new Error(`Plugin API method ${String(message.method)} did not return an async iterable`);
      }
      const iterator = iterable[Symbol.asyncIterator]();
      this.outboundStreams.set(id, iterator);
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        this.child?.postMessage({ type: 'stream-event', id, value: this.encode(next.value) });
      }
      this.child?.postMessage({ type: 'stream-end', id });
    } catch (error) {
      this.child?.postMessage({ type: 'stream-error', id, error: serializeWireError(error) });
    } finally {
      this.outboundStreams.delete(id);
      this.releaseRemoteAbortControllers(abortIds);
      this.inboundInvocations -= 1;
    }
  }

  private acceptChildMessage(): boolean {
    if (this.childMessageOverload) return false;
    const now = Date.now();
    if (now - this.childMessageWindowStartedAt >= 1_000) {
      this.childMessageWindowStartedAt = now;
      this.childMessagesInWindow = 0;
    }
    this.childMessagesInWindow += 1;
    if (this.childMessagesInWindow <= CHILD_MAX_MESSAGES_PER_SECOND) return true;

    const error = `Plugin exceeded ${CHILD_MAX_MESSAGES_PER_SECOND} IPC messages per second and was terminated`;
    this.terminateForProtocolOverload(error);
    return false;
  }

  private terminateForProtocolOverload(error: string): void {
    if (this.childMessageOverload) return;
    this.childMessageOverload = true;
    this.updateRecord({ lastError: error });
    console.error(`[Plugin:${this.options.manifest.name}] ${error}`);
    const child = this.child;
    const pid = child?.pid;
    if (child && !child.kill() && pid !== undefined) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Exit/error handling will retain the failure in diagnostics.
      }
    }
  }

  private settlePending(message: Record<string, unknown>): void {
    const id = Number(message.id);
    const item = this.pending.get(id);
    if (!item) return;
    this.pending.delete(id);
    if (message.ok === true) item.resolve(this.decode(message.value));
    else item.reject(deserializeWireError(message.error));
  }

  /** Reject + remove a still-pending request (e.g. it timed out). Idempotent: a
   *  later reply for the same id lands in settlePending as a no-op. Prevents the
   *  pending map from growing without bound when the child never replies. */
  private cancelPending(id: number, error: Error): void {
    const item = this.pending.get(id);
    if (!item) return;
    this.pending.delete(id);
    item.reject(error);
  }

  private async handleMessage(message: Record<string, unknown>): Promise<void> {
    switch (message?.type) {
      case 'activated':
        this.activation.resolve();
        this.startCallbackReconciliation();
        return;
      case 'activation-error':
        this.activation.reject(deserializeWireError(message.error));
        return;
      case 'invoke':
        await this.handleAsyncInvoke(message);
        return;
      case 'stream-invoke':
        await this.handleStreamInvoke(message);
        return;
      case 'callback-result':
      case 'control-result':
        this.settlePending(message);
        return;
      case 'drain-pong':
        // The utility echoed our drain barrier over IPC — the IPC channel is now
        // drained past this point. Resolve the awaiting reconcile.
        if (Number(message.token) === this.drainBarrierToken) {
          this.pendingDrainResolve?.();
          this.pendingDrainResolve = null;
        }
        return;
      case 'callback-stream-event': {
        const stream = this.inboundStreams.get(Number(message.id));
        if (stream) stream.push(this.decode(message.value));
        return;
      }
      case 'callback-stream-end': {
        const id = Number(message.id);
        const stream = this.inboundStreams.get(id);
        if (stream) stream.finish();
        this.inboundStreams.delete(id);
        return;
      }
      case 'callback-stream-error': {
        const id = Number(message.id);
        const stream = this.inboundStreams.get(id);
        if (stream) stream.fail(deserializeWireError(message.error));
        this.inboundStreams.delete(id);
        return;
      }
      case 'stream-cancel': {
        if (message.direction !== 'to-main') return;
        await this.outboundStreams.get(Number(message.id))?.return?.();
        return;
      }
      case 'abort': {
        const abortId = String(message.abortId ?? '');
        const controller = this.remoteAbortControllers.get(abortId);
        if (controller && !controller.signal.aborted) controller.abort(this.decode(message.reason));
        this.remoteAbortControllers.delete(abortId);
        return;
      }
      case 'diagnostic': {
        const error = typeof message.error === 'string' ? message.error : 'Plugin process error';
        const kind: DiagnosticKind = message.kind === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException';
        recordDiagnosticForPlugin(kind, this.options.manifest.name, error);
        this.updateRecord({ lastError: error });
        console.error(`[Plugin:${this.options.manifest.name}] ${error}`);
        return;
      }
      default:
        return;
    }
  }

  private writeBrokerResponse(socket: Socket, response: Record<string, unknown>): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
  }

  private async handleBrokerRequest(socket: Socket, request: BrokerRequest): Promise<void> {
    this.inFlightBrokerRequests += 1;
    const abortIds: string[] = [];
    // This handler's OWN adoption sink (passed by reference through decode +
    // dispatch). Ids adopted while handling THIS request ride back on its broker
    // response — never a shared instance field, so overlapping/timed-out
    // handlers can't corrupt each other's routing.
    const adopted: string[] = [];
    try {
      const args = this.decode(request.args, abortIds, adopted) as unknown[];
      const value = await this.dispatch(request.method, args, adopted);
      this.writeBrokerResponse(socket, {
        id: request.id,
        ok: true,
        value: this.encode(value),
        adopted: adopted.length ? adopted : undefined,
      });
    } catch (error) {
      this.writeBrokerResponse(socket, {
        id: request.id,
        ok: false,
        error: serializeWireError(error),
        adopted: adopted.length ? adopted : undefined,
      });
    } finally {
      this.releaseRemoteAbortControllers(abortIds);
      this.inFlightBrokerRequests -= 1;
      if (this.inFlightBrokerRequests === 0) {
        const waiters = this.brokerDrainWaiters;
        this.brokerDrainWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  /** Resolve once no broker (sync-call) request is mid-flight — so any adopt-ack
   *  a still-processing timed-out handoff is about to emit has been sent. */
  private drainBrokerInbound(): Promise<void> {
    if (this.inFlightBrokerRequests === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.brokerDrainWaiters.push(resolve));
  }

  private authenticateToken(candidate: unknown): boolean {
    if (typeof candidate !== 'string') return false;
    const expected = Buffer.from(this.brokerToken);
    const received = Buffer.from(candidate);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  private attachBrokerSocket(socket: Socket): void {
    let authenticated = false;
    let buffer = '';
    let windowStartedAt = Date.now();
    let callsInWindow = 0;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > BROKER_MAX_BUFFER_BYTES) {
        socket.destroy(new Error('Plugin broker message exceeded the size limit'));
        return;
      }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          socket.destroy(new Error('Plugin broker received malformed JSON'));
          return;
        }
        if (!authenticated) {
          if (parsed.type !== 'hello' || !this.authenticateToken(parsed.token)) {
            socket.destroy(new Error('Plugin broker authentication failed'));
            return;
          }
          authenticated = true;
          this.brokerSocket = socket;
          this.writeBrokerResponse(socket, { type: 'ready' });
          continue;
        }

        const now = Date.now();
        if (now - windowStartedAt >= 1_000) {
          windowStartedAt = now;
          callsInWindow = 0;
        }
        callsInWindow += 1;
        const request = parsed as unknown as BrokerRequest;
        if (callsInWindow > BROKER_MAX_CALLS_PER_SECOND) {
          this.writeBrokerResponse(socket, {
            id: request.id,
            ok: false,
            error: serializeWireError(new Error('Plugin synchronous API rate limit exceeded')),
          });
          this.terminateForProtocolOverload(
            `Plugin exceeded ${BROKER_MAX_CALLS_PER_SECOND} synchronous API calls per second and was terminated`,
          );
          continue;
        }
        void this.handleBrokerRequest(socket, request);
      }
    });
    socket.on('close', () => {
      if (this.brokerSocket === socket) this.brokerSocket = null;
    });
    socket.on('error', () => {
      // Exit handling reports the owning utility process failure if needed.
    });
  }

  private async startBroker(): Promise<void> {
    const server = createServer((socket) => this.attachBrokerSocket(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Plugin broker did not receive a TCP port'));
          return;
        }
        this.brokerPort = address.port;
        resolve();
      });
    });
  }

  private pipeOutput(stream: NodeJS.ReadableStream | null, level: 'info' | 'error'): void {
    if (!stream) return;
    const readable = stream as Readable;
    let remaining = OUTPUT_BYTES_PER_SECOND;
    let paused = false;
    const timer = setInterval(() => {
      remaining = OUTPUT_BYTES_PER_SECOND;
      if (paused) {
        paused = false;
        readable.resume();
      }
    }, 1_000);
    this.outputTimers.push(timer);
    readable.on('data', (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (remaining <= 0) {
        if (!paused) {
          paused = true;
          readable.pause();
        }
        return;
      }
      const output = Buffer.from(text).subarray(0, remaining).toString('utf8').trimEnd();
      remaining -= Buffer.byteLength(output);
      if (output) console[level](`[Plugin:${this.options.manifest.name}] ${output}`);
      if (remaining <= 0 && !paused) {
        paused = true;
        readable.pause();
      }
    });
  }

  private handleExit(code: number): void {
    const ownsRecord = processRecordOwners.get(this.options.manifest.name) === this.recordOwner;
    const record = ownsRecord ? processRecords.get(this.options.manifest.name) : undefined;
    const error = record?.lastError ?? `Plugin utility process exited with code ${code}`;
    const priorCrashCount = record?.crashCount ?? processCrashCounts.get(this.options.manifest.name) ?? 0;
    const crashCount = this.expectedExit ? priorCrashCount : priorCrashCount + 1;
    if (!this.expectedExit) processCrashCounts.set(this.options.manifest.name, crashCount);
    this.updateRecord({
      // Never join an exited PID to future app metrics: the OS may reuse it for
      // a different Kai child process later in the same session.
      pid: null,
      status: this.expectedExit ? 'stopping' : 'crashed',
      crashCount,
      lastExitCode: code,
      lastError: this.expectedExit ? (record?.lastError ?? null) : error,
    });
    this.releaseRuntimeResources(new Error(error));
    this.exit.resolve(code);
    if (!this.expectedExit) {
      this.activation.reject(new Error(error));
      this.unexpectedExitCleanup = Promise.resolve(this.options.onUnexpectedExit({ code, error })).catch(
        (cleanupError) => {
          console.error(`[Plugin:${this.options.manifest.name}] Crash cleanup failed:`, cleanupError);
        },
      );
    }
  }

  async activate(): Promise<void> {
    await this.startBroker();
    const child = utilityProcess.fork(this.options.utilityEntryPath, [], {
      // Match the main process's historical cwd semantics. Plugin assets should
      // continue to use api.pluginDir; silently changing process.cwd() to the
      // plugin folder would break existing relative-path behavior.
      cwd: process.cwd(),
      env: { ...process.env },
      execArgv: [],
      stdio: 'pipe',
      serviceName: `Kai Plugin: ${this.options.manifest.name}`,
      // Plugins may bundle native addons. Loading them in the dedicated Plugin
      // helper preserves the capability they had in the main process while
      // keeping any native crash inside this utility process.
      allowLoadingUnsignedLibraries: process.platform === 'darwin',
    });
    this.child = child;
    this.pipeOutput(child.stdout, 'info');
    this.pipeOutput(child.stderr, 'error');
    child.on('message', (message) => {
      if (!this.acceptChildMessage()) return;
      void this.handleMessage(message as Record<string, unknown>);
    });
    child.on('error', (type, location) => {
      this.updateRecord({ lastError: `${type}${location ? ` at ${location}` : ''}` });
    });
    child.once('exit', (code) => this.handleExit(code));

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        const pid = child.pid ?? null;
        this.updateRecord({ pid, status: 'starting', startedAt: new Date().toISOString() });
        child.postMessage({
          type: 'init',
          manifest: this.options.manifest,
          pluginDir: this.options.pluginDir,
          backendPath: this.options.backendPath,
          fileHash: this.options.fileHash,
          apiVersion: this.options.api.host.apiVersion(),
          capabilities: this.options.api.host.capabilities(),
          syncBridge: {
            host: '127.0.0.1',
            port: this.brokerPort,
            token: this.brokerToken,
            workerPath: this.options.syncWorkerPath,
          },
        });
        resolve();
      });
      child.once('exit', (code) => reject(new Error(`Plugin process exited before spawn completed (${code})`)));
    });

    try {
      await withTimeout(
        this.activation.promise,
        ACTIVATION_TIMEOUT_MS,
        `Plugin "${this.options.manifest.name}" activation`,
      );
      this.updateRecord({ status: 'running', pid: child.pid ?? this.pid });
    } catch (error) {
      await this.stop(true);
      throw error;
    }
  }

  notifyConfigChanged(config: unknown): void {
    if (this.status === 'paused') {
      this.hasPausedConfig = true;
      this.pausedConfig = config;
      return;
    }
    void this.invokeControl('config-changed', [config]).catch((error) => {
      console.error(`[PluginManager] Error in plugin "${this.options.manifest.name}" onConfigChanged:`, error);
    });
  }

  async deactivate(): Promise<void> {
    if (this.disposed) return;
    if (!this.child) {
      await this.stop(true);
      return;
    }
    if (this.child.pid === undefined) {
      await this.stop(true);
      return;
    }
    if (this.status === 'paused') this.resume();
    this.expectedExit = true;
    try {
      await withTimeout(
        this.invokeControl('deactivate'),
        DEACTIVATION_TIMEOUT_MS,
        `Plugin "${this.options.manifest.name}" deactivation`,
      );
    } finally {
      await this.stop(true);
    }
  }

  pause(): void {
    if (!this.canPause) throw new Error('Pausing plugin processes is not supported on Windows');
    if (this.status !== 'running') throw new Error(`Plugin process is not running (status: ${this.status})`);
    const pid = this.child?.pid;
    if (pid === undefined) throw new Error('Plugin process has no live PID');
    process.kill(pid, 'SIGSTOP');
    this.stopInferenceAvailabilityPolling(false);
    this.updateRecord({ status: 'paused' });
    // Calls already waiting on this process must not pin the main agent loop
    // until somebody manually resumes it. Late results after resume are safely
    // ignored because their request IDs have been removed.
    this.rejectPending(new Error(`Plugin "${this.options.manifest.name}" is paused`));
    this.cancelOutboundStreams();
  }

  resume(): void {
    if (!this.canPause) throw new Error('Resuming plugin processes is not supported on Windows');
    if (this.status !== 'paused') throw new Error(`Plugin process is not paused (status: ${this.status})`);
    const pid = this.child?.pid;
    if (pid === undefined) throw new Error('Plugin process has no live PID');
    process.kill(pid, 'SIGCONT');
    this.updateRecord({ status: 'running' });
    if (this.inferenceAvailabilityCallbackId) this.startInferenceAvailabilityPolling();
    if (this.hasPausedConfig) {
      const config = this.pausedConfig;
      this.hasPausedConfig = false;
      this.pausedConfig = undefined;
      this.notifyConfigChanged(config);
    }
  }

  /** Force-terminate this plugin only and retain its crashed diagnostic row. */
  async kill(): Promise<void> {
    if (!this.child || this.disposed || this.child.pid === undefined) {
      throw new Error('Plugin process is not running');
    }
    this.expectedExit = false;
    this.updateRecord({ lastError: 'Plugin process was terminated by the user' });
    // A stopped POSIX process does not act on SIGTERM until continued.
    if (this.status === 'paused' && process.platform !== 'win32') {
      process.kill(this.child.pid, 'SIGCONT');
    }
    await this.terminateChild(this.child);
    await this.unexpectedExitCleanup;
  }

  private async terminateChild(child: UtilityProcess): Promise<void> {
    const pid = child.pid;
    if (pid === undefined) return;
    const label = `Plugin "${this.options.manifest.name}" process exit`;
    const gracefulSent = child.kill();
    try {
      await withTimeout(this.exit.promise, 5_000, label);
      return;
    } catch (gracefulError) {
      try {
        // A native deadlock may not respond to Electron's normal termination
        // request. Escalate by PID so disable/kill cannot leave an untracked
        // backend consuming resources indefinitely.
        process.kill(pid, 'SIGKILL');
      } catch (forceError) {
        if (!gracefulSent) {
          throw new Error('Electron and the OS could not terminate the plugin process', {
            cause: forceError,
          });
        }
      }
      try {
        await withTimeout(this.exit.promise, 2_000, label);
      } catch {
        throw gracefulError;
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
    for (const stream of this.inboundStreams.values()) stream.fail(error);
    this.inboundStreams.clear();
  }

  private cancelOutboundStreams(): void {
    for (const iterator of this.outboundStreams.values()) {
      try {
        void Promise.resolve(iterator.return?.()).catch(() => {});
      } catch {
        // Stream cancellation is best-effort during suspension/teardown.
      }
    }
    this.outboundStreams.clear();
  }

  /** Release every main-side live handle while optionally retaining the crash row. */
  private releaseRuntimeResources(error: Error): void {
    if (this.runtimeReleased) return;
    this.runtimeReleased = true;
    this.stopInferenceAvailabilityPolling();
    this.stopCallbackReconciliation();
    // Release any barrier awaiting broker drain so it can't hang past teardown.
    const drainWaiters = this.brokerDrainWaiters;
    this.brokerDrainWaiters = [];
    for (const resolve of drainWaiters) resolve();
    this.rejectPending(error);
    this.cancelOutboundStreams();
    this.brokerSocket?.destroy();
    this.brokerSocket = null;
    this.server?.close();
    this.server = null;
    for (const timer of this.outputTimers) clearInterval(timer);
    this.outputTimers = [];
    for (const controller of this.remoteAbortControllers.values()) {
      if (!controller.signal.aborted) controller.abort(error);
    }
    this.remoteAbortControllers.clear();
    this.mainFunctions.clear();
    this.hasPausedConfig = false;
    this.pausedConfig = undefined;
    this.child = null;
  }

  async stop(expected = true): Promise<void> {
    if (this.disposed) return;
    this.expectedExit = expected;
    const wasPaused = this.status === 'paused';
    this.updateRecord({ status: 'stopping' });
    const child = this.child;
    if (child?.pid !== undefined) {
      if (wasPaused && process.platform !== 'win32') process.kill(child.pid, 'SIGCONT');
      try {
        await this.terminateChild(child);
      } catch (error) {
        this.updateRecord({ lastError: error instanceof Error ? error.message : String(error) });
      }
    }
    this.dispose();
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseRuntimeResources(new Error('Plugin process stopped'));
    if (processRecordOwners.get(this.options.manifest.name) === this.recordOwner) {
      processRecordOwners.delete(this.options.manifest.name);
      processRecords.delete(this.options.manifest.name);
    }
  }
}

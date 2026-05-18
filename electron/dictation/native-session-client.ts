import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { buildSwiftFallbackEnv, resolveCompiledHelperBinary, resolveMaterializedHelperPath } from '../computer-use/permissions.js';
import type { PartialTypingConfig, PartialTypingStrategy } from './partial-typing.js';

export type DictationNativeTypingMode = 'ax' | 'kb' | 'idle';

export type DictationNativeTargetSnapshot = {
  appName: string;
  bundleId: string | null;
  pid: number | null;
  capturedAt: number;
};

export type DictationNativeSessionResponse = {
  ok?: boolean;
  error?: string;
  errorCode?: string;
  typingMode?: DictationNativeTypingMode;
  targetPid?: number | null;
  targetName?: string;
  targetBundleId?: string | null;
  capturedAt?: number;
  capturedAx?: boolean;
  partialText?: string;
  strategy?: PartialTypingStrategy | 'disabled' | null;
  applied?: boolean;
  // Debug-only fields (populated when debugLogging is enabled)
  debug?: {
    role?: string;
    subrole?: string;
    identifier?: string;
    placeholderValue?: string;
    valueLength?: number;
    selectedRangeLocation?: number;
    selectedRangeLength?: number;
    isSecure?: boolean;
    axValueError?: string;
    axSelectionError?: string;
  };
};

export type DictationNativeBeginParams = {
  partialTyping?: PartialTypingConfig;
  livePartials?: boolean;
  allowBlindKeyboardFullPatch: boolean;
  ownPid: number;
  ownAppName: string;
  debugLogging?: boolean;
};

type DictationNativeEvent =
  | { event: 'ready'; protocolVersion?: number }
  | { event: 'targetDirty'; reason?: string; kind?: string; eventType?: string; keyCode?: number }
  | { event: 'monitor-disabled'; reason?: string };

type PendingRequest = {
  resolve: (value: DictationNativeSessionResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
};

export type DictationNativeSessionClientOptions = {
  onTargetDirty?: (reason: string) => void;
  onExit?: (message: string) => void;
  onProtocolError?: (message: string) => void;
};

export class DictationNativeSessionError extends Error {
  readonly errorCode?: string;

  constructor(message: string, errorCode?: string) {
    super(message);
    this.name = 'DictationNativeSessionError';
    this.errorCode = errorCode;
  }
}

const READY_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 8000;

export class DictationNativeSessionClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private intentionallyClosing = false;
  private ready = false;

  constructor(private readonly options: DictationNativeSessionClientOptions = {}) {}

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.readyPromise) return this.readyPromise;

    const binaryPath = resolveCompiledHelperBinary();
    const command = binaryPath ?? 'xcrun';
    const args = binaryPath
      ? ['dictationSession']
      : ['swift', resolveMaterializedHelperPath(), 'dictationSession'];

    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: binaryPath ? process.env : buildSwiftFallbackEnv(),
    });

    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk.toString()));
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) this.options.onProtocolError?.(text);
    });
    this.child.on('error', (error) => this.handleExit(error.message));
    this.child.on('exit', (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.handleExit(`Dictation native helper exited with ${suffix}`);
    });

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DictationNativeSessionError('Dictation native helper did not become ready in time.', 'ready_timeout'));
      }, READY_TIMEOUT_MS);
      this.resolveReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this.rejectReady = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });

    return this.readyPromise;
  }

  async beginSession(params: DictationNativeBeginParams): Promise<DictationNativeSessionResponse> {
    return this.checkedRequest('beginSession', params);
  }

  /**
   * Like beginSession but does not throw on `ok: false` — returns the response
   * directly so the caller can handle soft failures (e.g. cursor_unverified)
   * while still using the target PID and other fields from the response.
   */
  async beginSessionUnchecked(params: DictationNativeBeginParams): Promise<DictationNativeSessionResponse> {
    await this.start();
    if (!this.child || this.child.killed) {
      throw new DictationNativeSessionError('Dictation native helper is not running.', 'not_running');
    }
    return this.request('beginSession', params);
  }

  async startTargetTracking(): Promise<DictationNativeSessionResponse> {
    return this.checkedRequest('startTargetTracking', {});
  }

  async stopTargetTracking(): Promise<DictationNativeSessionResponse> {
    return this.checkedRequest('stopTargetTracking', {});
  }

  async refreshTarget(): Promise<DictationNativeSessionResponse> {
    return this.checkedRequest('refreshTarget', {});
  }

  async applyPartial(text: string): Promise<DictationNativeSessionResponse> {
    return this.checkedRequest('applyPartial', { text });
  }

  async applyFinal(text: string): Promise<DictationNativeSessionResponse> {
    return this.checkedRequest('applyFinal', { text });
  }

  async endSession(): Promise<void> {
    if (!this.child) return;
    this.intentionallyClosing = true;
    try {
      await this.request('endSession', {}, 1500);
    } catch {
      // Fall through to process cleanup below.
    } finally {
      this.close();
    }
  }

  close(): void {
    this.intentionallyClosing = true;
    if (this.child && !this.child.killed) {
      try {
        this.child.stdin.end();
      } catch {
        // Ignore broken pipes during shutdown.
      }
      try {
        this.child.kill('SIGTERM');
      } catch {
        // Ignore teardown failures.
      }
    }
    this.rejectAll(new DictationNativeSessionError('Dictation native helper was closed.', 'closed'));
    this.child = null;
    this.ready = false;
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
  }

  getTargetSnapshot(response: DictationNativeSessionResponse): DictationNativeTargetSnapshot | null {
    const targetPid = normalizePid(response.targetPid);
    const appName = typeof response.targetName === 'string' ? response.targetName.trim() : '';
    if (!appName || targetPid == null) return null;
    return {
      appName,
      bundleId: typeof response.targetBundleId === 'string' && response.targetBundleId.trim()
        ? response.targetBundleId.trim()
        : null,
      pid: targetPid,
      capturedAt: normalizeTimestamp(response.capturedAt),
    };
  }

  private async checkedRequest(method: string, params: Record<string, unknown>): Promise<DictationNativeSessionResponse> {
    const response = await this.request(method, params);
    if (response.ok === false) {
      throw new DictationNativeSessionError(response.error ?? `${method} failed`, response.errorCode);
    }
    return response;
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<DictationNativeSessionResponse> {
    await this.start();
    if (!this.child || this.child.killed) {
      throw new DictationNativeSessionError('Dictation native helper is not running.', 'not_running');
    }

    const id = String(this.nextId++);
    const payload = JSON.stringify({ id, method, params });
    return new Promise<DictationNativeSessionResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DictationNativeSessionError(`${method} timed out.`, 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.child?.stdin.write(`${payload}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleStdout(text: string): void {
    this.stdoutBuffer += text;
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      this.options.onProtocolError?.(`Malformed dictation helper JSON: ${line.slice(0, 200)}`);
      return;
    }

    if (!payload || typeof payload !== 'object') {
      this.options.onProtocolError?.('Dictation helper emitted a non-object payload.');
      return;
    }

    const record = payload as Record<string, unknown>;
    if (typeof record.id === 'string') {
      this.resolveRequest(record.id, record as DictationNativeSessionResponse);
      return;
    }

    this.handleEvent(record as DictationNativeEvent);
  }

  private resolveRequest(id: string, response: DictationNativeSessionResponse): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(response);
  }

  private handleEvent(event: DictationNativeEvent): void {
    if (event.event === 'ready') {
      this.ready = true;
      this.resolveReady?.();
      return;
    }

    if (event.event === 'targetDirty') {
      const reason = event.reason
        ?? [event.kind, event.eventType, event.keyCode].filter(value => value != null).join(':')
        ?? 'native-event';
      this.options.onTargetDirty?.(reason || 'native-event');
      return;
    }

    if (event.event === 'monitor-disabled') {
      this.options.onProtocolError?.(`Dictation target monitor disabled: ${event.reason ?? 'unknown'}`);
    }
  }

  private handleExit(message: string): void {
    const shouldNotify = !this.intentionallyClosing && (this.child != null || this.readyPromise != null);
    this.rejectReady?.(new DictationNativeSessionError(message, 'helper_exit'));
    this.rejectAll(new DictationNativeSessionError(message, 'helper_exit'));
    this.child = null;
    this.ready = false;
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
    if (shouldNotify) this.options.onExit?.(message);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function normalizePid(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return Date.now();
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { HelperUnavailable } from './types.js';

export type HelperRequest = { id: number; cmd: string; args?: unknown };
export type HelperResponse = { id: number; ok: boolean; data?: unknown; error?: string };
export type HelperEvent = { event: string } & Record<string, unknown>;

type Pending = {
  resolve: (value: HelperResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout | null;
};

/**
 * Cap on the un-flushed stdout line buffer. A helper that emits a huge line
 * without a trailing newline (bug, or a swapped-out/compromised binary) would
 * otherwise grow this string unbounded and exhaust main-process memory. 16 MiB
 * is far above any legitimate NDJSON line the helpers produce.
 */
const MAX_STDOUT_BUFFER_BYTES = 16 * 1024 * 1024;

/** Grace period after SIGTERM before escalating to SIGKILL on stop(). */
const STOP_SIGKILL_DELAY_MS = 2000;

/**
 * Long-lived child process speaking newline-delimited JSON over stdio.
 *
 * Request shape: `{ "id": <n>, "cmd": "<name>", "args": <any> }`
 * Response shape: `{ "id": <n>, "ok": <bool>, "data"?: <any>, "error"?: <string> }`
 * Event shape (no id): `{ "event": "<name>", ... }` — delivered to subscribers.
 *
 * All three native helpers (Swift, PowerShell, bash) and the AT-SPI Python
 * helper speak this protocol so the calling code stays identical across
 * platforms.
 */
export class HelperProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly subscribers = new Map<string, Set<(payload: HelperEvent) => void>>();
  private stdoutBuffer = '';
  private spawnError: string | null = null;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly options: { env?: NodeJS.ProcessEnv; cwd?: string; defaultTimeoutMs?: number } = {},
  ) {}

  isRunning(): boolean {
    return this.child !== null && !this.child.killed && this.child.exitCode === null;
  }

  start(): void {
    if (this.isRunning()) return;
    this.spawnError = null;
    this.stdoutBuffer = '';
    try {
      this.child = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.options.env,
        cwd: this.options.cwd,
      });
    } catch (error) {
      this.spawnError = error instanceof Error ? error.message : String(error);
      this.child = null;
      return;
    }

    this.child.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf8');
      // Guard against a helper that never emits a newline (bug or a
      // swapped-out/compromised binary): an unbounded line buffer would exhaust
      // main-process memory. Kill the helper and fail its in-flight calls.
      if (this.stdoutBuffer.length > MAX_STDOUT_BUFFER_BYTES) {
        this.stdoutBuffer = '';
        const reason = `helper produced an oversized line (> ${MAX_STDOUT_BUFFER_BYTES} bytes)`;
        try {
          this.child?.kill('SIGKILL');
        } catch {
          /* best-effort */
        }
        this.child = null;
        this.spawnError = reason;
        this.failAllPending(new HelperUnavailable(reason));
        return;
      }
      while (true) {
        const newline = this.stdoutBuffer.indexOf('\n');
        if (newline === -1) break;
        const line = this.stdoutBuffer.slice(0, newline);
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
        if (line.trim()) this.handleLine(line);
      }
    });

    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) console.warn(`[helper:${this.command}] ${text}`);
    });

    this.child.on('error', (error) => {
      this.spawnError = error.message;
      this.failAllPending(new HelperUnavailable(error.message));
    });

    this.child.on('exit', (code, signal) => {
      const reason = `helper exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`;
      this.failAllPending(new HelperUnavailable(reason));
      this.child = null;
    });
  }

  stop(): void {
    const child = this.child;
    if (child && !child.killed) {
      child.kill('SIGTERM');
      // Escalate to SIGKILL if the helper ignores SIGTERM, so a wedged helper
      // can't linger. The exit handler already nulls this.child + fails pending;
      // this timer only fires if the process is still alive after the grace
      // period. `unref` so a pending kill-timer never keeps the app alive.
      const killTimer = setTimeout(() => {
        if (!child.killed && child.exitCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }, STOP_SIGKILL_DELAY_MS);
      killTimer.unref?.();
    }
    this.child = null;
    this.failAllPending(new HelperUnavailable('helper stopped'));
  }

  /** Send a request and await the matching `{id}` response. */
  async call<T = unknown>(cmd: string, args?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.isRunning()) {
      this.start();
    }
    if (!this.isRunning() || !this.child) {
      throw new HelperUnavailable(this.spawnError ?? `unable to spawn ${this.command}`);
    }

    const id = this.nextId++;
    const request: HelperRequest = { id, cmd, args };

    return new Promise<T>((resolve, reject) => {
      const limit = timeoutMs ?? this.options.defaultTimeoutMs ?? 15000;
      const timer =
        limit > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new HelperUnavailable(`helper '${cmd}' timed out after ${limit}ms`));
            }, limit)
          : null;

      this.pending.set(id, {
        resolve: (response) => {
          if (timer) clearTimeout(timer);
          if (response.ok) {
            resolve(response.data as T);
          } else {
            reject(new Error(response.error ?? `helper '${cmd}' failed`));
          }
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
        timer,
      });

      try {
        this.child!.stdin.write(JSON.stringify(request) + '\n');
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new HelperUnavailable(error instanceof Error ? error.message : String(error)));
      }
    });
  }

  /** Subscribe to unsolicited `{ "event": name, ... }` messages from the helper. */
  subscribe(event: string, handler: (payload: HelperEvent) => void): () => void {
    let set = this.subscribers.get(event);
    if (!set) {
      set = new Set();
      this.subscribers.set(event, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  private handleLine(line: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      console.warn(`[helper:${this.command}] non-JSON line: ${line.slice(0, 200)}`);
      return;
    }
    if (!payload || typeof payload !== 'object') return;

    const obj = payload as Record<string, unknown>;
    if (typeof obj.id === 'number') {
      const pending = this.pending.get(obj.id);
      if (pending) {
        this.pending.delete(obj.id);
        pending.resolve({
          id: obj.id,
          ok: obj.ok === true,
          data: obj.data,
          error: typeof obj.error === 'string' ? obj.error : undefined,
        });
      }
      return;
    }
    if (typeof obj.event === 'string') {
      const set = this.subscribers.get(obj.event);
      if (set) {
        for (const handler of set) handler(obj as HelperEvent);
      }
    }
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

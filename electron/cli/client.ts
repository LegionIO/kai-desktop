import net from 'net';
import type { Socket } from 'net';

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

type EventHandler = (data: unknown) => void;

const INVOKE_TIMEOUT_MS = 60_000;
/** Client → backend ping cadence. Must be < the server's heartbeat timeout (12s). */
const HEARTBEAT_INTERVAL_MS = 5_000;
/** Max WALL-CLOCK silence (no inbound bytes at all) before the client declares
 *  the backend dead. Time-based, NOT tick-counted: if the event loop stalls or
 *  the process is briefly backgrounded, setInterval callbacks COALESCE and can
 *  fire several times back-to-back — a tick counter would jump straight past the
 *  limit and tear down a perfectly-alive connection (the observed random
 *  "reconnected" flapping). Measuring real elapsed time since the last inbound
 *  byte is immune to that: a burst of coalesced ticks all see (roughly) the same
 *  `now`, so a live backend (whose pong just arrived, or arrives on the next
 *  tick) is never falsely reaped. ~18s tolerates a stall + a slow pong while
 *  staying under the server's 12-24s teardown window. */
const HEARTBEAT_DEAD_MS = 18_000;
/** Max buffered bytes for a single inbound frame before we treat the peer as
 *  hostile/broken and drop the socket. Mirrors local-server.ts's MAX_FRAME_BYTES
 *  (8 MiB) so a backend that never sends a newline can't grow this buffer
 *  without bound (memory-exhaustion guard; defense-in-depth — the backend is
 *  local + authed, but parity with the server's own cap). */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * Pure liveness predicate for the heartbeat: is the backend stale (no inbound
 * byte for longer than `deadMs`)? Time-based on purpose — a burst of coalesced
 * setInterval callbacks (after an event-loop stall / backgrounding) all observe
 * ~the same `now`, so they can't stack a false positive the way a per-tick miss
 * counter did. Exported for testing.
 */
export function isBackendStale(lastInboundAt: number, now: number, deadMs: number): boolean {
  return now - lastInboundAt > deadMs;
}

/**
 * CLI-side client for the leader's local IPC socket. Speaks the same
 * newline-delimited JSON envelope as `local-server.ts`:
 *   request:  {id,type:'invoke',channel,args}\n
 *   response: {id,type:'result'|'error',data|message}\n
 *   event:    {type:'event',channel,data}\n  (server-pushed)
 *
 * Exposes an ergonomic `invoke(channel, ...args)` promise API plus
 * `on(channel, cb)` event subscription, mirroring the web bridge's
 * `window.app` semantics so CLI code reads like renderer code.
 */
export class LocalBridgeClient {
  private socket: Socket | null = null;
  private buffer = '';
  private nextId = 0;
  private readonly pending = new Map<string, PendingCall>();
  private readonly listeners = new Map<string, Set<EventHandler>>();
  private readonly disconnectHandlers = new Set<() => void>();
  private connected = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** Backend version reported in the auth result (empty if unknown / older backend). */
  private _serverVersion = '';
  /** Wall-clock ms of the last inbound byte from the backend. Liveness is judged
   *  by elapsed time since this (see HEARTBEAT_DEAD_MS), not a tick counter, so
   *  coalesced timer callbacks after an event-loop stall can't false-positive. */
  private lastInboundAt = 0;
  private intentionalClose = false; // set by close() so disconnect handlers can tell crash from quit

  constructor(
    private readonly socketPath: string,
    private readonly authToken?: string,
  ) {}

  /** Connect once. Rejects if the socket cannot be reached. */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.buffer = ''; // fresh connection: never carry partial data across sockets
      this.intentionalClose = false;
      const socket = net.createConnection(this.socketPath);
      socket.setNoDelay(true);

      const onError = (err: Error): void => {
        if (!this.connected) reject(err);
      };

      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        this.socket = socket;
        this.connected = true;
        this.wire(socket);
        // Authenticate before resolving: the backend refuses invoke/send until
        // the per-install bridge token is presented. If no token is configured
        // (older backend), skip the handshake and connect as before.
        if (!this.authToken) {
          resolve();
          return;
        }
        this.authenticate()
          .then(() => resolve())
          .catch((err) => {
            this.teardown(false);
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      });
    });
  }

  /** Send the auth handshake and await its result, reusing the pending-call map. */
  private authenticate(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = this.socket;
      if (!socket) {
        reject(new Error('not connected'));
        return;
      }
      const id = String(++this.nextId);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('timeout waiting for auth'));
      }, INVOKE_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (data) => {
          const v = (data as { serverVersion?: unknown } | undefined)?.serverVersion;
          if (typeof v === 'string') this._serverVersion = v;
          resolve();
        },
        reject,
        timer,
      });
      try {
        socket.write(JSON.stringify({ id, type: 'auth', token: this.authToken }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Re-establish the socket after an unexpected drop (leader crash), preserving
   * event listeners so the caller's subscriptions survive. Retries connecting to
   * the socket path until `deadlineMs` elapses (a survivor may be re-electing /
   * respawning a backend). Returns true on success.
   */
  async reconnect(deadlineMs: number): Promise<boolean> {
    const start = Date.now();
    for (;;) {
      try {
        await this.connect();
        return true;
      } catch {
        if (Date.now() - start > deadlineMs) return false;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  /** True if the last disconnect was caused by our own close(), not a drop. */
  wasIntentionalClose(): boolean {
    return this.intentionalClose;
  }

  /** Backend version from the auth handshake ('' if unknown / an older backend
   *  that predates the version field). Used to warn on a CLI↔backend mismatch. */
  get serverVersion(): string {
    return this._serverVersion;
  }

  private wire(socket: Socket): void {
    socket.on('data', (chunk: Buffer) => {
      // ANY inbound byte proves the backend is alive — record the timestamp
      // (not only on a 'pong'). During a busy agent stream the event-loop can
      // delay a pong past a tick even though data is flowing; judging liveness
      // by time-since-last-byte prevents a false "dead backend" mid-response
      // (which tore the socket down and overwrote the streaming reply with
      // "reconnected"). Mirrors the server's own alive-on-any-traffic rule.
      this.lastInboundAt = Date.now();
      this.buffer += chunk.toString('utf-8');
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (line.trim()) this.dispatch(line);
      }
      // Bound the buffer AFTER draining complete frames: what remains is a single
      // partial (unterminated) frame. Cap THAT — a peer streaming bytes with no
      // newline would otherwise grow it without limit. Checking before the drain
      // (against the whole accumulated buffer) would wrongly trip on a legitimate
      // burst of many small newline-delimited frames arriving in one chunk. On
      // overrun, drop the socket ('close'/'error' → teardown → recovery).
      if (this.buffer.length > MAX_FRAME_BYTES) {
        this.buffer = '';
        socket.destroy();
        return;
      }
    });

    // Heartbeat: ping the backend periodically. If NO inbound byte arrives for
    // HEARTBEAT_DEAD_MS the backend is gone (crash, quit, sleep) even if the OS
    // hasn't delivered a socket close yet — tear down so callers learn promptly.
    this.lastInboundAt = Date.now();
    // Defensive: clear any prior interval before arming a new one, so a wire()
    // that runs without a preceding teardown can't leak a duplicate heartbeat.
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected || !this.socket) return;
      // Time-based liveness: only declare dead when REAL elapsed silence exceeds
      // the threshold. Immune to coalesced ticks after an event-loop stall (they
      // all observe ~the same `now`, so they can't stack a false positive).
      if (isBackendStale(this.lastInboundAt, Date.now(), HEARTBEAT_DEAD_MS)) {
        this.socket.destroy();
        return;
      }
      try {
        this.socket.write(JSON.stringify({ type: 'ping' }) + '\n');
      } catch {
        this.socket.destroy();
      }
    }, HEARTBEAT_INTERVAL_MS);

    const onGone = (): void => this.teardown(true);

    socket.on('close', onGone);
    socket.on('error', onGone);
  }

  /**
   * Tear down the current connection exactly once: clear the heartbeat, reject
   * all in-flight calls, drop the socket. `fireDisconnect` runs the disconnect
   * handlers (true for an unexpected drop → triggers recovery; false for our own
   * close() → the caller is quitting intentionally).
   */
  private teardown(fireDisconnect: boolean): void {
    if (!this.connected && !this.socket) return;
    this.connected = false;
    // Clear the backend version: a reconnect may land on a DIFFERENT backend
    // (survivor re-election / freshly spawned), so a stale version must not
    // linger past the drop. It's re-populated by the next auth handshake.
    this._serverVersion = '';
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const sock = this.socket;
    this.socket = null;
    if (sock) {
      try {
        sock.removeAllListeners();
        sock.destroy();
      } catch {
        /* ignore */
      }
    }
    // Reject all in-flight calls so callers don't hang on a dead leader.
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new Error('local bridge connection closed'));
    }
    this.pending.clear();
    if (fireDisconnect) {
      this.disconnectHandlers.forEach((cb) => {
        try {
          cb();
        } catch {
          /* ignore */
        }
      });
    }
  }

  private dispatch(line: string): void {
    let msg: { id?: string; type?: string; channel?: string; data?: unknown; message?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.type === 'pong') {
      // Liveness is already recorded in the 'data' handler (lastInboundAt is set
      // for ANY inbound byte); a pong is just a no-op keepalive to consume here.
      return;
    }

    if ((msg.type === 'result' || msg.type === 'error') && msg.id) {
      const call = this.pending.get(msg.id);
      if (!call) return;
      this.pending.delete(msg.id);
      clearTimeout(call.timer);
      if (msg.type === 'error') call.reject(new Error(msg.message ?? 'bridge error'));
      else call.resolve(msg.data);
      return;
    }

    if (msg.type === 'event' && msg.channel) {
      const set = this.listeners.get(msg.channel);
      if (set) {
        for (const cb of set) {
          try {
            cb(msg.data);
          } catch {
            // handler errors must not break the read loop
          }
        }
      }
    }
  }

  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = this.socket;
      if (!socket || !this.connected) {
        reject(new Error('local bridge not connected'));
        return;
      }
      const id = String(++this.nextId);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${channel}`));
      }, INVOKE_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        socket.write(JSON.stringify({ id, type: 'invoke', channel, args }) + '\n');
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Fire-and-forget send (no response expected). */
  send(channel: string, data?: unknown): void {
    try {
      this.socket?.write(JSON.stringify({ type: 'send', channel, data }) + '\n');
    } catch {
      // stale socket
    }
  }

  /**
   * Ask the backend to shut down (used by the last client on quit). The backend
   * only honors this if no other clients remain; it acks, then exits shortly
   * after this client disconnects. Resolves on ack or after a short timeout so
   * quit is never blocked on a slow/dead backend.
   */
  requestShutdown(timeoutMs = 1500): Promise<void> {
    return new Promise<void>((resolve) => {
      const socket = this.socket;
      if (!socket || !this.connected) {
        resolve();
        return;
      }
      const id = String(++this.nextId);
      const done = setTimeout(() => {
        this.pending.delete(id);
        resolve();
      }, timeoutMs);
      this.pending.set(id, {
        resolve: () => {
          clearTimeout(done);
          resolve();
        },
        reject: () => {
          clearTimeout(done);
          resolve();
        },
        timer: done,
      });
      try {
        socket.write(JSON.stringify({ id, type: 'shutdown' }) + '\n');
      } catch {
        clearTimeout(done);
        this.pending.delete(id);
        resolve();
      }
    });
  }

  /** Subscribe to a server-pushed event channel. Returns an unsubscribe fn. */
  on(channel: string, cb: EventHandler): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
    };
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Register a callback fired when the connection drops. Returns unsubscribe. */
  onDisconnect(cb: () => void): () => void {
    this.disconnectHandlers.add(cb);
    return () => {
      this.disconnectHandlers.delete(cb);
    };
  }

  close(): void {
    this.intentionalClose = true;
    this.teardown(false); // full cleanup, but don't fire disconnect handlers — this is intentional
  }
}

/** Attempt a connection to the given socket path; resolves null if unreachable. */
export async function tryConnect(socketPath: string, authToken?: string): Promise<LocalBridgeClient | null> {
  const client = new LocalBridgeClient(socketPath, authToken);
  try {
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

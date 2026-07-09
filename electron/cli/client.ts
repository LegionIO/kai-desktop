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
/** Consecutive missed pongs before the client declares the backend dead. */
const HEARTBEAT_MAX_MISSED = 2;

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
  private pongMissed = 0;
  private intentionalClose = false; // set by close() so disconnect handlers can tell crash from quit

  constructor(private readonly socketPath: string) {}

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
        resolve();
      });
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

  private wire(socket: Socket): void {
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (line.trim()) this.dispatch(line);
      }
    });

    // Heartbeat: ping the backend periodically. If pongs stop arriving the
    // backend is gone (crash, quit, sleep) even if the OS hasn't delivered a
    // socket close yet — tear the connection down so callers learn promptly.
    this.pongMissed = 0;
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected || !this.socket) return;
      this.pongMissed += 1;
      if (this.pongMissed > HEARTBEAT_MAX_MISSED) {
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
      this.pongMissed = 0;
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
export async function tryConnect(socketPath: string): Promise<LocalBridgeClient | null> {
  const client = new LocalBridgeClient(socketPath);
  try {
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

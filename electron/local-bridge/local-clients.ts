import type { Socket } from 'net';

/**
 * Connected local-socket clients (the `kai` CLI and any other native client
 * attaching over the leader's unix-domain-socket / named-pipe bridge). The
 * local-server module adds/removes entries as sockets connect and close.
 */
export const localClients = new Set<Socket>();

/**
 * Per-socket last-activity timestamp (ms), keyed by a symbol so it rides on the
 * socket without a parallel map to keep in sync on close. Updated on BOTH inbound
 * data (in local-server) and outbound writes (here) — so the server's liveness
 * heartbeat doesn't reap a socket we're actively STREAMING to just because the
 * client's ping was delayed by its own busy event loop during a heavy stream.
 */
const LAST_ACTIVITY = Symbol('kaiLastActivity');
type Timestamped = Socket & { [LAST_ACTIVITY]?: number };

/** Mark the socket as active now (inbound or outbound traffic). */
export function markSocketActivity(socket: Socket): void {
  (socket as Timestamped)[LAST_ACTIVITY] = Date.now();
}

/** Ms since the socket last saw traffic in either direction (Infinity if never). */
export function msSinceActivity(socket: Socket): number {
  const t = (socket as Timestamped)[LAST_ACTIVITY];
  return typeof t === 'number' ? Date.now() - t : Infinity;
}

/** If a client's kernel/socket send buffer grows past this, it's not reading
 *  fast enough (a stalled/backgrounded CLI). Rather than let stream/tool-progress
 *  output accumulate unbounded in the backend, we drop the slow client. */
const MAX_CLIENT_BACKLOG_BYTES = 16 * 1024 * 1024;

/**
 * Push an event to every connected local-socket client. Uses the same
 * newline-delimited JSON envelope the local bridge speaks
 * (`{type:'event',channel,data}\n`) so the CLI client can dispatch it to the
 * matching `on(channel)` handler — mirroring `broadcastToWebClients`.
 */
export function broadcastToLocalClients(channel: string, data?: unknown): void {
  if (localClients.size === 0) return;
  // Serialize once, guarded — a cyclic/BigInt `data` would otherwise throw here
  // (before the per-socket try) and propagate to the broadcast call site.
  let message: string;
  try {
    message = JSON.stringify({ type: 'event', channel, data }) + '\n';
  } catch (err) {
    console.warn(`[local-clients] dropping unserializable event on "${channel}":`, err);
    return;
  }
  for (const socket of localClients) {
    try {
      if (!socket.writable) continue;
      // Backpressure guard: a client that isn't draining its socket must not be
      // able to OOM the singleton backend. Destroy it once its outbound backlog
      // is excessive; it'll reconnect if still alive.
      if (socket.writableLength > MAX_CLIENT_BACKLOG_BYTES) {
        localClients.delete(socket);
        socket.destroy();
        continue;
      }
      socket.write(message);
      // Streaming TO the client is liveness evidence — the peer is there and
      // (given the backlog guard above) draining. Refresh so the server's
      // heartbeat doesn't reap it mid-stream on a delayed ping.
      markSocketActivity(socket);
    } catch {
      // Ignore send errors on stale sockets
    }
  }
}

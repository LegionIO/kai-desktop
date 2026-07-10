import type { Socket } from 'net';

/**
 * Connected local-socket clients (the `kai` CLI and any other native client
 * attaching over the leader's unix-domain-socket / named-pipe bridge). The
 * local-server module adds/removes entries as sockets connect and close.
 */
export const localClients = new Set<Socket>();

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
  const message = JSON.stringify({ type: 'event', channel, data }) + '\n';
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
    } catch {
      // Ignore send errors on stale sockets
    }
  }
}

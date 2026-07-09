import type { Socket } from 'net';

/**
 * Connected local-socket clients (the `kai` CLI and any other native client
 * attaching over the leader's unix-domain-socket / named-pipe bridge). The
 * local-server module adds/removes entries as sockets connect and close.
 */
export const localClients = new Set<Socket>();

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
      if (socket.writable) {
        socket.write(message);
      }
    } catch {
      // Ignore send errors on stale sockets
    }
  }
}

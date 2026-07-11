import type WebSocket from 'ws';

/** Connected web UI clients. The web-server module adds/removes entries. */
export const webClients = new Set<WebSocket>();

/**
 * Extra broadcast sinks registered by other transports (e.g. the local-socket
 * bridge used by the `kai` CLI). Every event broadcast to web clients is also
 * forwarded to each registered sink, so the ~13 existing broadcast call sites
 * fan out to all client transports without needing to know about them. Kept as
 * a registry here (rather than importing the local bridge) to avoid a circular
 * import between transports.
 */
type BroadcastSink = (channel: string, data?: unknown) => void;
const extraSinks = new Set<BroadcastSink>();

/** Register an additional broadcast sink. Returns an unregister function. */
export function registerBroadcastSink(sink: BroadcastSink): () => void {
  extraSinks.add(sink);
  return () => {
    extraSinks.delete(sink);
  };
}

/**
 * Push an event to every connected web client AND every registered extra sink.
 * Mirrors the shape sent over the WebSocket protocol so the bridge client
 * script can dispatch it to the matching `on<Event>` callback.
 */
export function broadcastToWebClients(channel: string, data?: unknown): void {
  if (webClients.size > 0) {
    // Serialize once, guarded: a cyclic/BigInt `data` would otherwise throw
    // here (outside the per-client try) and propagate to the broadcast call
    // site. Drop the event rather than crash the caller.
    let message: string;
    try {
      message = JSON.stringify({ type: 'event', channel, data });
    } catch (err) {
      console.warn(`[web-clients] dropping unserializable event on "${channel}":`, err);
      message = '';
    }
    if (message) {
      // Backpressure cap: a stuck client that isn't draining grows
      // ws.bufferedAmount unbounded (backend memory). Drop it past the cap.
      const MAX_BUFFERED = 16 * 1024 * 1024;
      for (const ws of webClients) {
        try {
          if (ws.readyState === ws.OPEN) {
            if (ws.bufferedAmount > MAX_BUFFERED) {
              webClients.delete(ws);
              ws.terminate();
              continue;
            }
            ws.send(message);
          } else if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) {
            // Prune sockets the close handler hasn't removed yet.
            webClients.delete(ws);
          }
        } catch {
          // Ignore send errors on stale sockets
        }
      }
    }
  }

  for (const sink of extraSinks) {
    try {
      sink(channel, data);
    } catch {
      // A misbehaving sink must not break other transports
    }
  }
}

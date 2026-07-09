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
    const message = JSON.stringify({ type: 'event', channel, data });
    for (const ws of webClients) {
      try {
        if (ws.readyState === ws.OPEN) {
          ws.send(message);
        }
      } catch {
        // Ignore send errors on stale sockets
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

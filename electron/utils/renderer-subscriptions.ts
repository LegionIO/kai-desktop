/**
 * Per-channel renderer subscription tracking.
 *
 * Motivation: `broadcastToAllWindows` is unconditional, so a high-volume event
 * source pays the full cost of crossing the contextBridge even when no renderer
 * listens. Every crossing deep-proxies the payload object graph
 * (`CreateProxyForAPI` → `v8::Object::GetPropertyNames`), which allocates
 * proportionally to payload size. A chatty plugin on an idle GUI walked the
 * renderer heap to a V8 OOM overnight (~2,300 no-op `plugin:event` broadcasts in
 * 39h, none of them read by any consumer).
 *
 * This module lets a *specific* high-volume channel skip the broadcast when
 * nothing is listening. It is deliberately opt-in per channel rather than wired
 * into `broadcastToAllWindows` globally: many channels legitimately fire before
 * a renderer attaches, and silently dropping those would change existing
 * behavior in ways callers don't expect.
 *
 * Failure posture is fail-OPEN: when subscription state is unknown or a channel
 * was never registered for gating, callers treat the event as wanted and send
 * it. Dropping a real event is worse than an unnecessary send.
 */

/** channel → (webContentsId → active subscription count) */
const subscriptions = new Map<string, Map<number, number>>();

/**
 * Record a renderer subscription. Returns the resulting count for that
 * (channel, webContents) pair.
 *
 * Counted rather than boolean because one renderer may attach several listeners
 * to the same channel (React StrictMode double-invokes effects, and independent
 * components can each subscribe); the gate must stay open until the last one
 * detaches.
 */
export function addRendererSubscription(channel: string, webContentsId: number): number {
  let perChannel = subscriptions.get(channel);
  if (!perChannel) {
    perChannel = new Map();
    subscriptions.set(channel, perChannel);
  }
  const next = (perChannel.get(webContentsId) ?? 0) + 1;
  perChannel.set(webContentsId, next);
  return next;
}

/**
 * Drop one renderer subscription. Never goes negative — an unmatched
 * unsubscribe (double-teardown, or a teardown racing renderer destruction) is
 * treated as "already gone" rather than corrupting the count into a state that
 * could wedge the gate closed.
 */
export function removeRendererSubscription(channel: string, webContentsId: number): number {
  const perChannel = subscriptions.get(channel);
  if (!perChannel) return 0;
  const current = perChannel.get(webContentsId) ?? 0;
  const next = current - 1;
  if (next > 0) {
    perChannel.set(webContentsId, next);
    return next;
  }
  perChannel.delete(webContentsId);
  if (perChannel.size === 0) subscriptions.delete(channel);
  return 0;
}

/**
 * Forget every subscription held by one webContents, across all channels.
 *
 * Critical for correctness of the gate: a renderer that crashes or reloads never
 * runs its teardown functions. Without this, its counts would linger forever and
 * the gate would stay permanently open — restoring exactly the unbounded-broadcast
 * behavior this module exists to prevent. Call from a `webContents` `destroyed`
 * handler AND from `render-process-gone`.
 */
export function clearRendererSubscriptions(webContentsId: number): void {
  for (const [channel, perChannel] of subscriptions) {
    if (perChannel.delete(webContentsId) && perChannel.size === 0) {
      subscriptions.delete(channel);
    }
  }
}

/** True when at least one renderer holds a live subscription to `channel`. */
export function hasRendererSubscribers(channel: string): boolean {
  const perChannel = subscriptions.get(channel);
  if (!perChannel) return false;
  for (const count of perChannel.values()) {
    if (count > 0) return true;
  }
  return false;
}

/** Test/diagnostic helper: total live subscriptions for a channel. */
export function rendererSubscriberCount(channel: string): number {
  const perChannel = subscriptions.get(channel);
  if (!perChannel) return 0;
  let total = 0;
  for (const count of perChannel.values()) total += count;
  return total;
}

/** Test helper: drop all tracked state. */
export function resetRendererSubscriptions(): void {
  subscriptions.clear();
}

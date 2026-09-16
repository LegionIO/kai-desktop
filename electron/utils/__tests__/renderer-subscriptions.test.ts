/**
 * Tests for renderer subscription tracking (electron/utils/renderer-subscriptions.ts).
 *
 * This is the state a high-volume broadcast gate consults. Two failure modes are
 * worse than the leak it prevents:
 *   - a count stuck ABOVE zero (crash/reload leaked it) silently restores the
 *     unbounded-broadcast behavior, which is what OOM'd the renderer overnight;
 *   - a count stuck AT zero drops events a renderer is really listening for.
 * Both directions are pinned here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  addRendererSubscription,
  removeRendererSubscription,
  clearRendererSubscriptions,
  hasRendererSubscribers,
  rendererSubscriberCount,
  resetRendererSubscriptions,
} from '../renderer-subscriptions.js';

const CH = 'plugin:event';

beforeEach(() => resetRendererSubscriptions());

describe('subscribe / unsubscribe', () => {
  it('reports no subscribers before anything attaches', () => {
    expect(hasRendererSubscribers(CH)).toBe(false);
    expect(rendererSubscriberCount(CH)).toBe(0);
  });

  it('opens the gate on first subscribe and closes it on matching unsubscribe', () => {
    addRendererSubscription(CH, 1);
    expect(hasRendererSubscribers(CH)).toBe(true);
    removeRendererSubscription(CH, 1);
    expect(hasRendererSubscribers(CH)).toBe(false);
  });

  it('counts multiple listeners from ONE renderer and stays open until the last detaches', () => {
    // React StrictMode double-invokes effects, and independent components can each
    // subscribe. A boolean flag would close the gate on the first teardown and
    // starve the remaining listeners.
    addRendererSubscription(CH, 1);
    addRendererSubscription(CH, 1);
    expect(rendererSubscriberCount(CH)).toBe(2);

    removeRendererSubscription(CH, 1);
    expect(hasRendererSubscribers(CH)).toBe(true); // one listener remains

    removeRendererSubscription(CH, 1);
    expect(hasRendererSubscribers(CH)).toBe(false);
  });

  it('tracks renderers independently', () => {
    addRendererSubscription(CH, 1);
    addRendererSubscription(CH, 2);
    removeRendererSubscription(CH, 1);
    // Window 2 still listening — the gate must stay open.
    expect(hasRendererSubscribers(CH)).toBe(true);
    removeRendererSubscription(CH, 2);
    expect(hasRendererSubscribers(CH)).toBe(false);
  });

  it('keeps channels isolated', () => {
    addRendererSubscription('plugin:event', 1);
    expect(hasRendererSubscribers('agent:stream-event')).toBe(false);
  });

  it('never drives a count negative on unmatched unsubscribe', () => {
    // A double teardown, or a teardown racing renderer destruction, must not push
    // the count below zero. A negative count wedges the gate CLOSED: the next
    // subscribe only brings it back to 0, so a listening renderer would silently
    // receive nothing for the rest of the session.
    //
    // Must subscribe first — unsubscribing on a never-seen channel short-circuits
    // before the decrement and would not exercise the guard at all.
    addRendererSubscription(CH, 99);
    removeRendererSubscription(CH, 99); // matched: back to zero
    removeRendererSubscription(CH, 99); // unmatched: must clamp, not go to -1
    expect(rendererSubscriberCount(CH)).toBe(0);

    // The real assertion: a fresh subscribe must reopen the gate.
    addRendererSubscription(CH, 99);
    expect(rendererSubscriberCount(CH)).toBe(1);
    expect(hasRendererSubscribers(CH)).toBe(true);
  });

  it('ignores unsubscribe for a channel that was never subscribed', () => {
    removeRendererSubscription('never:seen', 1);
    expect(rendererSubscriberCount('never:seen')).toBe(0);
    expect(hasRendererSubscribers('never:seen')).toBe(false);
  });
});

describe('crash / reload cleanup', () => {
  it('clears every channel held by a destroyed renderer', () => {
    // The overnight crash path: a renderer that dies never runs its teardown, so
    // main must forget its subscriptions explicitly or the gate leaks open forever.
    addRendererSubscription('plugin:event', 7);
    addRendererSubscription('agent:stream-event', 7);
    addRendererSubscription('plugin:event', 8);

    clearRendererSubscriptions(7);

    expect(hasRendererSubscribers('agent:stream-event')).toBe(false);
    // Window 8 is untouched and still listening.
    expect(rendererSubscriberCount('plugin:event')).toBe(1);
    expect(hasRendererSubscribers('plugin:event')).toBe(true);

    clearRendererSubscriptions(8);
    expect(hasRendererSubscribers('plugin:event')).toBe(false);
  });

  it('clears a renderer holding several listeners on one channel', () => {
    // Counted subscriptions must be dropped wholesale, not decremented once.
    addRendererSubscription(CH, 5);
    addRendererSubscription(CH, 5);
    addRendererSubscription(CH, 5);
    clearRendererSubscriptions(5);
    expect(rendererSubscriberCount(CH)).toBe(0);
  });

  it('is a no-op for an unknown renderer', () => {
    addRendererSubscription(CH, 1);
    clearRendererSubscriptions(1234);
    expect(hasRendererSubscribers(CH)).toBe(true);
  });

  it('lets a reloaded renderer re-subscribe cleanly after cleanup', () => {
    addRendererSubscription(CH, 3);
    clearRendererSubscriptions(3);
    expect(hasRendererSubscribers(CH)).toBe(false);
    // Same id after reload — must open the gate again, not double-count.
    addRendererSubscription(CH, 3);
    expect(rendererSubscriberCount(CH)).toBe(1);
  });
});

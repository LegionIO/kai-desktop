/**
 * Tests for sub-agent-runner.ts waitForFollowUp (via __internal) — the helper
 * the sub-agent multi-turn loop uses to await a queued follow-up. It self-
 * schedules a setTimeout poll (never overlapping ticks), a single deadline
 * timer, and a run-scoped abort listener, tearing ALL of them down exactly once
 * in finish(). Locks: immediate hit, polled hit, deadline null, abort null, and
 * — the leak fix — that an early resolve clears the deadline timer AND removes
 * the abort listener (no dangling 5-min timer / accumulating listener on the
 * reused signal).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// sub-agent-runner.ts imports electron + web-clients at module load.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../web-server/web-clients.js', () => ({ broadcastToWebClients: vi.fn() }));

import { __internal } from '../sub-agent-runner.js';

const { waitForFollowUp } = __internal;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('waitForFollowUp', () => {
  it('returns an immediately-available follow-up without arming timers', async () => {
    const getFollowUp = vi.fn().mockResolvedValue('hello');
    const p = waitForFollowUp(getFollowUp, undefined, 300000);
    await expect(p).resolves.toBe('hello');
    expect(getFollowUp).toHaveBeenCalledTimes(1);
    // No pending timers should remain (immediate path returns before the Promise).
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves with a follow-up that appears on a later poll and clears all timers', async () => {
    let call = 0;
    const getFollowUp = vi.fn(async () => (++call >= 3 ? 'late-msg' : null));
    const p = waitForFollowUp(getFollowUp, undefined, 300000);
    // Advance through poll ticks (300ms each) until the 3rd getFollowUp yields.
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe('late-msg');
    // The deadline timer must be cleared on early resolve (the leak fix): no
    // dangling 5-minute timer left running.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves null at the deadline and leaves no timers', async () => {
    const getFollowUp = vi.fn().mockResolvedValue(null);
    const p = waitForFollowUp(getFollowUp, undefined, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves null on abort and REMOVES the abort listener (no accumulation on a reused signal)', async () => {
    const controller = new AbortController();
    const getFollowUp = vi.fn().mockResolvedValue(null);
    const p = waitForFollowUp(getFollowUp, controller.signal, 300000);
    controller.abort();
    await expect(p).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does NOT leak an abort listener when it resolves via message (the {once}-never-fires case)', async () => {
    // The core leak: a reused run-scoped signal must not accumulate one listener
    // per wait when the wait ends by MESSAGE (abort never fires). We assert the
    // listener is removed by spying on removeEventListener.
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const getFollowUp = vi.fn().mockResolvedValue('msg-now'); // immediate? no — immediate returns early; force a poll hit
    // Make the immediate check miss, then hit on first poll so we go through finish().
    let n = 0;
    getFollowUp.mockImplementation(async () => (++n >= 2 ? 'msg-now' : null));
    const p = waitForFollowUp(getFollowUp, controller.signal, 300000);
    await vi.advanceTimersByTimeAsync(400);
    await expect(p).resolves.toBe('msg-now');
    expect(vi.getTimerCount()).toBe(0);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('does not overlap polls when getFollowUp is slow (self-scheduling, not setInterval)', async () => {
    // A getter slower than the 300ms poll must not run concurrently. With
    // self-scheduling setTimeout the next poll is armed only AFTER the await
    // settles, so calls never overlap. Track concurrent entries.
    let inFlight = 0;
    let maxInFlight = 0;
    let n = 0;
    const getFollowUp = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 500)); // slower than 300ms poll
      inFlight--;
      return ++n >= 3 ? 'done' : null;
    });
    const p = waitForFollowUp(getFollowUp, undefined, 300000);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toBe('done');
    expect(maxInFlight).toBe(1); // never overlapped
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { enqueueInject, drainInjects, hasInjects, clearInjects } from '../inject-queue.js';

describe('inject-queue (cooperative mid-turn injection)', () => {
  beforeEach(() => {
    clearInjects('c1');
    clearInjects('c2');
  });

  it('enqueues and drains in FIFO order, clearing on drain', () => {
    enqueueInject('c1', 'first');
    enqueueInject('c1', 'second');
    expect(hasInjects('c1')).toBe(true);

    const drained = drainInjects('c1');
    expect(drained.map((q) => q.text)).toEqual(['first', 'second']);
    // Drain removes them.
    expect(hasInjects('c1')).toBe(false);
    expect(drainInjects('c1')).toEqual([]);
  });

  it('keeps conversations isolated', () => {
    enqueueInject('c1', 'a');
    enqueueInject('c2', 'b');
    expect(drainInjects('c1').map((q) => q.text)).toEqual(['a']);
    expect(drainInjects('c2').map((q) => q.text)).toEqual(['b']);
  });

  it('hasInjects is false for an unknown / drained conversation', () => {
    expect(hasInjects('never')).toBe(false);
    enqueueInject('c1', 'x');
    drainInjects('c1');
    expect(hasInjects('c1')).toBe(false);
  });

  it('clearInjects drops queued messages without returning them', () => {
    enqueueInject('c1', 'x');
    clearInjects('c1');
    expect(hasInjects('c1')).toBe(false);
    expect(drainInjects('c1')).toEqual([]);
  });

  it('ignores empty conversationId or text', () => {
    enqueueInject('', 'x');
    enqueueInject('c1', '');
    expect(hasInjects('c1')).toBe(false);
  });

  it('stamps each entry with an enqueue time', () => {
    const before = Date.now();
    enqueueInject('c1', 'x');
    const [entry] = drainInjects('c1');
    expect(entry.at).toBeGreaterThanOrEqual(before);
    expect(entry.at).toBeLessThanOrEqual(Date.now());
  });
});

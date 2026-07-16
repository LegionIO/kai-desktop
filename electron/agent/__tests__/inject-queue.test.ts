import { describe, it, expect, beforeEach } from 'vitest';
import { enqueueInject, drainInjects, hasInjects, clearInjects, listInjects, removeInject } from '../inject-queue.js';

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

  it('returns a stable id from enqueue and lists pending entries', () => {
    const id1 = enqueueInject('c1', 'a');
    const id2 = enqueueInject('c1', 'b');
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
    const listed = listInjects('c1');
    expect(listed.map((e) => e.id)).toEqual([id1, id2]);
    expect(listed.map((e) => e.text)).toEqual(['a', 'b']);
    // listInjects is a snapshot — does not drain.
    expect(hasInjects('c1')).toBe(true);
  });

  it('removeInject drops one entry by id and returns its text', () => {
    const id1 = enqueueInject('c1', 'keep');
    const id2 = enqueueInject('c1', 'drop')!;
    expect(removeInject('c1', id2)).toBe('drop');
    expect(listInjects('c1').map((e) => e.text)).toEqual(['keep']);
    // Removing an unknown id is a no-op returning null.
    expect(removeInject('c1', 'nope')).toBeNull();
    // Removing the last entry clears the queue.
    removeInject('c1', id1!);
    expect(hasInjects('c1')).toBe(false);
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

  it('ignores empty conversationId or text (returns null)', () => {
    expect(enqueueInject('', 'x')).toBeNull();
    expect(enqueueInject('c1', '')).toBeNull();
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

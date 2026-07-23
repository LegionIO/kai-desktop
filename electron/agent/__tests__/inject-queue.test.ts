import { describe, it, expect, beforeEach } from 'vitest';
import { enqueueInject, drainInjects, hasInjects, clearInjects, listInjects, removeInject, reenqueueInject, reenqueueFreshAtFront } from '../inject-queue.js';

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

  it('reenqueueInject (reverse iteration) restores original FIFO order + preserves id/at', () => {
    const drained = [
      { id: 'a', text: 'A', at: 1 },
      { id: 'b', text: 'B', at: 2 },
    ];
    // Callers re-enqueue in reverse so head-inserts restore A→B.
    for (let i = drained.length - 1; i >= 0; i -= 1) reenqueueInject('c1', drained[i]);
    const out = drainInjects('c1');
    expect(out.map((e) => e.id)).toEqual(['a', 'b']);
    expect(out.map((e) => e.text)).toEqual(['A', 'B']);
    expect(out.map((e) => e.at)).toEqual([1, 2]);
  });

  it('reenqueueFreshAtFront inserts fresh-id entries at the front in original order', () => {
    enqueueInject('c1', 'newer'); // queued after the originals were consumed
    reenqueueFreshAtFront('c1', ['A', 'B']);
    const out = drainInjects('c1');
    // Replayed A,B ahead of the newer entry, in original order, with fresh ids.
    expect(out.map((e) => e.text)).toEqual(['A', 'B', 'newer']);
    expect(new Set(out.map((e) => e.id)).size).toBe(3);
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

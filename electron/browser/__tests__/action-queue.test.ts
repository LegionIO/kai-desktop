import { describe, expect, it } from 'vitest';
import { BrowserActionQueue } from '../action-queue.js';

describe('BrowserActionQueue', () => {
  it('serializes actions in submission order', async () => {
    const queue = new BrowserActionQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run(async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
    });
    const second = queue.run(async () => {
      events.push('second');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('continues after a failed action', async () => {
    const queue = new BrowserActionQueue();
    await expect(queue.run(async () => Promise.reject(new Error('failed')))).rejects.toThrow('failed');
    await expect(queue.run(async () => 'next')).resolves.toBe('next');
  });

  it('exposes an idle barrier that drains already queued operations', async () => {
    const queue = new BrowserActionQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    void queue.run(async () => {
      await gate;
      events.push('first');
    });
    void queue.run(async () => {
      events.push('second');
    });

    let idle = false;
    const barrier = queue.whenIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    release();
    await barrier;
    expect(events).toEqual(['first', 'second']);
  });
});

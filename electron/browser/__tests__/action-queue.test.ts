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

  it('atomically rejects opportunistic work while the queue is occupied', async () => {
    const queue = new BrowserActionQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run(async () => gate);

    expect(queue.runIfIdle(async () => 'overlap')).toBeNull();
    release();
    await first;
    await expect(queue.runIfIdle(async () => 'next')).resolves.toBe('next');
  });

  it('preempts presentation-only work as soon as ordinary work is submitted', async () => {
    const queue = new BrowserActionQueue();
    const events: string[] = [];
    const presentation = queue.runOpportunistic(
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          events.push('presentation:start');
          signal.addEventListener(
            'abort',
            () => {
              events.push('presentation:abort');
              reject(new Error('presentation cancelled'));
            },
            { once: true },
          );
        }),
    );
    expect(presentation).not.toBeNull();
    await Promise.resolve();

    const ordinary = queue.run(async () => {
      events.push('ordinary');
      return 'done';
    });

    await expect(presentation).rejects.toThrow('presentation cancelled');
    await expect(ordinary).resolves.toBe('done');
    expect(events).toEqual(['presentation:start', 'presentation:abort', 'ordinary']);
  });

  it('does not admit a second presentation operation while one is active', async () => {
    const queue = new BrowserActionQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.runOpportunistic(async () => gate);

    expect(first).not.toBeNull();
    expect(queue.runOpportunistic(async () => 'overlap')).toBeNull();
    release();
    await first;
  });

  it('cancels an out-of-queue presentation lease without delaying ordinary work', async () => {
    const queue = new BrowserActionQueue();
    const controller = new AbortController();
    const release = queue.registerOpportunisticPreemption(controller);
    expect(release).not.toBeNull();

    await expect(queue.run(async () => 'ordinary')).resolves.toBe('ordinary');
    expect(controller.signal.aborted).toBe(true);
    release?.();
  });
});

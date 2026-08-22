import { describe, expect, it, vi } from 'vitest';
import {
  BrowserSessionOperationInterruptedError,
  runBrowserSessionOperation,
  waitForBrowserSessionOperations,
} from '../session-operations.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Browser Session operations', () => {
  it('keeps a timed-out native mutation ordered ahead of its replacement', async () => {
    vi.useFakeTimers();
    try {
      const firstGate = deferred<void>();
      const events: string[] = [];
      const targetSession = {} as never;
      const interrupted = vi.fn();
      const lateSettlement = vi.fn();
      const first = runBrowserSessionOperation(
        targetSession,
        'first mutation',
        async () => {
          events.push('first started');
          await firstGate.promise;
          events.push('first settled');
        },
        { timeoutMs: 25, onInterrupted: interrupted, onSettledAfterInterruption: lateSettlement },
      );
      await vi.advanceTimersByTimeAsync(0);
      const firstRejected = expect(first).rejects.toBeInstanceOf(BrowserSessionOperationInterruptedError);
      await vi.advanceTimersByTimeAsync(25);
      await firstRejected;

      const second = runBrowserSessionOperation(
        targetSession,
        'replacement mutation',
        async () => {
          events.push('second');
        },
        { timeoutMs: 100 },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual(['first started']);

      firstGate.resolve();
      await second;
      await waitForBrowserSessionOperations(targetSession);
      expect(events).toEqual(['first started', 'first settled', 'second']);
      expect(interrupted).toHaveBeenCalledOnce();
      expect(lateSettlement).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('withdraws an aborted queued mutation but retains its queue lease until the predecessor settles', async () => {
    const firstGate = deferred<void>();
    const targetSession = {} as never;
    const first = runBrowserSessionOperation(targetSession, 'first mutation', () => firstGate.promise);
    const controller = new AbortController();
    const queuedMutation = vi.fn(async () => undefined);
    const lateSettlement = vi.fn();
    const second = runBrowserSessionOperation(targetSession, 'queued mutation', queuedMutation, {
      abortSignal: controller.signal,
      onSettledAfterInterruption: lateSettlement,
    });

    controller.abort();
    await expect(second).rejects.toBeInstanceOf(BrowserSessionOperationInterruptedError);
    expect(lateSettlement).not.toHaveBeenCalled();
    firstGate.resolve();
    await first;
    await waitForBrowserSessionOperations(targetSession);

    expect(queuedMutation).not.toHaveBeenCalled();
    expect(lateSettlement).toHaveBeenCalledOnce();
  });

  it('expires a timed-out queued mutation without replaying it after the queue recovers', async () => {
    vi.useFakeTimers();
    try {
      const firstGate = deferred<void>();
      const targetSession = {} as never;
      const first = runBrowserSessionOperation(targetSession, 'first mutation', () => firstGate.promise, {
        timeoutMs: 100,
      });
      const queuedMutation = vi.fn(async () => undefined);
      const lateSettlement = vi.fn();
      const second = runBrowserSessionOperation(targetSession, 'queued mutation', queuedMutation, {
        timeoutMs: 25,
        onSettledAfterInterruption: lateSettlement,
      });

      const secondRejected = expect(second).rejects.toBeInstanceOf(BrowserSessionOperationInterruptedError);
      await vi.advanceTimersByTimeAsync(25);
      await secondRejected;
      expect(queuedMutation).not.toHaveBeenCalled();

      firstGate.resolve();
      await first;
      await waitForBrowserSessionOperations(targetSession);

      expect(queuedMutation).not.toHaveBeenCalled();
      expect(lateSettlement).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

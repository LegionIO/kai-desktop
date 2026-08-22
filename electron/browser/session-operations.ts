import type { Session } from 'electron';

export const BROWSER_SESSION_OPERATION_TIMEOUT_MS = 15_000;

type SessionOperationState = {
  tail: Promise<void>;
  pending: number;
};

export type BrowserSessionOperationOptions = {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  onInterrupted?: () => void;
  onSettledAfterInterruption?: () => void;
};

const sessionOperations = new WeakMap<Session, SessionOperationState>();

export class BrowserSessionOperationInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserSessionOperationInterruptedError';
  }
}

/**
 * Electron Session mutations are not cancellable. Serialize them process-wide
 * per Session and bound the caller wait. A native operation that already
 * started remains in the queue after interruption because Electron cannot
 * cancel it; an operation whose deadline expires while still queued is skipped
 * when it reaches the head. A later mutation can therefore never be overtaken
 * by older native work without replaying expired queued mutations.
 */
export function runBrowserSessionOperation<T>(
  targetSession: Session,
  label: string,
  operation: () => Promise<T>,
  options: BrowserSessionOperationOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? BROWSER_SESSION_OPERATION_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    return Promise.reject(new Error('Invalid Browser session operation timeout.'));
  }
  if (options.abortSignal?.aborted) {
    return Promise.reject(new BrowserSessionOperationInterruptedError(`${label} was cancelled.`));
  }

  const state = sessionOperations.get(targetSession) ?? { tail: Promise.resolve(), pending: 0 };
  sessionOperations.set(targetSession, state);
  state.pending++;
  let operationStarted = false;
  let cancelBeforeStart = false;
  let callerInterrupted = false;
  const queued = state.tail.then(() => {
    if (cancelBeforeStart || options.abortSignal?.aborted) {
      throw new BrowserSessionOperationInterruptedError(`${label} was cancelled.`);
    }
    operationStarted = true;
    return operation();
  });
  const tail = queued.then(
    () => undefined,
    () => undefined,
  );
  state.tail = tail;
  void tail.finally(() => {
    state.pending--;
    if (state.pending === 0 && sessionOperations.get(targetSession) === state) {
      sessionOperations.delete(targetSession);
    }
    if (callerInterrupted) {
      try {
        options.onSettledAfterInterruption?.();
      } catch {
        // A lifecycle-release callback is best effort; the native queue itself
        // must always settle and remain usable by a later recovery operation.
      }
    }
  });

  return new Promise<T>((resolve, reject) => {
    let callerSettled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { value: T } | { error: unknown }): void => {
      if (callerSettled) return;
      callerSettled = true;
      if (timer) clearTimeout(timer);
      if (options.abortSignal) options.abortSignal.removeEventListener('abort', onAbort);
      if ('error' in result) reject(result.error);
      else resolve(result.value);
    };
    const interrupt = (error: BrowserSessionOperationInterruptedError, cancelQueued: boolean): void => {
      if (callerSettled) return;
      callerInterrupted = true;
      if (cancelQueued && !operationStarted) cancelBeforeStart = true;
      try {
        options.onInterrupted?.();
      } catch {
        // Quarantine notification must not replace the bounded operation error.
      }
      finish({ error });
    };
    const onAbort = (): void => {
      interrupt(new BrowserSessionOperationInterruptedError(`${label} was cancelled.`), true);
    };
    options.abortSignal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      interrupt(
        new BrowserSessionOperationInterruptedError(`${label} timed out after exceeding its ${timeoutMs} ms deadline.`),
        true,
      );
    }, timeoutMs);
    timer.unref?.();
    void queued.then(
      (value) => finish({ value }),
      (error) => finish({ error }),
    );
  });
}

/** Resolve after every mutation already admitted for this Electron Session has
 * really settled, including operations whose public deadline already expired. */
export function waitForBrowserSessionOperations(targetSession: Session): Promise<void> {
  return sessionOperations.get(targetSession)?.tail ?? Promise.resolve();
}

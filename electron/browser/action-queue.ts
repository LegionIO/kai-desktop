/** A promise queue that remains usable after an action rejects. */
export class BrowserActionQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly opportunisticControllers = new Set<AbortController>();

  run<T>(operation: () => Promise<T>): Promise<T> {
    // Presentation-only work must never make a user/model action wait for a
    // long renderer probe. Abort it before joining the same serialization
    // boundary; the opportunistic operation retains the queue only until it
    // observes cancellation and unwinds.
    for (const controller of this.opportunisticControllers) controller.abort();
    this.pending++;
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => {
        this.pending--;
      },
      () => {
        this.pending--;
      },
    );
    return result;
  }

  /** Atomically admit an operation only when the queue has no running or
   * already queued work. Presentation-only captures use this to fail quickly
   * instead of overlapping a large screenshot allocation or waiting behind it. */
  runIfIdle<T>(operation: () => Promise<T>): Promise<T> | null {
    if (this.pending > 0) return null;
    return this.run(operation);
  }

  /** Admit presentation-only work only while idle and make it immediately
   * preemptible by ordinary queued work. The caller may also abort the supplied
   * signal (for example when the final menu subscriber disappears). */
  runOpportunistic<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> | null {
    if (this.pending > 0) return null;
    const controller = new AbortController();
    this.opportunisticControllers.add(controller);
    this.pending++;
    const result = this.tail.then(() => operation(controller.signal));
    this.tail = result.then(
      () => {
        this.pending--;
        this.opportunisticControllers.delete(controller);
      },
      () => {
        this.pending--;
        this.opportunisticControllers.delete(controller);
      },
    );
    return result;
  }

  /** Register an idle, out-of-queue presentation operation (such as native
   * capturePage()) for immediate cancellation when ordinary work arrives. */
  registerOpportunisticPreemption(controller: AbortController): (() => void) | null {
    if (this.pending > 0 || controller.signal.aborted) return null;
    this.opportunisticControllers.add(controller);
    return () => this.opportunisticControllers.delete(controller);
  }

  /** Resolve once the active operation and every operation already queued
   * behind it have settled. Used as a profile-clear barrier. */
  whenIdle(): Promise<void> {
    return this.tail;
  }
}

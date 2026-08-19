/** A promise queue that remains usable after an action rejects. */
export class BrowserActionQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Resolve once the active operation and every operation already queued
   * behind it have settled. Used as a profile-clear barrier. */
  whenIdle(): Promise<void> {
    return this.tail;
  }
}

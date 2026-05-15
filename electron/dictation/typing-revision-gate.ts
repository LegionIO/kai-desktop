export class DictationQueuedPartialGate {
  private revision = 0;

  nextPartialRevision(): number {
    this.revision += 1;
    return this.revision;
  }

  invalidateQueuedPartials(): void {
    this.revision += 1;
  }

  isCurrent(revision: number): boolean {
    return revision === this.revision;
  }
}

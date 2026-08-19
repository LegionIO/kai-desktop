type AssistantRunEntry = {
  conversationId: string;
  modality: BrowserAssistantModality;
  generation: number;
  accepting: boolean;
  operations: number;
  drainPromise: Promise<void>;
  resolveDrain: () => void;
};

export type BrowserAssistantModality = 'text' | 'realtime';

export type BrowserAssistantRunLease = {
  generation: number;
  release: () => void;
};

function runKey(conversationId: string, runId: string): string {
  return `${conversationId}\u0000${runId}`;
}

/**
 * Process-local capability registry for assistant Browser access.
 *
 * A browser owner id is not authority by itself: its owning text/realtime run
 * must register it here before tools can execute. Ending a run synchronously
 * stops new operations, then waits for already-acquired operations to release
 * before deleting the entry. This prevents delayed runtime-bridge calls from
 * becoming valid again after cleanup and keeps completed-run state bounded.
 */
export class BrowserAssistantRunRegistry {
  private readonly entries = new Map<string, AssistantRunEntry>();
  private nextGeneration = 1;

  begin(conversationId: string, runId: string, modality: BrowserAssistantModality = 'text'): number {
    const key = runKey(conversationId, runId);
    if (this.entries.has(key)) throw new Error('This assistant browser run is already registered.');
    // Text replacement/continuation has its own handoff protocol and may briefly
    // retain two text capabilities while the predecessor drains. Realtime has an
    // independent runtime and page assumptions, so never allow it to overlap a
    // text capability (or another Realtime capability) for the same conversation.
    const conflicting = [...this.entries.values()].some(
      (entry) => entry.conversationId === conversationId && (entry.modality !== modality || modality === 'realtime'),
    );
    if (conflicting) {
      throw new Error("Another assistant modality is already using this conversation's Browser tabs.");
    }
    let resolveDrain!: () => void;
    const drainPromise = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    const generation = this.nextGeneration++;
    this.entries.set(key, {
      conversationId,
      modality,
      generation,
      accepting: true,
      operations: 0,
      drainPromise,
      resolveDrain,
    });
    return generation;
  }

  assertActive(conversationId: string, runId: string): number {
    const entry = this.entries.get(runKey(conversationId, runId));
    if (!entry?.accepting) throw new Error('The assistant browser turn has ended or is not registered.');
    return entry.generation;
  }

  generationIfActive(conversationId: string, runId: string): number | null {
    const entry = this.entries.get(runKey(conversationId, runId));
    return entry?.accepting ? entry.generation : null;
  }

  acquire(conversationId: string, runId: string): BrowserAssistantRunLease {
    const key = runKey(conversationId, runId);
    const entry = this.entries.get(key);
    if (!entry?.accepting) throw new Error('The assistant browser turn has ended or is not registered.');
    entry.operations++;
    let released = false;
    return {
      generation: entry.generation,
      release: () => {
        if (released) return;
        released = true;
        const current = this.entries.get(key);
        if (current !== entry) return;
        current.operations = Math.max(0, current.operations - 1);
        this.finishDrainedEntry(key, current);
      },
    };
  }

  end(conversationId: string, runId: string): Promise<void> {
    return this.endKey(runKey(conversationId, runId));
  }

  async endConversation(conversationId: string): Promise<void> {
    const prefix = `${conversationId}\u0000`;
    await Promise.all([...this.entries.keys()].filter((key) => key.startsWith(prefix)).map((key) => this.endKey(key)));
  }

  clear(): void {
    for (const [key, entry] of this.entries) {
      entry.accepting = false;
      this.finishDrainedEntry(key, entry);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private async endKey(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.accepting = false;
    this.finishDrainedEntry(key, entry);
    await entry.drainPromise;
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }

  private finishDrainedEntry(key: string, entry: AssistantRunEntry): void {
    if (entry.accepting || entry.operations !== 0) return;
    entry.resolveDrain();
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }
}

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildMastraPrepareStep,
  setInjectConsumedHandler,
  drainInjectConsumedMarkers,
  clearInjectConsumedMarkers,
} from '../prepare-step-inject.js';
import { enqueueInject, clearInjects, hasInjects } from '../inject-queue.js';

describe('buildMastraPrepareStep (cooperative mid-turn splice)', () => {
  beforeEach(() => {
    clearInjects('c1');
    clearInjectConsumedMarkers('c1');
    setInjectConsumedHandler(null);
  });

  it('records a step-numbered marker drained only once the prior step is consumed', () => {
    enqueueInject('c1', 'follow-up');
    const prepareStep = buildMastraPrepareStep('c1');
    // prepareStep for step 2 runs after step 1's events.
    prepareStep({ messages: [{ role: 'user', content: 'x' }], stepNumber: 2 });
    // Prior step (1) not yet fully consumed → nothing ready.
    expect(drainInjectConsumedMarkers('c1', 1)).toEqual([]);
    // Once consumed steps reach 2, the marker is ready in order.
    const ready = drainInjectConsumedMarkers('c1', 2);
    expect(ready.map((e) => e.text)).toEqual(['follow-up']);
    // Drained — no longer returned.
    expect(drainInjectConsumedMarkers('c1', 99)).toEqual([]);
  });

  it('clearInjectConsumedMarkers discards recorded markers', () => {
    enqueueInject('c1', 'x');
    buildMastraPrepareStep('c1')({ messages: [], stepNumber: 1 });
    clearInjectConsumedMarkers('c1');
    expect(drainInjectConsumedMarkers('c1', 99)).toEqual([]);
  });

  it('returns {} (no override) when nothing is queued', () => {
    const prepareStep = buildMastraPrepareStep('c1');
    const result = prepareStep({ messages: [{ role: 'user', content: 'hello' }] });
    expect(result).toEqual({});
  });

  it('appends queued follow-ups to the step messages in FIFO order, draining the queue', () => {
    enqueueInject('c1', 'follow-up one');
    enqueueInject('c1', 'follow-up two');
    const prepareStep = buildMastraPrepareStep('c1');
    const base = [
      { role: 'user', content: 'original' },
      { role: 'assistant', content: 'partial…' },
    ];
    const result = prepareStep({ messages: base });
    expect(result.messages).toEqual([
      { role: 'user', content: 'original' },
      { role: 'assistant', content: 'partial…' },
      { role: 'user', content: 'follow-up one' },
      { role: 'user', content: 'follow-up two' },
    ]);
    // Drained — a second step boundary with no new injects is a no-op.
    expect(hasInjects('c1')).toBe(false);
    expect(prepareStep({ messages: base })).toEqual({});
  });

  it('does not mutate the original messages array', () => {
    enqueueInject('c1', 'x');
    const base = [{ role: 'user', content: 'orig' }];
    buildMastraPrepareStep('c1')({ messages: base });
    expect(base).toEqual([{ role: 'user', content: 'orig' }]);
  });

  it('invokes onInjected with the drained texts (never throws through)', () => {
    enqueueInject('c1', 'a');
    enqueueInject('c1', 'b');
    const seen: string[][] = [];
    const prepareStep = buildMastraPrepareStep('c1', (texts) => {
      seen.push(texts);
      throw new Error('callback boom — must be swallowed');
    });
    expect(() => prepareStep({ messages: [] })).not.toThrow();
    expect(seen).toEqual([['a', 'b']]);
  });

  it('notifies the global consumed handler with stable queue ids at the step boundary', () => {
    const id = enqueueInject('c1', 'follow-up');
    const seen: Array<{ conversationId: string; id: string; text: string }> = [];
    setInjectConsumedHandler((conversationId, entries) => {
      seen.push(...entries.map((entry) => ({ conversationId, id: entry.id, text: entry.text })));
    });

    buildMastraPrepareStep('c1')({ messages: [] });

    expect(seen).toEqual([{ conversationId: 'c1', id, text: 'follow-up' }]);
  });
});

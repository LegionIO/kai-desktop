import { describe, it, expect, beforeEach } from 'vitest';
import { buildMastraPrepareStep } from '../prepare-step-inject.js';
import { enqueueInject, clearInjects, hasInjects } from '../inject-queue.js';

describe('buildMastraPrepareStep (cooperative mid-turn splice)', () => {
  beforeEach(() => clearInjects('c1'));

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
});

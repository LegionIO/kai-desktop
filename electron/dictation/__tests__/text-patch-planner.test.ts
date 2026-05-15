import { describe, expect, it } from 'vitest';
import { DictationQueuedPartialGate } from '../typing-revision-gate.js';
import {
  planDictationTextPatch,
  splitGraphemes,
  type DictationPatchOperation,
} from '../text-patch-planner.js';

function applyOperations(currentText: string, operations: DictationPatchOperation[]): string {
  const text = splitGraphemes(currentText);
  let cursor = text.length;

  for (const operation of operations) {
    switch (operation.kind) {
      case 'moveLeft':
        cursor = Math.max(0, cursor - operation.count);
        break;
      case 'moveRight':
        cursor = Math.min(text.length, cursor + operation.count);
        break;
      case 'deleteForward':
        text.splice(cursor, operation.count);
        break;
      case 'insertText': {
        const inserted = splitGraphemes(operation.text);
        text.splice(cursor, 0, ...inserted);
        cursor += inserted.length;
        break;
      }
    }
  }

  return text.join('');
}

describe('dictation text patch planner', () => {
  it('patches capitalization and trailing punctuation without tail rewrite', () => {
    const plan = planDictationTextPatch('hello world', 'Hello world. ', 'final');

    expect(plan.kind).toBe('patch');
    if (plan.kind !== 'patch') throw new Error('expected patch plan');
    expect(applyOperations('hello world', plan.operations)).toBe('Hello world. ');
  });

  it('patches apostrophes, capitalization, punctuation, and final spacing', () => {
    const plan = planDictationTextPatch('i think its fine', "I think it's fine. ", 'final');

    expect(plan.kind).toBe('patch');
    if (plan.kind !== 'patch') throw new Error('expected patch plan');
    expect(applyOperations('i think its fine', plan.operations)).toBe("I think it's fine. ");
  });

  it('uses append-only plans for normal partial growth', () => {
    const plan = planDictationTextPatch('hello', 'hello wor', 'partial');

    expect(plan).toEqual({ kind: 'append', text: ' wor', targetText: 'hello wor' });
  });

  it('falls back to tail rewrite for large semantic changes', () => {
    const plan = planDictationTextPatch(
      'hello world',
      'completely different transcript with many words',
      'final',
    );

    expect(plan.kind).toBe('tailRewrite');
  });

  it('marks older queued partial revisions stale when newer targets arrive', () => {
    const gate = new DictationQueuedPartialGate();

    const first = gate.nextPartialRevision();
    const second = gate.nextPartialRevision();

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);

    gate.invalidateQueuedPartials();

    expect(gate.isCurrent(second)).toBe(false);
  });

  it('plans Unicode grapheme edits without splitting surrogate pairs', () => {
    const current = 'hello 👩‍💻';
    const target = 'Hello 👩‍💻. ';
    const plan = planDictationTextPatch(current, target, 'final');

    expect(plan.kind).toBe('patch');
    if (plan.kind !== 'patch') throw new Error('expected patch plan');
    expect(applyOperations(current, plan.operations)).toBe(target);

    const deleteCounts: number[] = [];
    for (const operation of plan.operations) {
      if (operation.kind === 'deleteForward') {
        deleteCounts.push(operation.count);
      }
    }
    expect(deleteCounts).not.toContain(2);
  });
});

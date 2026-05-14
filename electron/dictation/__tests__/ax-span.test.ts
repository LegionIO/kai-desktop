import { describe, expect, it } from 'vitest';
import {
  createAxDictationSpanFromSelection,
  selectionMatchesDictationEnd,
  selectionMatchesDictationStart,
} from '../ax-span.js';

describe('AX dictation span construction', () => {
  it('uses the selected text length as the initial replacement span', () => {
    expect(createAxDictationSpanFromSelection(12, 5, 1234, 'AXTextField|x=1|y=2|w=300')).toEqual({
      location: 12,
      typedUtf16Length: 5,
      pid: 1234,
      elementSignature: 'AXTextField|x=1|y=2|w=300',
    });
  });

  it('accepts collapsed selections', () => {
    expect(createAxDictationSpanFromSelection(12, 0, null, 'AXTextArea|id=message')).toEqual({
      location: 12,
      typedUtf16Length: 0,
      pid: null,
      elementSignature: 'AXTextArea|id=message',
    });
  });

  it('rejects invalid ranges', () => {
    expect(createAxDictationSpanFromSelection(-1, 0, null, 'sig')).toBeNull();
    expect(createAxDictationSpanFromSelection(0, -1, null, 'sig')).toBeNull();
    expect(createAxDictationSpanFromSelection(Number.NaN, 0, null, 'sig')).toBeNull();
    expect(createAxDictationSpanFromSelection(1.5, 0, null, 'sig')).toBeNull();
    expect(createAxDictationSpanFromSelection(0, 1.5, null, 'sig')).toBeNull();
    expect(createAxDictationSpanFromSelection(0, 0, null, '')).toBeNull();
  });

  it('verifies collapsed cursor state after dictated text', () => {
    const span = { location: 12, typedUtf16Length: 0, pid: 1234, elementSignature: 'sig' };

    expect(selectionMatchesDictationStart(span, { location: 17, length: 0, elementSignature: 'sig' }, 5)).toBe(true);
    expect(selectionMatchesDictationStart(span, { location: 16, length: 0, elementSignature: 'sig' }, 5)).toBe(false);
    expect(selectionMatchesDictationStart(span, { location: 17, length: 0, elementSignature: 'other' }, 5)).toBe(false);
    expect(selectionMatchesDictationEnd(span, { location: 18, length: 0, elementSignature: 'sig' }, 6)).toBe(true);
    expect(selectionMatchesDictationEnd(span, { location: 18, length: 1, elementSignature: 'sig' }, 6)).toBe(false);
    expect(selectionMatchesDictationEnd(span, { location: 18, length: 0, elementSignature: 'other' }, 6)).toBe(false);
  });

  it('verifies selected text startup before the first replacement', () => {
    const span = { location: 12, typedUtf16Length: 5, pid: 1234, elementSignature: 'sig' };

    expect(selectionMatchesDictationStart(span, { location: 12, length: 5, elementSignature: 'sig' }, 0)).toBe(true);
    expect(selectionMatchesDictationStart(span, { location: 17, length: 0, elementSignature: 'sig' }, 0)).toBe(false);
  });
});

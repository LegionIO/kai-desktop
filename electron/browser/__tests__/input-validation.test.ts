import { describe, expect, it } from 'vitest';
import {
  MAX_BROWSER_INPUT_COORDINATE,
  MAX_BROWSER_KEYS,
  MAX_BROWSER_KEY_CHARS,
  MAX_BROWSER_SELECTOR_CHARS,
  MAX_BROWSER_SEMANTIC_TARGET_CHARS,
  MAX_BROWSER_TYPED_VALUE_CHARS,
  parseBrowserActionRequest,
  parseBrowserScreenshotRequest,
} from '../input-validation.js';

describe('browser input validation', () => {
  it('keeps bounded structured actions and strips unknown fields', () => {
    expect(
      parseBrowserActionRequest({
        kind: 'type',
        selector: '#editor',
        value: 'hello',
        unknown: 'not forwarded',
      }),
    ).toEqual({ kind: 'type', selector: '#editor', value: 'hello' });
  });

  it.each([
    ['selector', { kind: 'click', selector: 's'.repeat(MAX_BROWSER_SELECTOR_CHARS + 1) }],
    ['semantic text', { kind: 'click', text: 't'.repeat(MAX_BROWSER_SEMANTIC_TARGET_CHARS + 1) }],
    ['typed value', { kind: 'type', value: 'v'.repeat(MAX_BROWSER_TYPED_VALUE_CHARS + 1) }],
    ['key count', { kind: 'press', keys: Array.from({ length: MAX_BROWSER_KEYS + 1 }, () => 'Shift') }],
    ['key length', { kind: 'press', keys: ['k'.repeat(MAX_BROWSER_KEY_CHARS + 1)] }],
    ['coordinate magnitude', { kind: 'drag', x: 1, y: 1, endX: MAX_BROWSER_INPUT_COORDINATE + 1 }],
    ['non-finite wheel delta', { kind: 'scroll', deltaY: Number.POSITIVE_INFINITY }],
  ])('rejects an over-limit %s', (_label, request) => {
    expect(() => parseBrowserActionRequest(request)).toThrow();
  });

  it('applies narrower kind-specific limits to overloaded text input', () => {
    expect(() => parseBrowserActionRequest({ kind: 'press', text: 'k'.repeat(MAX_BROWSER_KEY_CHARS + 1) })).toThrow(
      /press text/,
    );
    expect(() =>
      parseBrowserActionRequest({
        kind: 'hover',
        text: 't'.repeat(MAX_BROWSER_SEMANTIC_TARGET_CHARS + 1),
      }),
    ).toThrow(/hover text/);
  });

  it('accepts key chords but rejects non-modifier prefixes that execution would discard', () => {
    expect(parseBrowserActionRequest({ kind: 'press', keys: ['Control', 'Shift', 'A'] })).toMatchObject({
      keys: ['Control', 'Shift', 'A'],
    });
    expect(() => parseBrowserActionRequest({ kind: 'press', keys: ['x', 'Enter'] })).toThrow(/only modifiers/i);
  });

  it('bounds component screenshot selectors and supplies stable defaults', () => {
    expect(parseBrowserScreenshotRequest({ mode: 'viewport' })).toEqual({
      mode: 'viewport',
      saveToFile: false,
      exportToFile: false,
    });
    expect(() =>
      parseBrowserScreenshotRequest({
        mode: 'element',
        selector: 's'.repeat(MAX_BROWSER_SELECTOR_CHARS + 1),
      }),
    ).toThrow();
  });

  it('preserves the bounded document token used by interactive element capture', () => {
    expect(
      parseBrowserScreenshotRequest({
        mode: 'element',
        selector: '#picked',
        documentToken: 'tab:3:4:5',
      }),
    ).toMatchObject({ documentToken: 'tab:3:4:5' });
    expect(() =>
      parseBrowserScreenshotRequest({
        mode: 'element',
        selector: '#picked',
        documentToken: 'd'.repeat(257),
      }),
    ).toThrow();
  });
});

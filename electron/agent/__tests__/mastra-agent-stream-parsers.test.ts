/**
 * Tests for mastra-agent.ts stream-payload parsers (via __internal). These
 * decode provider stream chunks: the text extractor picks the delta field,
 * the finish-reason extractor prefers stepResult, and the structural-event
 * allowlist decides which chunk `type`s are "known/expected" (vs warned as
 * unexpected). A real event type falling out of the allowlist would spuriously
 * warn/error on a valid stream, so lock it.
 */
import { describe, it, expect } from 'vitest';
import { __internal } from '../mastra-agent.js';

const { extractStreamText, extractStreamFinishReason, isExpectedMastraStructuralEvent } = __internal;

describe('extractStreamText', () => {
  it('follows the text → textDelta → delta precedence', () => {
    expect(extractStreamText({ text: 'a', textDelta: 'b', delta: 'c' })).toBe('a');
    expect(extractStreamText({ textDelta: 'b', delta: 'c' })).toBe('b');
    expect(extractStreamText({ delta: 'c' })).toBe('c');
  });
  it('returns "" for undefined / empty / non-string fields', () => {
    expect(extractStreamText(undefined)).toBe('');
    expect(extractStreamText({})).toBe('');
    expect(extractStreamText({ text: 42 } as unknown as Record<string, unknown>)).toBe('');
  });
  it('preserves an empty-string text field (not coerced past it)', () => {
    expect(extractStreamText({ text: '' })).toBe('');
  });
});

describe('extractStreamFinishReason', () => {
  it('prefers stepResult.reason over finishReason', () => {
    expect(extractStreamFinishReason({ stepResult: { reason: 'stop' }, finishReason: 'length' })).toBe('stop');
  });
  it('falls back to finishReason when stepResult has none', () => {
    expect(extractStreamFinishReason({ finishReason: 'length' })).toBe('length');
    expect(extractStreamFinishReason({ stepResult: {}, finishReason: 'tool-calls' })).toBe('tool-calls');
  });
  it('returns undefined when neither is present / not a string', () => {
    expect(extractStreamFinishReason(undefined)).toBeUndefined();
    expect(extractStreamFinishReason({})).toBeUndefined();
    expect(extractStreamFinishReason({ finishReason: 5 } as unknown as Record<string, unknown>)).toBeUndefined();
  });
});

describe('isExpectedMastraStructuralEvent', () => {
  it('recognizes the known structural + reasoning + tool-streaming event types', () => {
    for (const t of [
      'start',
      'abort',
      'text-start',
      'text-end',
      'step-start',
      'stream-start',
      'response-metadata',
      'reasoning',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'reasoning-signature',
      'redacted-reasoning',
      'source',
      'file',
      'tool-call-streaming-start',
      'tool-call-input-streaming-start',
      'tool-call-input-streaming-end',
      'tool-call-delta',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-end',
      'raw',
    ]) {
      expect(isExpectedMastraStructuralEvent(t), t).toBe(true);
    }
  });
  it('returns false for content-bearing / unknown types (which get handled or warned elsewhere)', () => {
    // text-delta and tool-call/tool-result are content events handled explicitly,
    // NOT in the structural allowlist.
    expect(isExpectedMastraStructuralEvent('text-delta')).toBe(false);
    expect(isExpectedMastraStructuralEvent('tool-call')).toBe(false);
    expect(isExpectedMastraStructuralEvent('tool-result')).toBe(false);
    expect(isExpectedMastraStructuralEvent('finish')).toBe(false);
    expect(isExpectedMastraStructuralEvent('totally-unknown')).toBe(false);
    expect(isExpectedMastraStructuralEvent('')).toBe(false);
  });
});

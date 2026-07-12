/**
 * Tests for src/lib/userCodeMarkdown.ts — the composer's markdown tokenizer +
 * serializers. Named .test.tsx so it runs under the component (jsdom) config,
 * which is what pre-push + CI now gate (see 178f07b); the functions are pure so
 * the DOM env is incidental. The serializers' backtick/fence-length logic is the
 * subtle part: wrapping code that itself contains backticks must round-trip.
 */
import { describe, it, expect } from 'vitest';
import {
  parseUserCodeMarkdown,
  longestBacktickRun,
  serializeInlineCode,
  serializeFencedCode,
} from '../userCodeMarkdown';

describe('longestBacktickRun', () => {
  it('returns the longest consecutive backtick run', () => {
    expect(longestBacktickRun('a```b`c')).toBe(3);
    expect(longestBacktickRun('no ticks')).toBe(0);
    expect(longestBacktickRun('`')).toBe(1);
    expect(longestBacktickRun('`` ``` ``')).toBe(3);
  });
});

describe('parseUserCodeMarkdown', () => {
  it('returns [] for empty input', () => {
    expect(parseUserCodeMarkdown('')).toEqual([]);
  });

  it('segments text around inline code', () => {
    const segs = parseUserCodeMarkdown('a `x` b');
    expect(segs.map((s) => s.type)).toEqual(['text', 'inlineCode', 'text']);
    const inline = segs[1];
    expect(inline.type).toBe('inlineCode');
    if (inline.type === 'inlineCode') {
      expect(inline.code).toBe('x');
      expect(inline.delimiterLength).toBe(1);
      expect(inline.raw).toBe('`x`');
    }
    expect(segs[0]).toMatchObject({ type: 'text', text: 'a ' });
    expect(segs[2]).toMatchObject({ type: 'text', text: ' b' });
  });

  it('parses a fenced code block with language', () => {
    const segs = parseUserCodeMarkdown('```js\nfoo\n```');
    expect(segs).toHaveLength(1);
    const fence = segs[0];
    expect(fence.type).toBe('fencedCode');
    if (fence.type === 'fencedCode') {
      expect(fence.code).toBe('foo');
      expect(fence.language).toBe('js');
      expect(fence.fenceLength).toBe(3);
    }
  });

  it('treats plain text with no backticks as a single text segment', () => {
    const segs = parseUserCodeMarkdown('just words');
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ type: 'text', text: 'just words' });
  });

  it('does not treat an unterminated inline backtick as code', () => {
    const segs = parseUserCodeMarkdown('a `b c');
    // no closing backtick on the line → all text
    expect(segs.every((s) => s.type === 'text')).toBe(true);
  });
});

describe('serializeInlineCode', () => {
  it('single-backtick wraps and escapes internal backticks', () => {
    expect(serializeInlineCode('a`b')).toEqual({ raw: '`a\\`b`', delimiterLength: 1 });
    expect(serializeInlineCode('plain')).toEqual({ raw: '`plain`', delimiterLength: 1 });
  });

  it('with a preferred delimiter >1, uses a run longer than the internal backticks (round-trip safe)', () => {
    // internal longest run is 1 → delimiter 2 is enough, no escaping
    expect(serializeInlineCode('a`b', 2)).toEqual({ raw: '``a`b``', delimiterLength: 2 });
    // internal run 2 forces delimiter 3 even if preferred was 2
    expect(serializeInlineCode('a``b', 2)).toEqual({ raw: '```a``b```', delimiterLength: 3 });
  });
});

describe('serializeFencedCode', () => {
  it('uses a 3-backtick fence for simple code and appends a trailing newline', () => {
    expect(serializeFencedCode('foo', 'js')).toEqual({ raw: '```js\nfoo\n```', fenceLength: 3 });
  });

  it('grows the fence past the longest internal backtick run', () => {
    // "has ``` inside" has a run of 3 → fence must be 4
    expect(serializeFencedCode('has ``` inside', 'ts')).toEqual({
      raw: '````ts\nhas ``` inside\n````',
      fenceLength: 4,
    });
  });

  it('preserves an existing trailing newline (no double newline)', () => {
    const { raw } = serializeFencedCode('foo\n', '');
    expect(raw).toBe('```\nfoo\n```');
  });
});

/**
 * Tests for tool-observer.ts exported pure summarizers. These bound what the
 * mid-tool observer LLM sees each tick — the char/message caps keep the observer
 * prompt from growing without limit as a conversation (or a single message)
 * gets large, and the tool-call/tool-result formatting is the compact shape the
 * observer reasons over. Lock both.
 */
import { describe, it, expect } from 'vitest';
import {
  summarizeLatestUserRequest,
  summarizeThreadContext,
  clampHeadTail,
  oneLineCapped,
  toResultSummary,
} from '../tool-observer.js';

describe('summarizeLatestUserRequest', () => {
  it('returns the most recent user message text', () => {
    const msgs = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ];
    expect(summarizeLatestUserRequest(msgs)).toBe('second');
  });

  it('extracts text from array (multi-part) content', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'line one' },
          { type: 'image', url: 'x' },
          { type: 'text', text: 'line two' },
        ],
      },
    ];
    expect(summarizeLatestUserRequest(msgs)).toBe('line one\nline two');
  });

  it('skips non-user and empty-text messages', () => {
    const msgs = [
      { role: 'user', content: 'real request' },
      { role: 'assistant', content: 'ignored' },
      { role: 'user', content: '   ' }, // whitespace-only → skipped
      { role: 'tool', content: 'also ignored' },
    ];
    expect(summarizeLatestUserRequest(msgs)).toBe('real request');
  });

  it('caps at 1200 chars', () => {
    const msgs = [{ role: 'user', content: 'x'.repeat(5000) }];
    expect(summarizeLatestUserRequest(msgs)).toHaveLength(1200);
  });

  it('returns empty string when there is no user message', () => {
    expect(summarizeLatestUserRequest([])).toBe('');
    expect(summarizeLatestUserRequest([{ role: 'assistant', content: 'hi' }])).toBe('');
    expect(summarizeLatestUserRequest([null, 42, 'nope'])).toBe('');
  });
});

describe('summarizeThreadContext', () => {
  it('formats text + tool-call + tool-result parts with UPPERCASE roles', () => {
    const msgs = [
      { role: 'user', content: 'do a thing' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'working on it' },
          { type: 'tool-call', toolName: 'sh', toolCallId: 'tc1' },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolName: 'sh', toolCallId: 'tc1', result: 'ok' }],
      },
    ];
    const out = summarizeThreadContext(msgs);
    expect(out).toContain('USER: do a thing');
    expect(out).toContain('[tool-call] sh (tc1)');
    expect(out).toContain('[tool-result] sh (tc1) completed');
  });

  it('marks an errored tool-result', () => {
    const msgs = [{ role: 'tool', content: [{ type: 'tool-result', toolName: 'sh', isError: true }] }];
    expect(summarizeThreadContext(msgs)).toContain('[tool-result] sh error');
  });

  it('keeps only the last maxMessages entries', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const out = summarizeThreadContext(msgs, { maxMessages: 3 });
    expect(out).toContain('m19');
    expect(out).toContain('m17');
    expect(out).not.toContain('m16');
  });

  it('enforces the per-message char cap', () => {
    const msgs = [{ role: 'user', content: 'y'.repeat(1000) }];
    const out = summarizeThreadContext(msgs, { maxCharsPerMessage: 100 });
    // "USER: " prefix + 100 chars of content
    expect(out.length).toBeLessThanOrEqual('USER: '.length + 100);
  });

  it('enforces the total char cap (keeps the tail)', () => {
    const msgs = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `message-${i}` }));
    const out = summarizeThreadContext(msgs, { maxMessages: 50, maxTotalChars: 500 });
    expect(out.length).toBeLessThanOrEqual(500);
    // tail-preserving: the most recent message survives
    expect(out).toContain('message-49');
  });

  it('skips non-object / empty-summary messages', () => {
    const out = summarizeThreadContext([null, 42, { role: 'user', content: '' }, { role: 'user', content: 'kept' }]);
    expect(out).toBe('USER: kept');
  });

  it('clamps option lower bounds (maxMessages>=1, per-msg>=80, total>=500)', () => {
    const msgs = [{ role: 'user', content: 'hello world' }];
    // absurdly small options must not throw or zero-out
    const out = summarizeThreadContext(msgs, { maxMessages: 0, maxCharsPerMessage: 1, maxTotalChars: 1 });
    expect(out).toContain('USER: hello world');
  });
});

describe('clampHeadTail / oneLineCapped (huge-output bounding)', () => {
  it('returns whitespace-collapsed value unchanged when under the cap', () => {
    expect(clampHeadTail('a\t b\n c', 240)).toBe('a b c');
    expect(oneLineCapped('a\t b\n c', 240)).toBe('a b c');
  });

  it('clamps a large value with a head+tail snip marker, staying near the cap', () => {
    const big = 'H'.repeat(1000) + 'MIDDLE' + 'T'.repeat(1000);
    const out = clampHeadTail(big, 280);
    expect(out).toContain('[...snip...]');
    expect(out.startsWith('H')).toBe(true);
    expect(out.endsWith('T')).toBe(true);
    // bounded — never the full 2006 chars
    expect(out.length).toBeLessThanOrEqual(280);
  });

  it('does not scan/allocate the whole input: a huge input yields a bounded result', () => {
    // 50MB single-char string — must return quickly and small. If the impl
    // whitespace-normalized the whole thing first this would be slow/large.
    const huge = 'x'.repeat(50 * 1024 * 1024);
    const t0 = Date.now();
    const capped = oneLineCapped(huge, 240);
    const clamped = clampHeadTail(huge, 240);
    expect(capped.length).toBeLessThanOrEqual(240);
    expect(clamped.length).toBeLessThanOrEqual(240);
    // generous ceiling — real impl slices before regex so this is milliseconds
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('maxChars<=0 yields empty', () => {
    expect(clampHeadTail('abc', 0)).toBe('');
    expect(clampHeadTail('abc', -5)).toBe('');
  });
});

describe('toResultSummary', () => {
  it('summarizes an error object as isError with capped text', () => {
    const r = toResultSummary({ error: '  boom  \n  happened  ' });
    expect(r.isError).toBe(true);
    expect(r.summary).toBe('boom happened');
  });

  it('clamps a huge stdout with the snip marker', () => {
    const r = toResultSummary({ stdout: 'A'.repeat(5000) + 'Z'.repeat(5000) });
    expect(r.isError).toBe(false);
    expect(r.summary).toContain('[...snip...]');
    expect(r.summary.length).toBeLessThanOrEqual(240);
  });

  it('handles a bare string result and a non-string/opaque result', () => {
    expect(toResultSummary('just a string').summary).toBe('just a string');
    expect(toResultSummary(42).summary).toBe('[result captured]');
    expect(toResultSummary(null).summary).toBe('[result captured]');
  });
});

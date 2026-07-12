/**
 * Tests for ai-review.ts pure helpers (via __internal). parseReviewResponse is
 * the fail-safe that turns an AI reviewer's raw model output into a verdict that
 * can AUTO-ADVANCE work past human review — so a malformed/untrusted response
 * must never be treated as a pass. Lock the strict-shape + fail-safe behavior.
 */
import { describe, it, expect } from 'vitest';
import { __internal } from '../ai-review.js';

const { parseReviewResponse, truncateTerminalOutput } = __internal;

describe('parseReviewResponse', () => {
  it('parses a clean pass verdict', () => {
    const r = parseReviewResponse('{"passed": true, "summary": "Looks good"}');
    expect(r.passed).toBe(true);
    expect(r.summary).toBe('Looks good');
    expect(r.issues).toBeUndefined();
  });

  it('parses a fail verdict with issues', () => {
    const r = parseReviewResponse('{"passed": false, "summary": "Problems", "issues": ["a", "b"]}');
    expect(r.passed).toBe(false);
    expect(r.summary).toBe('Problems');
    expect(r.issues).toEqual(['a', 'b']);
  });

  it('extracts JSON wrapped in code fences / prose', () => {
    const r = parseReviewResponse('Here is my verdict:\n```json\n{"passed": true, "summary": "ok"}\n```\nDone.');
    expect(r.passed).toBe(true);
    expect(r.summary).toBe('ok');
  });

  it('fails safe (passed=false) on a non-JSON response', () => {
    const r = parseReviewResponse('I think the work looks fine, approving.');
    expect(r.passed).toBe(false);
    expect(r.issues).toBeDefined();
  });

  it('fails safe on malformed JSON', () => {
    const r = parseReviewResponse('{"passed": true, "summary": ');
    expect(r.passed).toBe(false);
  });

  it('fails safe when passed is not a real boolean (string "true")', () => {
    const r = parseReviewResponse('{"passed": "true", "summary": "sneaky"}');
    expect(r.passed).toBe(false);
    expect(r.summary).toMatch(/invalid verdict shape/i);
  });

  it('fails safe when summary is missing or non-string', () => {
    expect(parseReviewResponse('{"passed": true}').passed).toBe(false);
    expect(parseReviewResponse('{"passed": true, "summary": 42}').passed).toBe(false);
  });

  it('fails safe when issues is present but wrong-typed', () => {
    // A present-but-untrusted issues field taints the whole verdict.
    const r = parseReviewResponse('{"passed": true, "summary": "ok", "issues": "not-an-array"}');
    expect(r.passed).toBe(false);
    const r2 = parseReviewResponse('{"passed": true, "summary": "ok", "issues": [1, 2]}');
    expect(r2.passed).toBe(false);
  });

  it('accepts issues as null or omitted (treated as no issues)', () => {
    expect(parseReviewResponse('{"passed": true, "summary": "ok", "issues": null}').passed).toBe(true);
    expect(parseReviewResponse('{"passed": true, "summary": "ok"}').passed).toBe(true);
  });

  it('drops an empty issues array (no issues field on the result)', () => {
    const r = parseReviewResponse('{"passed": false, "summary": "x", "issues": []}');
    expect(r.passed).toBe(false);
    expect(r.issues).toBeUndefined();
  });
});

describe('truncateTerminalOutput', () => {
  it('returns short output unchanged', () => {
    expect(truncateTerminalOutput('hello', 100)).toBe('hello');
  });

  it('truncates long output with a head + tail and an omitted-count marker', () => {
    const input = 'A'.repeat(50) + 'B'.repeat(50);
    const out = truncateTerminalOutput(input, 20);
    expect(out).toContain('output truncated');
    expect(out).toContain('80 chars omitted'); // 100 - 20
    expect(out.startsWith('A')).toBe(true); // head
    expect(out.endsWith('B')).toBe(true); // tail
    expect(out.length).toBeLessThan(input.length);
  });
});

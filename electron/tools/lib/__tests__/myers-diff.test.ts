/**
 * Tests for the vendored Myers unified-diff engine (electron/tools/lib/myers-diff.ts).
 * This powers the diff-tracker (list_file_changes / revert-hunk), so a wrong hunk
 * boundary or line number silently shows or reverts the wrong lines and can
 * corrupt a user's file. Pure functions — tested directly, incl. the
 * compute→format→parse round-trip which is the strongest correctness invariant.
 */
import { describe, it, expect } from 'vitest';
import { computeUnifiedDiff, parseUnifiedDiff } from '../myers-diff.js';

describe('computeUnifiedDiff', () => {
  it('produces no hunks and empty output for identical inputs', () => {
    const r = computeUnifiedDiff('a\nb\nc\n', 'a\nb\nc\n');
    expect(r.hunks).toEqual([]);
    expect(r.additions).toBe(0);
    expect(r.deletions).toBe(0);
    expect(r.unified).toBe('');
  });

  it('counts a pure addition (empty → content)', () => {
    const r = computeUnifiedDiff('', 'x\ny\n');
    expect(r.additions).toBe(2);
    expect(r.deletions).toBe(0);
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0].lines.every((l) => l.type === 'add')).toBe(true);
  });

  it('counts a pure deletion (content → empty)', () => {
    const r = computeUnifiedDiff('x\ny\n', '');
    expect(r.deletions).toBe(2);
    expect(r.additions).toBe(0);
    expect(r.hunks[0].lines.every((l) => l.type === 'del')).toBe(true);
  });

  it('represents a single middle-line edit as a del + add surrounded by context', () => {
    const r = computeUnifiedDiff('a\nb\nc\n', 'a\nB\nc\n');
    expect(r.additions).toBe(1);
    expect(r.deletions).toBe(1);
    expect(r.hunks).toHaveLength(1);
    const types = r.hunks[0].lines.map((l) => `${l.type}:${l.text}`);
    expect(types).toContain('del:b');
    expect(types).toContain('add:B');
    expect(types).toContain('context:a');
    expect(types).toContain('context:c');
  });

  it('emits a correct @@ header with 1-based line numbers', () => {
    const r = computeUnifiedDiff('a\nb\nc\nd\ne\n', 'a\nb\nX\nd\ne\n', { path: 'f.txt' });
    expect(r.unified).toContain('--- a/f.txt');
    expect(r.unified).toContain('+++ b/f.txt');
    // The single change is on line 3; with default context 3 the hunk starts at line 1.
    expect(r.unified).toMatch(/@@ -1,\d+ \+1,\d+ @@/);
  });

  it('respects a custom context width', () => {
    const original = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\n';
    const current = 'l1\nl2\nl3\nX\nl5\nl6\nl7\n';
    const c0 = computeUnifiedDiff(original, current, { context: 0 });
    const c1 = computeUnifiedDiff(original, current, { context: 1 });
    const ctx0 = c0.hunks[0].lines.filter((l) => l.type === 'context').length;
    const ctx1 = c1.hunks[0].lines.filter((l) => l.type === 'context').length;
    expect(ctx0).toBe(0);
    expect(ctx1).toBeGreaterThan(ctx0);
  });

  it('handles trailing-newline semantics (empty string = 0 lines, trailing \\n dropped)', () => {
    // "a\nb" and "a\nb\n" are the same line set → no diff.
    expect(computeUnifiedDiff('a\nb', 'a\nb\n').hunks).toEqual([]);
    // Empty string is zero lines, not one empty line.
    expect(computeUnifiedDiff('', '').hunks).toEqual([]);
  });

  it('falls back to a full del+add block for a rewrite larger than the Myers cap', () => {
    // > MAX_MYERS_LINES (8000) combined lines with no common prefix → block replace.
    const a = Array.from({ length: 5000 }, (_, i) => `old-${i}`).join('\n');
    const b = Array.from({ length: 5000 }, (_, i) => `new-${i}`).join('\n');
    const r = computeUnifiedDiff(a, b);
    expect(r.deletions).toBe(5000);
    expect(r.additions).toBe(5000);
  });
});

describe('parseUnifiedDiff', () => {
  it('returns [] for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('parses a hunk header with explicit counts', () => {
    const hunks = parseUnifiedDiff('@@ -2,3 +2,4 @@\n a\n-b\n+B\n+C\n c');
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ aStart: 2, aCount: 3, bStart: 2, bCount: 4 });
    expect(hunks[0].lines.map((l) => l.type)).toEqual(['context', 'del', 'add', 'add', 'context']);
  });

  it('defaults a missing ,count to 1 (git single-line hunk form)', () => {
    const hunks = parseUnifiedDiff('@@ -5 +5 @@\n-x\n+y');
    expect(hunks[0]).toMatchObject({ aStart: 5, aCount: 1, bStart: 5, bCount: 1 });
  });

  it('ignores --- / +++ file headers and classifies line types', () => {
    const hunks = parseUnifiedDiff('--- a/f\n+++ b/f\n@@ -1,1 +1,2 @@\n ctx\n+added');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toEqual([
      { type: 'context', text: 'ctx' },
      { type: 'add', text: 'added' },
    ]);
  });

  it('treats a blank line inside a hunk as empty context', () => {
    const hunks = parseUnifiedDiff('@@ -1,2 +1,2 @@\n a\n\n');
    expect(hunks[0].lines).toContainEqual({ type: 'context', text: '' });
  });
});

describe('compute → format → parse round-trip', () => {
  it('parses computeUnifiedDiff output back into matching hunk shapes', () => {
    const original = 'alpha\nbravo\ncharlie\ndelta\necho\n';
    const current = 'alpha\nBRAVO\ncharlie\ndelta\nECHO\n';
    const result = computeUnifiedDiff(original, current, { path: 'x.txt' });
    const reparsed = parseUnifiedDiff(result.unified);

    expect(reparsed.length).toBe(result.hunks.length);
    for (let i = 0; i < result.hunks.length; i++) {
      expect(reparsed[i].aStart).toBe(result.hunks[i].aStart);
      expect(reparsed[i].aCount).toBe(result.hunks[i].aCount);
      expect(reparsed[i].bStart).toBe(result.hunks[i].bStart);
      expect(reparsed[i].bCount).toBe(result.hunks[i].bCount);
      expect(reparsed[i].lines).toEqual(result.hunks[i].lines);
    }
  });

  it('round-trips a pure-addition diff (empty original)', () => {
    const result = computeUnifiedDiff('', 'one\ntwo\nthree\n', { path: 'new.txt' });
    const reparsed = parseUnifiedDiff(result.unified);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].lines).toEqual(result.hunks[0].lines);
    expect(reparsed[0].lines.every((l) => l.type === 'add')).toBe(true);
  });
});

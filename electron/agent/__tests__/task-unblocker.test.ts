/**
 * Tests for assessComplexityFromAnswer (task-unblocker.ts) — the fail-safe that
 * decides whether an autopilot task still requires human review. ONLY a
 * standalone "NO" may skip review; everything else (including look-alikes and
 * malformed output) must still require it. Caller passes a trimmed+uppercased
 * answer, so tests do the same.
 */
import { describe, it, expect } from 'vitest';
import { assessComplexityFromAnswer } from '../task-unblocker.js';

describe('assessComplexityFromAnswer', () => {
  it('lets a standalone NO skip review (returns false = no review needed)', () => {
    expect(assessComplexityFromAnswer('NO')).toBe(false);
    expect(assessComplexityFromAnswer('NO.')).toBe(false);
    expect(assessComplexityFromAnswer('NO!')).toBe(false);
  });

  it('still requires review for YES', () => {
    expect(assessComplexityFromAnswer('YES')).toBe(true);
  });

  it('still requires review for NO look-alikes (fail-safe)', () => {
    for (const a of ['NONE', 'NOT SURE', 'NO123', 'NO WAY', 'NOPE', 'NO,', 'NO ']) {
      // Note: caller trims, so 'NO ' wouldn't actually reach here trimmed — but
      // an internal-space variant like "NO WAY" must require review.
      expect(assessComplexityFromAnswer(a.trim()), `${a} should require review`).toBe(a.trim() === 'NO' ? false : true);
    }
  });

  it('still requires review for empty / malformed output', () => {
    expect(assessComplexityFromAnswer('')).toBe(true);
    expect(assessComplexityFromAnswer('.')).toBe(true);
    expect(assessComplexityFromAnswer('MAYBE')).toBe(true);
  });
});

/**
 * Tests for the app-shot reference parse/format pair (shared/app-shots.ts).
 * parseAppShotRef extracts a refId from (partially model/user-supplied) message
 * text via a bounded regex — the charset + length bounds matter (they keep the
 * match tight and ReDoS-free), so lock them here.
 *
 * Lives under electron/__tests__ (not shared/__tests__) because the canonical
 * `pnpm test` include is electron/** + scripts/** only — shared/** modules are
 * covered by electron-side test files that import them.
 */
import { describe, it, expect } from 'vitest';
import { parseAppShotRef, formatAppShotRef, APP_SHOT_REF_PREFIX } from '../../shared/app-shots.js';

describe('formatAppShotRef', () => {
  it('wraps the refId in the bracketed kai-appshot: prefix', () => {
    expect(formatAppShotRef('abc123')).toBe('[kai-appshot:abc123]');
    expect(APP_SHOT_REF_PREFIX).toBe('kai-appshot:');
  });
});

describe('parseAppShotRef', () => {
  it('round-trips a formatted ref', () => {
    const ref = formatAppShotRef('Ref_id-01');
    expect(parseAppShotRef(ref)).toBe('Ref_id-01');
  });

  it('extracts a ref embedded in surrounding text', () => {
    expect(parseAppShotRef('see the screenshot [kai-appshot:snap01x] here')).toBe('snap01x');
  });

  it('returns null when there is no ref', () => {
    expect(parseAppShotRef('')).toBeNull();
    expect(parseAppShotRef('no reference here')).toBeNull();
    expect(parseAppShotRef('kai-appshot:missing-brackets123')).toBeNull(); // needs [ ]
  });

  it('enforces the 6–64 char length bound', () => {
    expect(parseAppShotRef('[kai-appshot:short]')).toBeNull(); // 5 chars < 6
    expect(parseAppShotRef('[kai-appshot:abcdef]')).toBe('abcdef'); // exactly 6
    const id64 = 'a'.repeat(64);
    expect(parseAppShotRef(`[kai-appshot:${id64}]`)).toBe(id64); // exactly 64
    // 65 chars: the {6,64} run can never be immediately followed by ']' (the
    // 65th char is always in the way as the regex backtracks) → no match.
    expect(parseAppShotRef(`[kai-appshot:${'a'.repeat(65)}]`)).toBeNull();
  });

  it('rejects out-of-charset characters in the id', () => {
    expect(parseAppShotRef('[kai-appshot:has space]')).toBeNull();
    expect(parseAppShotRef('[kai-appshot:has/slash]')).toBeNull();
    expect(parseAppShotRef('[kai-appshot:has.dot]')).toBeNull();
  });

  it('returns the first ref when several are present', () => {
    expect(parseAppShotRef('[kai-appshot:first0] and [kai-appshot:second1]')).toBe('first0');
  });
});

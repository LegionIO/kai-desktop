/**
 * Tests for expandTilde — the fix for skills (and other config paths) silently
 * not loading when a config value stores a literal `~` and the user's home
 * contains special characters (e.g. `/Users/first_last@optum.com/`).
 */
import { describe, it, expect, vi } from 'vitest';
import type * as OS from 'os';

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof OS>('os');
  return { ...actual, homedir: () => '/Users/bezawada_venkatavishnu@optum.com' };
});

import { expandTilde } from '../expand-tilde.js';

describe('expandTilde', () => {
  const HOME = '/Users/bezawada_venkatavishnu@optum.com';

  it('expands a bare ~ to the real home (with @ in the path)', () => {
    expect(expandTilde('~')).toBe(HOME);
  });

  it('expands ~/… to an absolute path under home — the skills-dir case', () => {
    expect(expandTilde('~/.kai/skills')).toBe(`${HOME}/.kai/skills`);
  });

  it('leaves an already-absolute path unchanged', () => {
    expect(expandTilde('/opt/kai/skills')).toBe('/opt/kai/skills');
  });

  it('does NOT expand a mid-string ~ or a ~user form (only a leading ~/ or bare ~)', () => {
    expect(expandTilde('/a/~/b')).toBe('/a/~/b');
    expect(expandTilde('~otheruser/x')).toBe('~otheruser/x');
  });

  it('the buggy literal-tilde value now resolves to a real directory, not a folder named "~"', () => {
    const out = expandTilde('~/.kai/skills');
    expect(out.startsWith('~')).toBe(false);
    expect(out).toContain('@optum.com'); // special char in home preserved
  });
});

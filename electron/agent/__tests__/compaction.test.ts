import { describe, it, expect } from 'vitest';
import { isStrictPrefix } from '../compaction';

describe('isStrictPrefix (compaction reuse / divergence detector)', () => {
  it('is true when ids are an ordered prefix of the branch', () => {
    expect(isStrictPrefix(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe(true);
  });

  it('is true when ids equal the whole branch', () => {
    expect(isStrictPrefix(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(true);
  });

  it('is false on an empty stored-id list (nothing to reuse ⇒ recompute)', () => {
    expect(isStrictPrefix([], ['a', 'b'])).toBe(false);
  });

  it('is false when the stored ids are longer than the branch', () => {
    expect(isStrictPrefix(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
  });

  it('is false when the branch diverges mid-prefix (fork/edit changed a leading id)', () => {
    // e.g. the user edited message b → its id changed; the summary no longer applies.
    expect(isStrictPrefix(['a', 'b', 'c'], ['a', 'B2', 'c', 'd'])).toBe(false);
  });

  it('is false when the very first id differs (rewind to a different root child)', () => {
    expect(isStrictPrefix(['a', 'b'], ['x', 'b'])).toBe(false);
  });

  it('order matters — same set in different order is not a prefix', () => {
    expect(isStrictPrefix(['a', 'b'], ['b', 'a', 'c'])).toBe(false);
  });

  it('a stored empty-string id cannot match an id-less branch sentinel', () => {
    // Defense-in-depth: even if a bad record had [''], the reuse gate maps id-less
    // branch messages to a unique sentinel (never ''), so this must not match.
    expect(isStrictPrefix([''], [' no-id-0', 'b'])).toBe(false);
  });
});

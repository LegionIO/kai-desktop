/**
 * Tests for selectReviewersFromResponse (reviewer-selection.ts) — the pure
 * parse+validate that turns the reviewer-picker model's output into a concrete
 * reviewer id list. It must never trust a model-supplied id that isn't a real
 * reviewer, must dedupe (so a repeated id can't satisfy the quorum and silently
 * shrink the set), and must always return exactly `count` ids (supplementing /
 * falling back deterministically by name).
 */
import { describe, it, expect } from 'vitest';
import { selectReviewersFromResponse } from '../reviewer-selection.js';
import type { AgentFile } from '../../../shared/agent-types.js';

const rev = (id: string, name: string): AgentFile => ({ id, name }) as AgentFile;
const REVIEWERS: AgentFile[] = [
  rev('r-charlie', 'Charlie'),
  rev('r-alice', 'Alice'),
  rev('r-bob', 'Bob'),
  rev('r-dave', 'Dave'),
];

describe('selectReviewersFromResponse', () => {
  it('returns the model-picked valid ids (first `count`)', () => {
    const out = selectReviewersFromResponse('["r-bob", "r-alice"]', REVIEWERS, 2);
    expect(out).toEqual(['r-bob', 'r-alice']);
  });

  it('drops ids that are not real reviewers, then supplements to count', () => {
    // one valid + one bogus → keep valid, supplement 1 from remaining
    const out = selectReviewersFromResponse('["r-bob", "ghost-id"]', REVIEWERS, 2);
    expect(out).toHaveLength(2);
    expect(out).toContain('r-bob');
    expect(out).not.toContain('ghost-id');
    // Supplement preserves the ORIGINAL availableReviewers order (not name-sorted;
    // only the no-array/malformed FALLBACK path sorts by name). Remaining after
    // r-bob in original order [charlie, alice, bob, dave] → charlie first.
    expect(out[1]).toBe('r-charlie');
  });

  it('dedupes so a repeated id cannot satisfy the quorum', () => {
    const out = selectReviewersFromResponse('["r-bob", "r-bob", "r-bob"]', REVIEWERS, 2);
    expect(out).toHaveLength(2);
    expect(new Set(out).size).toBe(2); // no duplicates
    expect(out[0]).toBe('r-bob');
  });

  it('filters non-string ids from the array', () => {
    const out = selectReviewersFromResponse('["r-bob", 42, null, "r-alice"]', REVIEWERS, 2);
    expect(out).toEqual(['r-bob', 'r-alice']);
  });

  it('falls back to first-N-by-name when there is no JSON array', () => {
    const out = selectReviewersFromResponse('I would pick Bob and Alice', REVIEWERS, 2);
    // by name: Alice, Bob, Charlie, Dave → first 2
    expect(out).toEqual(['r-alice', 'r-bob']);
  });

  it('falls back to by-name on malformed JSON', () => {
    const out = selectReviewersFromResponse('["r-bob", ', REVIEWERS, 2);
    expect(out).toEqual(['r-alice', 'r-bob']);
  });

  it('falls back to by-name when the JSON is not an array', () => {
    const out = selectReviewersFromResponse('{"pick": "r-bob"}', REVIEWERS, 2);
    // no [..] match → byName
    expect(out).toEqual(['r-alice', 'r-bob']);
  });

  it('supplements (in original order) when the model returns too few valid ids', () => {
    const out = selectReviewersFromResponse('["r-dave"]', REVIEWERS, 3);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('r-dave'); // model pick first
    // then remaining in ORIGINAL order excluding dave: charlie, alice
    expect(out.slice(1)).toEqual(['r-charlie', 'r-alice']);
  });

  it('does not mutate the caller array', () => {
    const input = [...REVIEWERS];
    const snapshot = input.map((r) => r.id);
    selectReviewersFromResponse('no array', input, 2);
    expect(input.map((r) => r.id)).toEqual(snapshot);
  });
});

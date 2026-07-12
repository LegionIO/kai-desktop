/**
 * Tests for parseRoleMatchResponse (agent-role-matching.ts) — the pure parse
 * that turns the role-matcher model's raw text into a validated {role, name}.
 * The resolved role picks which role template a new agent gets, and the name is
 * rendered in the sidebar/CLI — so JSON-shape, catalog resolution, and the
 * control/bidi-strip on the name all need to be locked.
 */
import { describe, it, expect } from 'vitest';
import { parseRoleMatchResponse } from '../agent-role-matching.js';
import type { AgentRoleEntry } from '../agent-roles.js';

const CATALOG: AgentRoleEntry[] = [
  { id: 'eng/reviewer', name: 'Code Reviewer', division: 'Engineering', description: 'reviews' },
  { id: 'eng/frontend', name: 'Frontend Dev', division: 'Engineering', description: 'ui' },
];

describe('parseRoleMatchResponse', () => {
  it('resolves an exact roleId match + a valid 2-word name', () => {
    const r = parseRoleMatchResponse('{"roleId": "eng/reviewer", "name": "Sharp Lens"}', CATALOG);
    expect(r.role?.id).toBe('eng/reviewer');
    expect(r.name).toBe('Sharp Lens');
  });

  it('strips markdown code fences before parsing', () => {
    const r = parseRoleMatchResponse('```json\n{"roleId": "eng/frontend", "name": "Vivid Craft"}\n```', CATALOG);
    expect(r.role?.id).toBe('eng/frontend');
    expect(r.name).toBe('Vivid Craft');
  });

  it('is case-insensitive on roleId and trims it', () => {
    const r = parseRoleMatchResponse('{"roleId": "  ENG/Reviewer  ", "name": "Iron Sentinel"}', CATALOG);
    expect(r.role?.id).toBe('eng/reviewer');
  });

  it('falls back to a fuzzy includes match when no exact id', () => {
    // model returned a fuller path that contains a catalog id as a substring
    const r = parseRoleMatchResponse('{"roleId": "prefix/eng/reviewer/x", "name": "Deep Scout"}', CATALOG);
    expect(r.role?.id).toBe('eng/reviewer');
  });

  it('returns a null role for none / empty / unmatched roleId', () => {
    expect(parseRoleMatchResponse('{"roleId": "none", "name": "Swift Agent"}', CATALOG).role).toBeNull();
    expect(parseRoleMatchResponse('{"roleId": "", "name": "Swift Agent"}', CATALOG).role).toBeNull();
    expect(parseRoleMatchResponse('{"roleId": "nope/nothing", "name": "Swift Agent"}', CATALOG).role).toBeNull();
  });

  it('still returns the generated name when the role is none', () => {
    const r = parseRoleMatchResponse('{"roleId": "none", "name": "Swift Agent"}', CATALOG);
    expect(r.role).toBeNull();
    expect(r.name).toBe('Swift Agent');
  });

  it('fails safe ({null, ""}) on non-JSON / malformed output', () => {
    expect(parseRoleMatchResponse('I could not decide', CATALOG)).toEqual({ role: null, name: '' });
    expect(parseRoleMatchResponse('{"roleId": "eng/reviewer", ', CATALOG)).toEqual({ role: null, name: '' });
  });

  it('strips control/bidi chars from the name (ANSI/RTL injection defense)', () => {
    // A right-to-left override (U+202E) embedded in the name is removed.
    const r = parseRoleMatchResponse('{"roleId": "none", "name": "Iron ‮Sentinel"}', CATALOG);
    expect(r.name).not.toContain('‮');
    expect(r.name).toBe('Iron Sentinel');
  });

  it('rejects a name that is not 3-40 chars of 2+ words', () => {
    expect(parseRoleMatchResponse('{"roleId": "none", "name": "Solo"}', CATALOG).name).toBe(''); // one word
    expect(parseRoleMatchResponse('{"roleId": "none", "name": "a b"}', CATALOG).name).toBe('a b'); // 3 chars, 2 words = ok
    expect(parseRoleMatchResponse(`{"roleId": "none", "name": "${'x '.repeat(30)}y"}`, CATALOG).name).toBe(''); // >40
    expect(parseRoleMatchResponse('{"roleId": "none", "name": 42}', CATALOG).name).toBe(''); // non-string
  });

  it('works against the real default catalog', () => {
    const r = parseRoleMatchResponse('{"roleId": "engineering/engineering-frontend-developer", "name": "Vivid Craft"}');
    expect(r.role?.id).toBe('engineering/engineering-frontend-developer');
  });
});

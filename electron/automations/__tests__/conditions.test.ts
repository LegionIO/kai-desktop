import { describe, expect, it } from 'vitest';
import { evaluateCondition, evaluateConditions, getPath } from '../conditions.js';

describe('getPath', () => {
  it('resolves dot paths', () => {
    expect(getPath({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1);
  });
  it('resolves bracket indices', () => {
    expect(getPath({ result: [{ text: 'hi' }] }, 'result[0].text')).toBe('hi');
  });
  it('returns undefined for missing paths', () => {
    expect(getPath({ a: 1 }, 'a.b.c')).toBeUndefined();
  });
  it('empty path returns whole object', () => {
    const obj = { x: 1 };
    expect(getPath(obj, '')).toBe(obj);
  });
});

describe('evaluateCondition', () => {
  const payload = { from: { email: 'Boss@Corp.com' }, body: 'URGENT: please review', tags: ['work', 'prio'] };

  it('equals is case-insensitive by default', () => {
    expect(
      evaluateCondition({ path: 'from.email', op: 'equals', value: 'boss@corp.com', caseSensitive: false }, payload).ok,
    ).toBe(true);
  });
  it('equals respects caseSensitive', () => {
    expect(
      evaluateCondition({ path: 'from.email', op: 'equals', value: 'boss@corp.com', caseSensitive: true }, payload).ok,
    ).toBe(false);
  });
  it('notEquals inverts equals', () => {
    expect(
      evaluateCondition({ path: 'from.email', op: 'notEquals', value: 'other@x', caseSensitive: false }, payload).ok,
    ).toBe(true);
  });
  it('contains on string', () => {
    expect(evaluateCondition({ path: 'body', op: 'contains', value: 'urgent', caseSensitive: false }, payload).ok).toBe(
      true,
    );
  });
  it('contains on array', () => {
    expect(evaluateCondition({ path: 'tags', op: 'contains', value: 'prio', caseSensitive: false }, payload).ok).toBe(
      true,
    );
  });
  it('startsWith / endsWith', () => {
    expect(
      evaluateCondition({ path: 'body', op: 'startsWith', value: 'urgent', caseSensitive: false }, payload).ok,
    ).toBe(true);
    expect(
      evaluateCondition({ path: 'from.email', op: 'endsWith', value: 'corp.com', caseSensitive: false }, payload).ok,
    ).toBe(true);
  });
  it('matches regex', () => {
    expect(evaluateCondition({ path: 'body', op: 'matches', value: '^urgent', caseSensitive: false }, payload).ok).toBe(
      true,
    );
  });
  it('matches invalid regex → error, not throw', () => {
    const r = evaluateCondition({ path: 'body', op: 'matches', value: '(', caseSensitive: false }, payload);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('does not hang on a ReDoS pattern against adversarial input (timeout → false)', () => {
    // (a+)+$ against a long non-matching string catastrophically backtracks;
    // the vm timeout must bound it so the main thread never hangs.
    const adversarial = { body: 'a'.repeat(60) + '!' };
    const started = Date.now();
    const r = evaluateCondition({ path: 'body', op: 'matches', value: '(a+)+$', caseSensitive: true }, adversarial);
    const elapsed = Date.now() - started;
    expect(r.ok).toBe(false); // timed out → non-match
    expect(elapsed).toBeLessThan(2000); // bounded well under a real ReDoS hang
  });

  it('rejects an over-long regex source', () => {
    const r = evaluateCondition(
      { path: 'body', op: 'matches', value: 'a'.repeat(3000), caseSensitive: false },
      payload,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/source exceeds/i);
  });

  it('rejects an over-long test input', () => {
    const big = { body: 'x'.repeat(70 * 1024) };
    const r = evaluateCondition({ path: 'body', op: 'matches', value: 'x', caseSensitive: false }, big);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/input exceeds/i);
  });

  it('a normal regex still matches within caps', () => {
    expect(evaluateCondition({ path: 'body', op: 'matches', value: 'URGENT', caseSensitive: true }, payload).ok).toBe(
      true,
    );
  });
  it('in', () => {
    expect(
      evaluateCondition(
        { path: 'from.email', op: 'in', value: ['a@x', 'boss@corp.com'], caseSensitive: false },
        payload,
      ).ok,
    ).toBe(true);
    expect(
      evaluateCondition({ path: 'from.email', op: 'in', value: 'not-an-array', caseSensitive: false }, payload).ok,
    ).toBe(false);
  });
  it('exists', () => {
    expect(evaluateCondition({ path: 'from.email', op: 'exists', caseSensitive: false }, payload).ok).toBe(true);
    expect(evaluateCondition({ path: 'from.phone', op: 'exists', caseSensitive: false }, payload).ok).toBe(false);
  });
  it('expression truthy', () => {
    expect(
      evaluateCondition(
        {
          path: '',
          op: 'expression',
          value: 'event.from.email.toLowerCase() === "boss@corp.com"',
          caseSensitive: false,
        },
        payload,
      ).ok,
    ).toBe(true);
  });
  it('expression falsy', () => {
    expect(
      evaluateCondition({ path: '', op: 'expression', value: 'event.tags.length > 10', caseSensitive: false }, payload)
        .ok,
    ).toBe(false);
  });
  it('expression throw → false + error', () => {
    const r = evaluateCondition({ path: '', op: 'expression', value: 'nope.nope.nope', caseSensitive: false }, payload);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
  it.each([
    "this.constructor.constructor('return process')().pid > 0",
    "event.constructor.constructor('return process')().pid > 0",
    "event.nested.constructor.constructor('return process')().pid > 0",
    "event.arr.constructor.constructor('return process')().pid > 0",
    "event.arr[0].constructor.constructor('return process')().pid > 0",
  ])('expression cannot escape to process via %s', (expr) => {
    const r = evaluateCondition(
      { path: '', op: 'expression', value: expr, caseSensitive: false },
      { nested: { x: 1 }, arr: [{ y: 2 }] },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
  it('expression timeout', () => {
    const r = evaluateCondition({ path: '', op: 'expression', value: 'while(true){}', caseSensitive: false }, payload);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out|execution/i);
  });
});

describe('evaluateConditions', () => {
  const payload = { a: 1, b: 2 };
  it('empty → true', () => {
    expect(evaluateConditions([], 'all', payload).ok).toBe(true);
  });
  it('all', () => {
    expect(
      evaluateConditions(
        [
          { path: 'a', op: 'equals', value: '1', caseSensitive: false },
          { path: 'b', op: 'equals', value: '2', caseSensitive: false },
        ],
        'all',
        payload,
      ).ok,
    ).toBe(true);
    expect(
      evaluateConditions(
        [
          { path: 'a', op: 'equals', value: '1', caseSensitive: false },
          { path: 'b', op: 'equals', value: '999', caseSensitive: false },
        ],
        'all',
        payload,
      ).ok,
    ).toBe(false);
  });
  it('any', () => {
    expect(
      evaluateConditions(
        [
          { path: 'a', op: 'equals', value: '999', caseSensitive: false },
          { path: 'b', op: 'equals', value: '2', caseSensitive: false },
        ],
        'any',
        payload,
      ).ok,
    ).toBe(true);
  });
});

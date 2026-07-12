/**
 * Tests for config-manage.ts security-critical pure helpers (via __internal):
 *  - isImmutableToolField: the guardrail that stops the MODEL from editing its
 *    own shell/fileAccess sandbox via the tool_settings tool. A regression here
 *    lets the model disable its own guardrails, so the equals/ancestor/descendant
 *    matching MUST hold.
 *  - redactSecrets: keeps API keys / tokens / passwords out of config get/set
 *    responses returned to the model transcript.
 *  - setNested: prototype-pollution guard on the config write path.
 */
import { describe, it, expect } from 'vitest';
import { __internal } from '../config-manage.js';

const { isImmutableToolField, redactSecrets, setNested, getNested } = __internal;

describe('isImmutableToolField', () => {
  const LOCKED = [
    'shell.enabled',
    'shell.allowPatterns',
    'shell.denyPatterns',
    'fileAccess.enabled',
    'fileAccess.allowPaths',
    'fileAccess.denyPaths',
  ];

  it('blocks exact locked field paths', () => {
    for (const f of LOCKED) expect(isImmutableToolField(f), f).toBe(true);
  });

  it('blocks a DESCENDANT of a locked field (e.g. array index)', () => {
    expect(isImmutableToolField('shell.allowPatterns.0')).toBe(true);
    expect(isImmutableToolField('fileAccess.allowPaths.2')).toBe(true);
  });

  it('blocks an ANCESTOR / bare top-level section whose subtree is locked', () => {
    expect(isImmutableToolField('shell')).toBe(true);
    expect(isImmutableToolField('fileAccess')).toBe(true);
    // ancestor of a locked leaf (shell is ancestor of shell.enabled)
    expect(isImmutableToolField('shell.enabled')).toBe(true);
  });

  it('allows unrelated tool fields', () => {
    expect(isImmutableToolField('webFetch.enabled')).toBe(false);
    expect(isImmutableToolField('subAgents.maxDepth')).toBe(false);
    expect(isImmutableToolField('shellHelper')).toBe(false); // not "shell" nor "shell."
    expect(isImmutableToolField('fileAccessLog')).toBe(false);
  });
});

describe('redactSecrets', () => {
  it('masks secret-shaped keys at any depth', () => {
    const out = redactSecrets({
      endpoint: 'https://api.example',
      apiKey: 'sk-live-123',
      nested: { token: 'abc', password: 'pw', ok: 'visible' },
      list: [{ subscriptionKey: 'zzz' }],
    }) as Record<string, unknown>;
    expect(out.endpoint).toBe('https://api.example');
    expect(out.apiKey).toBe('[redacted]');
    const nested = out.nested as Record<string, unknown>;
    expect(nested.token).toBe('[redacted]');
    expect(nested.password).toBe('[redacted]');
    expect(nested.ok).toBe('visible');
    expect((out.list as Record<string, unknown>[])[0].subscriptionKey).toBe('[redacted]');
  });

  it('leaves non-secret scalar values intact', () => {
    expect(redactSecrets('plain string')).toBe('plain string');
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBeNull();
  });

  it('masks pathologically deep objects wholesale (depth cap)', () => {
    // build a 20-deep nested object
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    const out = JSON.stringify(redactSecrets(deep));
    expect(out).toContain('[redacted:deep]');
  });
});

describe('setNested (prototype-pollution guard)', () => {
  it('sets a nested value, creating intermediate objects', () => {
    const obj: Record<string, unknown> = {};
    setNested(obj, 'a.b.c', 42);
    expect((obj.a as Record<string, Record<string, unknown>>).b.c).toBe(42);
  });

  it('REFUSES paths containing __proto__ / constructor / prototype', () => {
    const obj: Record<string, unknown> = {};
    setNested(obj, '__proto__.polluted', 'x');
    setNested(obj, 'a.constructor.y', 'x');
    setNested(obj, 'prototype.z', 'x');
    // no pollution of Object.prototype
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).y).toBeUndefined();
    expect(({} as Record<string, unknown>).z).toBeUndefined();
  });

  it('overwrites a non-object intermediate rather than throwing', () => {
    const obj: Record<string, unknown> = { a: 'scalar' };
    setNested(obj, 'a.b', 1);
    expect((obj.a as Record<string, unknown>).b).toBe(1);
  });
});

describe('getNested', () => {
  it('reads a nested value and returns undefined for missing paths', () => {
    const obj = { a: { b: { c: 7 } } };
    expect(getNested(obj, 'a.b.c')).toBe(7);
    expect(getNested(obj, 'a.x.y')).toBeUndefined();
    expect(getNested(obj, 'nope')).toBeUndefined();
  });
});

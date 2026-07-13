/**
 * Tests for src/lib/utils.ts security/correctness primitives:
 *   - escapeHtml: the XSS-defense escaper used before innerHTML assignment. A
 *     regression (dropped entity, wrong order double-escaping &) silently weakens
 *     the sanitization at every innerHTML sink that relies on it.
 *   - generateId: the UUID generator with a v4-shaped fallback for non-secure
 *     (HTTP web-UI) contexts where crypto.randomUUID is unavailable.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { escapeHtml, generateId } from '../utils';

describe('escapeHtml', () => {
  it('escapes all five HTML-significant characters', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes & FIRST so entities are not double-escaped', () => {
    // If < were escaped before &, "&lt;" would become "&amp;lt;". Order matters.
    expect(escapeHtml('<')).toBe('&lt;'); // not &amp;lt;
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('&amp;')).toBe('&amp;amp;'); // a literal &amp; input → the & is escaped once
  });

  it('neutralizes a script-injection payload', () => {
    const payload = `<script>alert('xss')</script>`;
    const out = escapeHtml(payload);
    expect(out).not.toContain('<script>');
    expect(out).toBe('&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;');
  });

  it('neutralizes an attribute-breakout payload', () => {
    // e.g. value inserted into <img src="X"> — the quote must not close the attr.
    const out = escapeHtml('" onerror="alert(1)');
    expect(out).not.toContain('"');
    expect(out).toBe('&quot; onerror=&quot;alert(1)');
  });

  it('leaves safe text unchanged and handles empty', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
    expect(escapeHtml('')).toBe('');
  });
});

describe('generateId', () => {
  const V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses crypto.randomUUID when available', () => {
    const spy = vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
    expect(generateId()).toBe('11111111-1111-4111-8111-111111111111');
    expect(spy).toHaveBeenCalled();
  });

  it('falls back to a valid v4-shaped UUID when crypto.randomUUID is unavailable', () => {
    // Simulate a non-secure HTTP context: crypto exists but randomUUID doesn't.
    vi.stubGlobal('crypto', { getRandomValues: () => new Uint8Array(0) } as unknown as Crypto);
    for (let i = 0; i < 50; i++) {
      const id = generateId();
      expect(id, id).toMatch(V4_RE); // version nibble 4, variant nibble 8-b
    }
  });

  it('fallback ids are (practically) unique across many calls', () => {
    vi.stubGlobal('crypto', {} as unknown as Crypto); // no randomUUID
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) ids.add(generateId());
    expect(ids.size).toBe(500);
  });
});

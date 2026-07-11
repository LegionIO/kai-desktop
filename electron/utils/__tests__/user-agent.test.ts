/**
 * Tests for the brand user-agent builder (user-agent.ts). Focus: the CRLF /
 * whitespace stripping that keeps a malformed variable from injecting header
 * lines, plus template substitution, cosmetic cleanup, and the
 * withBrandUserAgent header merge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getVersion: () => '9.9.9',
    getLocale: () => 'en-US',
  },
}));

import { renderBrandUserAgentTemplate, withBrandUserAgent, getBrandUserAgent } from '../user-agent.js';

describe('renderBrandUserAgentTemplate', () => {
  it('substitutes {key} tokens from the supplied variables', () => {
    const out = renderBrandUserAgentTemplate('{productToken}/{version} ({osName})', {
      productToken: 'Kai',
      version: '1.2.3',
      osName: 'macOS',
    });
    expect(out).toBe('Kai/1.2.3 (macOS)');
  });

  it('strips CR/LF from a variable so it cannot inject a header line', () => {
    const out = renderBrandUserAgentTemplate('{productToken}/{version}', {
      productToken: 'Kai',
      // A value carrying CRLF + an injected header must collapse to spaces.
      version: '1.0\r\nX-Injected: evil',
    });
    expect(out).not.toContain('\r');
    expect(out).not.toContain('\n');
    // The injected content is flattened to a single UA token, not a new line.
    expect(out).toBe('Kai/1.0 X-Injected: evil');
  });

  it('renders an unknown token as empty and cleans up the resulting empty group', () => {
    // {missing} → '' ; the trailing " ()" is stripped by the cosmetic cleanup.
    const out = renderBrandUserAgentTemplate('{productToken} ({missing})', { productToken: 'Kai' });
    expect(out).toBe('Kai');
  });

  it('collapses runs of whitespace and trims', () => {
    const out = renderBrandUserAgentTemplate('  {a}   {b}  ', { a: 'x', b: 'y' });
    expect(out).toBe('x y');
  });

  it('removes empty bracket/paren groups and tidy separators', () => {
    const out = renderBrandUserAgentTemplate('{a}/[{missing}] ; {b}', { a: 'p', b: 'q' });
    // [] emptied + stray "; " tidied.
    expect(out).not.toContain('[]');
    expect(out).toContain('p/');
    expect(out).toContain('q');
  });
});

describe('getBrandUserAgent', () => {
  it('returns a non-empty UA string', () => {
    expect(getBrandUserAgent().length).toBeGreaterThan(0);
  });
});

describe('withBrandUserAgent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds a User-Agent header when none is present', () => {
    const headers = withBrandUserAgent({ 'Content-Type': 'application/json' });
    expect(headers['content-type']).toBe('application/json');
    expect(headers['user-agent']).toBe(getBrandUserAgent());
  });

  it('does not override a caller-supplied User-Agent', () => {
    const headers = withBrandUserAgent({ 'User-Agent': 'Custom/1.0' });
    expect(headers['user-agent']).toBe('Custom/1.0');
  });

  it('works with no headers argument', () => {
    const headers = withBrandUserAgent();
    expect(headers['user-agent']).toBe(getBrandUserAgent());
  });
});

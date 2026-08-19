import { describe, expect, it } from 'vitest';
import { boundedBrowserTitle, boundedBrowserUrl, MAX_BROWSER_TITLE_CHARS, MAX_BROWSER_URL_CHARS } from '../metadata.js';

describe('browser metadata bounds', () => {
  it('bounds remote titles and URLs while preserving ordinary values and fallbacks', () => {
    expect(boundedBrowserTitle('Example')).toBe('Example');
    expect(boundedBrowserTitle('')).toBe('New Tab');
    expect(boundedBrowserUrl('https://example.com')).toBe('https://example.com');
    expect(boundedBrowserTitle('t'.repeat(MAX_BROWSER_TITLE_CHARS + 50))).toHaveLength(MAX_BROWSER_TITLE_CHARS);
    expect(boundedBrowserUrl('u'.repeat(MAX_BROWSER_URL_CHARS + 50))).toHaveLength(MAX_BROWSER_URL_CHARS);
  });
});

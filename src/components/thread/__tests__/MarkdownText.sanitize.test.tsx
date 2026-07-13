/**
 * Component tests for MarkdownText's sanitization boundary. It renders
 * MODEL/assistant markdown output (attacker-influenceable via prompt injection
 * or a malicious tool result) to HTML through a rehype pipeline:
 *   rehypePlugins: [rehypeRaw, [rehypeSanitize, rehypeSanitizeOptions]]
 * rehypeRaw parses embedded raw HTML into the tree; rehypeSanitize MUST run
 * after it to strip dangerous nodes. This is the app's primary XSS surface, so
 * lock: <script>, on* handlers, javascript:/data: hrefs, and non-allowlisted
 * tags are stripped, while legit markdown (bold, safe links, media-protocol
 * images, task-list inputs) still renders. A regression reordering the plugins
 * or loosening the schema would fail here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MarkdownText } from '../MarkdownText';

afterEach(() => cleanup());

const html = (text: string): string => {
  const { container } = render(<MarkdownText text={text} />);
  return container.innerHTML;
};

describe('MarkdownText sanitization (model-output → HTML XSS boundary)', () => {
  it('strips a raw <script> embedded in markdown', () => {
    const out = html('hello\n\n<script>window.__pwned=1</script>\n\nworld');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('__pwned');
  });

  it('strips on* event handlers from raw HTML', () => {
    const out = html('<img src="x" onerror="window.__pwned=1">');
    expect(out.toLowerCase()).not.toContain('onerror');
    expect(out).not.toContain('__pwned');
  });

  it('strips a javascript: href on a link', () => {
    const out = html('[click](javascript:alert(1))');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  it('strips an iframe (not in the tag allowlist)', () => {
    const out = html('<iframe src="https://evil.example"></iframe>');
    expect(out.toLowerCase()).not.toContain('<iframe');
  });

  it('strips a foreignObject / svg-onload style raw HTML injection', () => {
    const out = html('<svg><script>alert(1)</script></svg>');
    expect(out).not.toContain('<script');
  });

  it('renders benign markdown (bold + a safe http link)', () => {
    const out = html('**bold** and [ok](https://example.com)');
    expect(out).toContain('<strong');
    expect(out).toContain('href="https://example.com"');
  });

  it('allows a video src on the brand media protocol but not javascript:', () => {
    const okSrc = `${__BRAND_MEDIA_PROTOCOL}://x/vid.mp4`;
    const okOut = html(`<video src="${okSrc}" controls></video>`);
    expect(okOut).toContain('<video');
    expect(okOut).toContain(okSrc);

    const badOut = html('<video src="javascript:alert(1)" controls></video>');
    expect(badOut.toLowerCase()).not.toContain('javascript:');
  });

  it('keeps allowlisted task-list input attrs but no injected handler', () => {
    const out = html('<input type="checkbox" checked onclick="window.__pwned=1">');
    expect(out.toLowerCase()).not.toContain('onclick');
    expect(out).not.toContain('__pwned');
  });
});

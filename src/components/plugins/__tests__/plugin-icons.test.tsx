/**
 * Component tests for getPluginNavigationIcon (src/components/plugins/plugin-icons.tsx).
 *
 * A plugin-supplied `{ svg }` icon is UNTRUSTED (a malicious/compromised plugin
 * ships the markup) and is rendered via dangerouslySetInnerHTML after
 * DOMPurify.sanitize. This is an XSS boundary: the sanitize config
 * (USE_PROFILES svg/svgFilters + FORBID_TAGS foreignObject) must strip <script>,
 * on* handlers, and the foreignObject HTML-namespace re-entry. A regression
 * loosening that config would silently let a plugin inject HTML/script. These
 * lock the stripping + the lucide/fallback paths.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { getPluginNavigationIcon } from '../plugin-icons';

afterEach(() => cleanup());

// Render a ReactNode and return the container so we can inspect the real DOM.
const html = (node: ReturnType<typeof getPluginNavigationIcon>): string => {
  const { container } = render(<>{node}</>);
  return container.innerHTML;
};

describe('getPluginNavigationIcon — svg sanitization', () => {
  it('renders a benign svg through', () => {
    const out = html(getPluginNavigationIcon({ svg: '<svg><circle cx="1" cy="1" r="1"/></svg>' }));
    expect(out).toContain('<svg');
    expect(out).toContain('<circle');
  });

  it('strips an embedded <script> from a plugin svg', () => {
    const out = html(getPluginNavigationIcon({ svg: '<svg><script>alert(1)</script><circle/></svg>' }));
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('strips on* event handlers (onload/onclick)', () => {
    const out = html(getPluginNavigationIcon({ svg: '<svg onload="alert(1)"><rect onclick="steal()" /></svg>' }));
    expect(out.toLowerCase()).not.toContain('onload');
    expect(out.toLowerCase()).not.toContain('onclick');
    expect(out).not.toContain('alert(1)');
  });

  it('forbids <foreignObject> (HTML-namespace re-entry → arbitrary HTML)', () => {
    const out = html(
      getPluginNavigationIcon({
        svg: '<svg><foreignObject><body><img src=x onerror="alert(1)"></body></foreignObject></svg>',
      }),
    );
    expect(out.toLowerCase()).not.toContain('foreignobject');
    expect(out.toLowerCase()).not.toContain('onerror');
  });

  it('strips a javascript: href on an svg <a>', () => {
    const out = html(getPluginNavigationIcon({ svg: '<svg><a href="javascript:alert(1)"><rect/></a></svg>' }));
    expect(out.toLowerCase()).not.toContain('javascript:');
  });
});

describe('getPluginNavigationIcon — lucide + fallback paths', () => {
  it('renders a known lucide icon (kebab → Pascal) as an <svg>', () => {
    const out = html(getPluginNavigationIcon({ lucide: 'message-circle' }));
    expect(out).toContain('<svg'); // lucide renders an svg
  });

  it('falls back to a package icon for an unknown lucide name', () => {
    const out = html(getPluginNavigationIcon({ lucide: 'definitely-not-a-real-icon-xyz' }));
    expect(out).toContain('<svg'); // PackageIcon fallback still renders an svg
  });

  it('falls back to a package icon when no icon is provided', () => {
    const out = html(getPluginNavigationIcon(undefined));
    expect(out).toContain('<svg');
  });
});

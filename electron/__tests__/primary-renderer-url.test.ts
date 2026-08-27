import { describe, expect, it } from 'vitest';
import {
  isAllowedPrimaryRendererFrameNavigation,
  isCanonicalPrimaryRendererUrl,
  primaryRendererFrameNavigationDisposition,
  resolvePrimaryRendererUrl,
} from '../primary-renderer-url.js';

describe('primary renderer URL authority', () => {
  it('resolves the production renderer to its exact index document', () => {
    expect(resolvePrimaryRendererUrl('/Applications/Kai.app/Contents/Resources/app.asar/renderer')).toBe(
      'file:///Applications/Kai.app/Contents/Resources/app.asar/renderer/index.html',
    );
  });

  it('allows only the canonical document, with optional same-document hashes', () => {
    const production = 'file:///Applications/Kai.app/Contents/Resources/app.asar/renderer/index.html';
    expect(isCanonicalPrimaryRendererUrl(production, production)).toBe(true);
    expect(isCanonicalPrimaryRendererUrl(`${production}#browser`, production)).toBe(true);
    expect(isCanonicalPrimaryRendererUrl(`${production}?plugin=1`, production)).toBe(false);
    expect(
      isCanonicalPrimaryRendererUrl(
        'file:///Applications/Kai.app/Contents/Resources/app.asar/plugins/controlled.html',
        production,
      ),
    ).toBe(false);

    const development = 'http://localhost:5173/';
    expect(isCanonicalPrimaryRendererUrl('http://localhost:5173/#browser', development)).toBe(true);
    expect(isCanonicalPrimaryRendererUrl('http://localhost:5173/@fs/tmp/controlled.html', development)).toBe(false);
    expect(isCanonicalPrimaryRendererUrl('http://127.0.0.1:5173/', development)).toBe(false);
  });

  it('allows only the required sandboxed subframe documents and PDF previews', () => {
    const renderer = 'file:///Applications/Kai.app/Contents/Resources/app.asar/renderer/index.html';
    const allowed = (candidate: string, isMainFrame = false) =>
      isAllowedPrimaryRendererFrameNavigation(candidate, renderer, isMainFrame);

    expect(allowed(renderer, true)).toBe(true);
    expect(allowed(`${renderer}#preview`, false)).toBe(true);
    expect(allowed('about:blank')).toBe(true);
    expect(allowed('about:srcdoc')).toBe(true);
    expect(allowed('about:config')).toBe(false);
    expect(allowed('about:blank#controlled')).toBe(false);
    expect(allowed('data:application/pdf;base64,JVBERi0xLjQ=')).toBe(true);
    expect(allowed('data:APPLICATION/PDF;charset=utf-8,PDF')).toBe(true);
    expect(allowed('data:application/pdf;base64,JVBERi0xLjQ=', true)).toBe(false);
    expect(allowed('data:text/html,<script>location="https://attacker.example"</script>')).toBe(false);
    expect(allowed('data:application/pdfx,not-a-pdf')).toBe(false);
    // Offloaded-PDF preview subframe: a kai-media:// *.pdf URL is allowed in a
    // subframe (equivalent to the PDF data: allowance) but never in the main frame,
    // and only for a real .pdf path with no traversal.
    expect(allowed(`${__BRAND_MEDIA_PROTOCOL}://files/0123456789abcdef.pdf`)).toBe(true);
    expect(allowed(`${__BRAND_MEDIA_PROTOCOL}://files/0123456789abcdef.pdf`, true)).toBe(false);
    expect(allowed(`${__BRAND_MEDIA_PROTOCOL}://images/x.png`)).toBe(false); // not a pdf
    expect(allowed(`${__BRAND_MEDIA_PROTOCOL}://files/../../etc/x.pdf`)).toBe(false); // traversal
    expect(allowed('https://attacker.example/')).toBe(false);
  });

  it('never forwards a blocked subframe URL to the external browser', () => {
    const renderer = 'file:///Applications/Kai.app/Contents/Resources/app.asar/renderer/index.html';

    expect(primaryRendererFrameNavigationDisposition('https://attacker.example/?secret=1', renderer, false)).toBe(
      'block',
    );
    expect(primaryRendererFrameNavigationDisposition('https://example.com/', renderer, true)).toBe('external');
    expect(primaryRendererFrameNavigationDisposition('about:srcdoc', renderer, false)).toBe('allow');
  });
});

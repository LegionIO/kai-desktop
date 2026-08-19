import { describe, expect, it } from 'vitest';
import {
  isAllowedPrimaryRendererFrameNavigation,
  isCanonicalPrimaryRendererUrl,
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
    expect(allowed('https://attacker.example/')).toBe(false);
  });
});

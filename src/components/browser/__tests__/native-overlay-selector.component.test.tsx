import { describe, expect, it, vi } from 'vitest';

// jsdom represents selectorText as an own data property, while Chromium uses
// the CSSStyleRule prototype setter. Install the Chromium-shaped seam before
// native-overlay's module-level hardening runs so this behavior stays covered.
let selector = '.before';
Object.defineProperty(CSSStyleRule.prototype, 'selectorText', {
  configurable: true,
  get: () => selector,
  set: (value: string) => {
    selector = value;
  },
});

const { collectRendererOverlayCandidates, subscribeRendererStylesheetChanges } = await import('../native-overlay');

describe('native browser selector mutation capture', () => {
  it('signals CSS selector mutations that can reveal an existing overlay', () => {
    const candidates = collectRendererOverlayCandidates(document.body);
    const onChange = vi.fn();
    const unsubscribe = subscribeRendererStylesheetChanges(candidates, document, onChange);
    const rule = Object.create(CSSStyleRule.prototype) as CSSStyleRule;

    rule.selectorText = '.after';

    expect(selector).toBe('.after');
    expect(onChange).toHaveBeenCalledOnce();
    unsubscribe();
  });
});

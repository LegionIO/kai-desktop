import { describe, expect, it } from 'vitest';
import { validatePickedElementSelector } from '../element-picker.js';
import { MAX_BROWSER_SELECTOR_CHARS } from '../input-validation.js';

describe('browser element picker', () => {
  it('rejects invalid picker results again after they cross the renderer boundary', () => {
    expect(() => validatePickedElementSelector('')).toThrow(/limited/);
    expect(() => validatePickedElementSelector('x'.repeat(MAX_BROWSER_SELECTOR_CHARS + 1))).toThrow(/limited/);
    expect(validatePickedElementSelector('#safe')).toBe('#safe');
  });
});

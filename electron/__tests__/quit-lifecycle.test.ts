import { describe, expect, it, vi } from 'vitest';
import { overrideCommittedQuitUnloadVeto } from '../quit-lifecycle.js';

describe('committed quit lifecycle', () => {
  it('respects unload vetoes until irreversible cleanup has completed', () => {
    const preventDefault = vi.fn();
    const event = { preventDefault };

    expect(overrideCommittedQuitUnloadVeto(event, false, false)).toBe(false);
    expect(overrideCommittedQuitUnloadVeto(event, true, false)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('overrides unload vetoes after cleanup so the disposed app cannot remain open', () => {
    const preventDefault = vi.fn();

    expect(overrideCommittedQuitUnloadVeto({ preventDefault }, true, true)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});

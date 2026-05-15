import { describe, expect, it } from 'vitest';
import {
  getPartialTypingStrategyForConfig,
  hasEnabledPartialTypingStrategy,
  normalizePartialTypingStrategy,
  resolveActivePartialTypingMode,
} from '../partial-typing.js';

describe('dictation partial typing strategy resolution', () => {
  it('uses KB/KX when AX is available but AX partials are disabled', () => {
    expect(resolveActivePartialTypingMode({
      partialTyping: {
        ax: 'disabled',
        kb: 'full-patch',
      },
    }, true, false)).toBe('kb');
  });

  it('uses AX when AX is available and configured', () => {
    expect(resolveActivePartialTypingMode({
      partialTyping: {
        ax: 'full-replacement',
        kb: 'full-patch',
      },
    }, true, false)).toBe('ax');
  });

  it('falls back to KB when AX is suppressed', () => {
    expect(resolveActivePartialTypingMode({
      partialTyping: {
        ax: 'full-replacement',
        kb: 'tail-only',
      },
    }, true, true)).toBe('kb');
  });

  it('keeps legacy live partials AX-only', () => {
    expect(getPartialTypingStrategyForConfig({ livePartials: true }, 'ax')).toBe('full-replacement');
    expect(getPartialTypingStrategyForConfig({ livePartials: true }, 'kb')).toBe('disabled');
  });

  it('normalizes invalid per-mode strategy values conservatively', () => {
    expect(normalizePartialTypingStrategy('ax', 'full-patch')).toBe('full-replacement');
    expect(normalizePartialTypingStrategy('kb', 'full-replacement')).toBe('ax-verified');
  });

  it('detects whether any live partial strategy is enabled', () => {
    expect(hasEnabledPartialTypingStrategy({
      partialTyping: { ax: 'disabled', kb: 'disabled' },
    })).toBe(false);
    expect(hasEnabledPartialTypingStrategy({
      partialTyping: { ax: 'disabled', kb: 'tail-only' },
    })).toBe(true);
  });
});

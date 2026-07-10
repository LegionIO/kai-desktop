import { describe, it, expect } from 'vitest';
import {
  resolveConversationTokenization,
  normalizeConversationModelName,
  MODEL_CONTEXT_WINDOWS,
} from '../tokenization';

describe('normalizeConversationModelName', () => {
  it('strips provider prefixes and -latest suffix', () => {
    expect(normalizeConversationModelName('openai/gpt-4o-latest')).toBe('gpt-4o');
    expect(normalizeConversationModelName('azure:gpt-4.1')).toBe('gpt-4.1');
  });

  it('normalizes reasoning-model variants to their base (most-specific wins)', () => {
    expect(normalizeConversationModelName('o4-mini-2025-04-16')).toBe('o4-mini');
    expect(normalizeConversationModelName('o3-mini-2025-01-31')).toBe('o3-mini');
    expect(normalizeConversationModelName('o3-2025-04-16')).toBe('o3');
  });
});

describe('resolveConversationTokenization', () => {
  it('resolves a context window for reasoning models (so compaction can trigger)', () => {
    for (const m of ['o3', 'o3-mini', 'o4-mini']) {
      const info = resolveConversationTokenization(m);
      expect(info.contextWindowTokens).toBe(MODEL_CONTEXT_WINDOWS[m]);
      expect(info.contextWindowTokens).toBeGreaterThan(0);
      // Encoding always resolves (falls back to gpt-5) so counting works.
      expect(info.encoding).not.toBeNull();
    }
  });

  it('resolves a context window for the base GPT models', () => {
    expect(resolveConversationTokenization('gpt-4o').contextWindowTokens).toBe(128000);
    expect(resolveConversationTokenization('gpt-5').contextWindowTokens).toBe(272000);
  });

  it('honors a positive finite override over the table', () => {
    expect(resolveConversationTokenization('o3', 50000).contextWindowTokens).toBe(50000);
  });

  it('ignores a non-positive/NaN override and falls back to the table', () => {
    expect(resolveConversationTokenization('o3', 0).contextWindowTokens).toBe(MODEL_CONTEXT_WINDOWS.o3);
    expect(resolveConversationTokenization('o3', Number.NaN).contextWindowTokens).toBe(MODEL_CONTEXT_WINDOWS.o3);
  });

  it('returns null context window for a wholly unknown model with no override', () => {
    expect(resolveConversationTokenization('totally-made-up-model-xyz').contextWindowTokens).toBeNull();
  });
});

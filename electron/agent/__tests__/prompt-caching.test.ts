/**
 * Tests for prompt-caching.ts — the provider-branching logic that decides which
 * requests/messages get Anthropic cache markers. A regression here is silent but
 * costly: caching disabled = higher latency/spend; a marker on the wrong provider
 * = malformed request. Pure functions, no mocking needed.
 */
import { describe, it, expect } from 'vitest';
import {
  isAnthropicFamily,
  resolvePromptCaching,
  buildAnthropicCacheControl,
  applyPromptCachingToMessages,
} from '../prompt-caching.js';
import type { LLMModelConfig } from '../model-catalog.js';

function model(overrides: Partial<LLMModelConfig> = {}): LLMModelConfig {
  return {
    provider: 'anthropic',
    modelName: 'claude-sonnet-4',
    apiKey: 'k',
    ...overrides,
  } as LLMModelConfig;
}

describe('isAnthropicFamily', () => {
  it('is true for the anthropic provider', () => {
    expect(isAnthropicFamily({ provider: 'anthropic', modelName: 'anything' })).toBe(true);
  });

  it('is true for a Claude model on Bedrock (case-insensitive, either keyword)', () => {
    expect(isAnthropicFamily({ provider: 'amazon-bedrock', modelName: 'anthropic.claude-3' })).toBe(true);
    expect(isAnthropicFamily({ provider: 'amazon-bedrock', modelName: 'CLAUDE-3-sonnet' })).toBe(true);
  });

  it('is false for a non-Claude Bedrock model', () => {
    expect(isAnthropicFamily({ provider: 'amazon-bedrock', modelName: 'amazon.titan-text' })).toBe(false);
  });

  it('is false for openai / google', () => {
    expect(isAnthropicFamily({ provider: 'openai-compatible', modelName: 'claude-sounds-anthropic' })).toBe(false);
    expect(isAnthropicFamily({ provider: 'google', modelName: 'gemini-2' })).toBe(false);
  });
});

describe('resolvePromptCaching', () => {
  it('returns an explicit override verbatim regardless of provider', () => {
    const override = { enabled: false, ttl: '1h' as const };
    expect(resolvePromptCaching(model({ promptCaching: override }))).toBe(override);
    // Even an "enabled" override on a non-anthropic provider is preserved.
    const on = { enabled: true };
    expect(resolvePromptCaching(model({ provider: 'openai-compatible', modelName: 'gpt', promptCaching: on }))).toBe(
      on,
    );
  });

  it('defaults to enabled for the anthropic family when no override', () => {
    expect(resolvePromptCaching(model())).toEqual({ enabled: true });
    expect(resolvePromptCaching(model({ provider: 'amazon-bedrock', modelName: 'anthropic.claude-3' }))).toEqual({
      enabled: true,
    });
  });

  it('defaults to disabled for non-anthropic providers when no override', () => {
    expect(resolvePromptCaching(model({ provider: 'openai-compatible', modelName: 'gpt-x' }))).toEqual({
      enabled: false,
    });
    expect(resolvePromptCaching(model({ provider: 'amazon-bedrock', modelName: 'amazon.titan' }))).toEqual({
      enabled: false,
    });
  });
});

describe('buildAnthropicCacheControl', () => {
  it('returns an ephemeral marker for anthropic-direct with caching enabled', () => {
    expect(buildAnthropicCacheControl(model())).toEqual({ type: 'ephemeral' });
  });

  it('passes the TTL through when configured', () => {
    expect(buildAnthropicCacheControl(model({ promptCaching: { enabled: true, ttl: '1h' } }))).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
  });

  it('is undefined for Bedrock even when it is a Claude model (request-level flag is anthropic-only)', () => {
    expect(
      buildAnthropicCacheControl(model({ provider: 'amazon-bedrock', modelName: 'anthropic.claude-3' })),
    ).toBeUndefined();
  });

  it('is undefined when caching is explicitly disabled', () => {
    expect(buildAnthropicCacheControl(model({ promptCaching: { enabled: false } }))).toBeUndefined();
  });
});

describe('applyPromptCachingToMessages', () => {
  const msgs = () => [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ];
  const bedrockClaude = model({ provider: 'amazon-bedrock', modelName: 'anthropic.claude-3' });

  it('returns the input unchanged for anthropic-direct (uses request-level control instead)', () => {
    const input = msgs();
    expect(applyPromptCachingToMessages(input, model())).toBe(input);
  });

  it('returns the input unchanged for openai / google', () => {
    const input = msgs();
    expect(applyPromptCachingToMessages(input, model({ provider: 'openai-compatible', modelName: 'gpt' }))).toBe(input);
    expect(applyPromptCachingToMessages(input, model({ provider: 'google', modelName: 'gemini' }))).toBe(input);
  });

  it('returns the input unchanged when caching is disabled', () => {
    const input = msgs();
    const disabled = model({
      provider: 'amazon-bedrock',
      modelName: 'anthropic.claude-3',
      promptCaching: { enabled: false },
    });
    expect(applyPromptCachingToMessages(input, disabled)).toBe(input);
  });

  it('returns the input unchanged for a non-Claude Bedrock model', () => {
    const input = msgs();
    expect(applyPromptCachingToMessages(input, model({ provider: 'amazon-bedrock', modelName: 'amazon.titan' }))).toBe(
      input,
    );
  });

  it('returns the input unchanged when fewer than 2 messages', () => {
    const one = [{ role: 'user', content: 'only' }];
    expect(applyPromptCachingToMessages(one, bedrockClaude)).toBe(one);
  });

  it('marks the last message before the trailing user turn with a bedrock cachePoint', () => {
    const input = msgs();
    const out = applyPromptCachingToMessages(input, bedrockClaude) as Array<Record<string, unknown>>;
    // markIndex walks back over the trailing user message (index 3) to the assistant at index 2.
    expect((out[2].providerOptions as Record<string, Record<string, unknown>>).bedrock.cachePoint).toEqual({
      type: 'default',
    });
    // Other messages are untouched.
    expect(out[0].providerOptions).toBeUndefined();
    expect(out[3].providerOptions).toBeUndefined();
  });

  it('does not mutate the input array or its messages', () => {
    const input = msgs();
    const snapshot = JSON.stringify(input);
    const out = applyPromptCachingToMessages(input, bedrockClaude);
    expect(out).not.toBe(input);
    expect(JSON.stringify(input)).toBe(snapshot); // input untouched
  });

  it('preserves pre-existing providerOptions when adding the cachePoint', () => {
    const input = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1', providerOptions: { bedrock: { foo: 1 }, other: { bar: 2 } } },
      { role: 'user', content: 'q2' },
    ];
    const out = applyPromptCachingToMessages(input, bedrockClaude) as Array<Record<string, unknown>>;
    const po = out[1].providerOptions as Record<string, Record<string, unknown>>;
    expect(po.bedrock).toEqual({ foo: 1, cachePoint: { type: 'default' } });
    expect(po.other).toEqual({ bar: 2 });
  });

  it('marks index 0 when every message is a user turn (loop stops at the guard)', () => {
    const allUser = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ];
    const out = applyPromptCachingToMessages(allUser, bedrockClaude) as Array<Record<string, unknown>>;
    expect((out[0].providerOptions as Record<string, Record<string, unknown>>).bedrock.cachePoint).toEqual({
      type: 'default',
    });
  });
});

import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../config/schema.js';
import type { ModelCatalogEntry } from '../../model-catalog.js';
import { resolveRuntimeForModel } from '../model-runtime-compat.js';

function makeConfig(): AppConfig {
  return {
    agent: { runtime: 'auto' },
    advanced: { temperature: 0.7, maxSteps: 25, maxRetries: 2 },
    models: {
      defaultModelKey: 'legion-qwen',
      providers: {
        legionio: {
          type: 'openai-compatible',
          endpoint: 'http://127.0.0.1:4567/v1',
          apiKey: 'legionio-daemon',
        },
        openai: {
          type: 'openai-compatible',
          endpoint: 'https://api.openai.com/v1',
          apiKey: 'test-key-not-real',
        },
      },
      catalog: [
        { key: 'legion-qwen', provider: 'legionio', modelName: 'qwen3' },
        { key: 'openai-gpt', provider: 'openai', modelName: 'gpt-4o-mini' },
      ],
    },
  } as unknown as AppConfig;
}

function makeModel(key: 'legion-qwen' | 'openai-gpt', providerKey: 'legionio' | 'openai'): ModelCatalogEntry {
  const config = makeConfig();
  const provider = config.models.providers[providerKey];
  return {
    key,
    displayName: key,
    modelConfig: {
      provider: provider.type,
      endpoint: provider.endpoint ?? '',
      apiKey: provider.apiKey ?? '',
      modelName: key === 'legion-qwen' ? 'qwen3' : 'gpt-4o-mini',
      temperature: 0.7,
      maxSteps: 25,
      maxRetries: 2,
    },
  };
}

describe('resolveRuntimeForModel — provider/runtime resolution', () => {
  it('routes openai-compatible models through Codex when available in auto mode', () => {
    const resolution = resolveRuntimeForModel(
      makeModel('openai-gpt', 'openai'),
      makeConfig(),
      'auto',
      new Set(['mastra', 'codex-sdk']),
    );

    expect(resolution.runtimeId).toBe('codex-sdk');
  });

  it('falls back to Mastra for openai-compatible models when Codex is unavailable', () => {
    const resolution = resolveRuntimeForModel(
      makeModel('openai-gpt', 'openai'),
      makeConfig(),
      'auto',
      new Set(['mastra']),
    );

    expect(resolution.runtimeId).toBe('mastra');
  });

  it('routes openai-compatible legionio model through Mastra in auto mode', () => {
    // legionio is not a built-in runtime — auto mode falls through to Mastra/Codex
    const resolution = resolveRuntimeForModel(
      makeModel('legion-qwen', 'legionio'),
      makeConfig(),
      'auto',
      new Set(['mastra']),
    );

    expect(resolution.runtimeId).toBe('mastra');
  });

  it('uses nativeProviderKey fallback when explicit runtime is unavailable but matching provider exists', () => {
    // When 'legion' is selected but not in available, and 'legionio' provider exists in config,
    // route through Mastra with providerOverride instead of hard-erroring.
    const resolution = resolveRuntimeForModel(
      makeModel('legion-qwen', 'legionio'),
      makeConfig(),
      'legion' as Parameters<typeof resolveRuntimeForModel>[2],
      new Set(['mastra']),
    );

    expect(resolution).toMatchObject({
      runtimeId: 'mastra',
      providerOverride: 'legionio',
    });
    expect(resolution.warning).toBeUndefined();
  });

  it('falls back to Mastra when explicit runtime is unavailable and no native provider key matches', () => {
    const resolution = resolveRuntimeForModel(
      makeModel('openai-gpt', 'openai'),
      makeConfig(),
      'unknown-runtime' as Parameters<typeof resolveRuntimeForModel>[2],
      new Set(['mastra']),
    );

    expect(resolution.runtimeId).toBe('mastra');
  });
});

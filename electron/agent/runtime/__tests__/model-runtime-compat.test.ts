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

describe('resolveRuntimeForModel plugin runtime ownership', () => {
  it('uses the plugin runtime for plugin-owned models in auto mode', () => {
    const resolution = resolveRuntimeForModel(
      makeModel('legion-qwen', 'legionio'),
      makeConfig(),
      'auto',
      new Set(['mastra', 'legion']),
    );

    expect(resolution).toMatchObject({
      runtimeId: 'legion',
      inferenceProviderRuntimeId: 'legion',
    });
  });

  it('keeps explicit plugin runtime ownership while overriding non-plugin models through the plugin provider', () => {
    const resolution = resolveRuntimeForModel(
      makeModel('openai-gpt', 'openai'),
      makeConfig(),
      'legion' as Parameters<typeof resolveRuntimeForModel>[2],
      new Set(['mastra', 'legion']),
    );

    expect(resolution).toMatchObject({
      runtimeId: 'legion',
      providerOverride: 'legionio',
      inferenceProviderRuntimeId: 'legion',
    });
  });

  it('keeps explicit plugin runtime ownership for models already supplied by that plugin', () => {
    const resolution = resolveRuntimeForModel(
      makeModel('legion-qwen', 'legionio'),
      makeConfig(),
      'legion' as Parameters<typeof resolveRuntimeForModel>[2],
      new Set(['mastra', 'legion']),
    );

    expect(resolution).toMatchObject({
      runtimeId: 'legion',
      inferenceProviderRuntimeId: 'legion',
    });
  });

  it('does not fall back to Mastra when an explicit plugin runtime is unavailable', () => {
    const resolution = resolveRuntimeForModel(
      makeModel('legion-qwen', 'legionio'),
      makeConfig(),
      'legion' as Parameters<typeof resolveRuntimeForModel>[2],
      new Set(['mastra']),
    );

    expect(resolution).toMatchObject({
      runtimeId: 'legion',
      inferenceProviderRuntimeId: 'legion',
    });
    expect(resolution.warning).toContain('runtime is currently unavailable');
  });
});

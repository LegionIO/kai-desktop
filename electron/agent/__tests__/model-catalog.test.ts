/**
 * Tests for the model-catalog resolution logic (electron/agent/model-catalog.ts)
 * — which model + params a thread streams with. This is the precedence chain
 * (profile → primary → fallback → param merge) where a regression silently
 * mis-selects a model. AppConfig is built minimally + cast (the functions read
 * only models/advanced/profiles/fallback/systemPrompt(s)/defaultProfileKey).
 */
import { describe, it, expect } from 'vitest';
import { resolveModelCatalog, resolveModelForThread, resolveStreamConfig } from '../model-catalog.js';
import type { AppConfig } from '../../config/schema.js';

type CatalogModel = {
  key: string;
  displayName: string;
  provider: string;
  modelName: string;
  useResponsesApi?: boolean;
};

function makeConfig(
  overrides: {
    catalog?: CatalogModel[];
    providers?: Record<string, { type: string; endpoint?: string; apiKey?: string; enabled?: boolean }>;
    defaultModelKey?: string;
    profiles?: AppConfig['profiles'];
    defaultProfileKey?: string;
    fallback?: { modelKeys: string[] };
    systemPrompt?: string;
    advanced?: { temperature: number; maxSteps: number; maxRetries: number; useResponsesApi: boolean };
  } = {},
): AppConfig {
  const catalog = overrides.catalog ?? [
    { key: 'gpt', displayName: 'GPT', provider: 'openai', modelName: 'gpt-x' },
    { key: 'claude', displayName: 'Claude', provider: 'anthropic', modelName: 'claude-x' },
  ];
  const providers = overrides.providers ?? {
    openai: { type: 'openai-compatible', endpoint: 'https://oai', apiKey: 'k1' },
    anthropic: { type: 'anthropic', endpoint: 'https://anthropic', apiKey: 'k2' },
  };
  return {
    models: {
      catalog,
      providers,
      defaultModelKey: overrides.defaultModelKey ?? 'gpt',
    },
    advanced: overrides.advanced ?? { temperature: 0.7, maxSteps: 25, maxRetries: 2, useResponsesApi: false },
    profiles: overrides.profiles,
    defaultProfileKey: overrides.defaultProfileKey,
    fallback: overrides.fallback,
    systemPrompt: overrides.systemPrompt ?? 'GLOBAL PROMPT',
    systemPrompts: {},
  } as unknown as AppConfig;
}

describe('resolveModelCatalog', () => {
  it('builds entries for enabled providers and skips disabled/missing ones', () => {
    const config = makeConfig({
      providers: {
        openai: { type: 'openai-compatible', endpoint: 'https://oai', apiKey: 'k1' },
        anthropic: { type: 'anthropic', enabled: false },
      },
    });
    const { entries, byKey } = resolveModelCatalog(config);
    expect(byKey.has('gpt')).toBe(true);
    expect(byKey.has('claude')).toBe(false); // provider disabled
    expect(entries).toHaveLength(1);
  });

  it('skips catalog models whose provider is absent from providers map', () => {
    const config = makeConfig({
      catalog: [{ key: 'ghost', displayName: 'Ghost', provider: 'nonexistent', modelName: 'x' }],
    });
    expect(resolveModelCatalog(config).entries).toEqual([]);
  });

  it('defaultEntry is the defaultModelKey entry, else the first entry, else null', () => {
    expect(resolveModelCatalog(makeConfig({ defaultModelKey: 'claude' })).defaultEntry?.key).toBe('claude');
    // Unknown default → first entry.
    expect(resolveModelCatalog(makeConfig({ defaultModelKey: 'missing' })).defaultEntry?.key).toBe('gpt');
    // Empty catalog → null.
    expect(resolveModelCatalog(makeConfig({ catalog: [] })).defaultEntry).toBeNull();
  });
});

describe('resolveModelForThread', () => {
  it('returns the thread model when present in the catalog', () => {
    expect(resolveModelForThread(makeConfig(), 'claude')?.key).toBe('claude');
  });
  it('falls back to the default entry for a null or unknown thread key', () => {
    expect(resolveModelForThread(makeConfig(), null)?.key).toBe('gpt');
    expect(resolveModelForThread(makeConfig(), 'stale-key')?.key).toBe('gpt');
  });
});

describe('resolveStreamConfig', () => {
  const baseOpts = { threadModelKey: null, threadProfileKey: null, fallbackEnabled: true } as const;

  it('synthesizes a default profile from defaultModelKey when no profile is configured', () => {
    const config = makeConfig({ defaultModelKey: 'claude', fallback: { modelKeys: ['gpt'] } });
    const resolved = resolveStreamConfig(config, { ...baseOpts })!;
    expect(resolved.primaryModel.key).toBe('claude');
    expect(resolved.profileKey).toBe('__default__');
    expect(resolved.fallbackModels.map((m) => m.key)).toEqual(['gpt']);
    expect(resolved.fallbackEnabled).toBe(true);
  });

  it('uses the configured profile primary + fallback chain', () => {
    const config = makeConfig({
      profiles: [
        { key: 'p1', name: 'P1', primaryModelKey: 'claude', fallbackModelKeys: ['gpt'] },
      ] as AppConfig['profiles'],
      defaultProfileKey: 'p1',
    });
    const resolved = resolveStreamConfig(config, { ...baseOpts })!;
    expect(resolved.primaryModel.key).toBe('claude');
    expect(resolved.fallbackModels.map((m) => m.key)).toEqual(['gpt']);
    expect(resolved.profileKey).toBe('p1');
  });

  it('dedupes repeated fallback keys (and drops the primary if listed) preserving order', () => {
    const config = makeConfig({
      profiles: [
        // 'claude' is primary AND listed in fallbacks; 'gpt' appears twice.
        { key: 'p1', name: 'P1', primaryModelKey: 'claude', fallbackModelKeys: ['gpt', 'claude', 'gpt'] },
      ] as AppConfig['profiles'],
      defaultProfileKey: 'p1',
    });
    const resolved = resolveStreamConfig(config, { ...baseOpts })!;
    expect(resolved.primaryModel.key).toBe('claude');
    // 'gpt' once (deduped), 'claude' removed (it's the primary).
    expect(resolved.fallbackModels.map((m) => m.key)).toEqual(['gpt']);
  });

  it('the __none__ sentinel skips profiles and uses defaultModelKey', () => {
    const config = makeConfig({
      defaultModelKey: 'gpt',
      profiles: [{ key: 'p1', name: 'P1', primaryModelKey: 'claude', fallbackModelKeys: [] }] as AppConfig['profiles'],
      defaultProfileKey: 'p1',
    });
    const resolved = resolveStreamConfig(config, { ...baseOpts, threadProfileKey: '__none__' })!;
    // Profile skipped → synthesized default → primary is defaultModelKey (gpt), not the profile's claude.
    expect(resolved.primaryModel.key).toBe('gpt');
    expect(resolved.profileKey).toBe('__default__');
  });

  it('an explicit thread model key overrides the profile primary', () => {
    const config = makeConfig({
      profiles: [{ key: 'p1', name: 'P1', primaryModelKey: 'claude', fallbackModelKeys: [] }] as AppConfig['profiles'],
      defaultProfileKey: 'p1',
    });
    const resolved = resolveStreamConfig(config, { ...baseOpts, threadModelKey: 'gpt' })!;
    expect(resolved.primaryModel.key).toBe('gpt');
  });

  it('excludes the RESOLVED primary from the fallback list even when the requested key was stale', () => {
    // profile.primaryModelKey is stale → primary resolves to defaultEntry (gpt);
    // gpt is also in the fallback list and must be filtered out of it.
    const config = makeConfig({
      defaultModelKey: 'gpt',
      profiles: [
        { key: 'p1', name: 'P1', primaryModelKey: 'stale', fallbackModelKeys: ['gpt', 'claude'] },
      ] as AppConfig['profiles'],
      defaultProfileKey: 'p1',
    });
    const resolved = resolveStreamConfig(config, { ...baseOpts })!;
    expect(resolved.primaryModel.key).toBe('gpt');
    expect(resolved.fallbackModels.map((m) => m.key)).toEqual(['claude']); // gpt removed
  });

  it('merges params with precedence thread override → profile → global', () => {
    const config = makeConfig({
      advanced: { temperature: 0.7, maxSteps: 25, maxRetries: 2, useResponsesApi: false },
      profiles: [
        { key: 'p1', name: 'P1', primaryModelKey: 'gpt', fallbackModelKeys: [], temperature: 0.3, maxSteps: 10 },
      ] as AppConfig['profiles'],
      defaultProfileKey: 'p1',
    });
    // Thread overrides temperature; profile supplies maxSteps; maxRetries falls to global.
    const resolved = resolveStreamConfig(config, {
      ...baseOpts,
      threadOverrides: { temperature: 0.1 },
    })!;
    expect(resolved.temperature).toBe(0.1); // thread wins
    expect(resolved.maxSteps).toBe(10); // profile
    expect(resolved.maxRetries).toBe(2); // global
    // The override is applied to the model config too.
    expect(resolved.primaryModel.modelConfig.temperature).toBe(0.1);
  });

  it('systemPrompt precedence: thread override → profile → global', () => {
    const config = makeConfig({
      systemPrompt: 'GLOBAL',
      profiles: [
        { key: 'p1', name: 'P1', primaryModelKey: 'gpt', fallbackModelKeys: [], systemPrompt: 'PROFILE' },
      ] as AppConfig['profiles'],
      defaultProfileKey: 'p1',
    });
    expect(resolveStreamConfig(config, { ...baseOpts })!.systemPrompt).toBe('PROFILE');
    expect(
      resolveStreamConfig(config, { ...baseOpts, threadOverrides: { systemPromptOverride: 'THREAD' } })!.systemPrompt,
    ).toBe('THREAD');
  });

  it('returns null when no primary model can be resolved (empty catalog)', () => {
    expect(resolveStreamConfig(makeConfig({ catalog: [] }), { ...baseOpts })).toBeNull();
  });

  it('fallbackEnabled is false when the chain resolves empty even if requested true', () => {
    const config = makeConfig({
      profiles: [{ key: 'p1', name: 'P1', primaryModelKey: 'gpt', fallbackModelKeys: [] }] as AppConfig['profiles'],
      defaultProfileKey: 'p1',
    });
    expect(resolveStreamConfig(config, { ...baseOpts, fallbackEnabled: true })!.fallbackEnabled).toBe(false);
  });
});

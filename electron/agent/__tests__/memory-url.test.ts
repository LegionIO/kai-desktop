/**
 * Tests for the endpoint URL normalizers in agent/memory.ts. A user pastes an
 * Azure/OpenAI endpoint; these normalize it so the embedding provider hits the
 * right host with the `/openai` path Azure requires. A bug points embeddings at
 * the wrong URL or breaks a valid config. Pure functions; the heavier
 * getSharedMemory (Mastra/LibSQL construction) is out of scope.
 */
import { describe, it, expect } from 'vitest';
import { normalizeOpenAIBaseUrl, normalizeAzureBaseUrl, memoryFingerprint } from '../memory.js';
import type { AppConfig } from '../../config/schema.js';

describe('normalizeAzureBaseUrl', () => {
  it('appends /openai to a bare Azure endpoint', () => {
    expect(normalizeAzureBaseUrl('https://foo.cognitiveservices.azure.com')).toBe(
      'https://foo.cognitiveservices.azure.com/openai',
    );
  });

  it('strips a trailing slash before appending /openai', () => {
    expect(normalizeAzureBaseUrl('https://foo.cognitiveservices.azure.com/')).toBe(
      'https://foo.cognitiveservices.azure.com/openai',
    );
  });

  it('is idempotent when the path already ends with /openai', () => {
    expect(normalizeAzureBaseUrl('https://foo.openai.azure.com/openai')).toBe('https://foo.openai.azure.com/openai');
    expect(normalizeAzureBaseUrl('https://foo.openai.azure.com/openai/')).toBe('https://foo.openai.azure.com/openai');
  });

  it('returns undefined for empty / whitespace input', () => {
    expect(normalizeAzureBaseUrl('')).toBeUndefined();
    expect(normalizeAzureBaseUrl('   ')).toBeUndefined();
  });

  it('returns undefined for an unparseable URL', () => {
    expect(normalizeAzureBaseUrl('not a url')).toBeUndefined();
    expect(normalizeAzureBaseUrl('://missing-scheme')).toBeUndefined();
  });

  it('preserves the user host (dot-segments normalized by URL, no host swap)', () => {
    const out = normalizeAzureBaseUrl('https://good.azure.com/a/../b');
    expect(out).toBeDefined();
    expect(new URL(out!).host).toBe('good.azure.com');
  });
});

describe('normalizeOpenAIBaseUrl', () => {
  it('returns undefined for an absent / empty endpoint', () => {
    expect(normalizeOpenAIBaseUrl(undefined)).toBeUndefined();
    expect(normalizeOpenAIBaseUrl('')).toBeUndefined();
    expect(normalizeOpenAIBaseUrl('   ')).toBeUndefined();
  });

  it('appends /openai and strips trailing slashes', () => {
    expect(normalizeOpenAIBaseUrl('https://x.azure.com')).toBe('https://x.azure.com/openai');
    expect(normalizeOpenAIBaseUrl('https://x.azure.com/')).toBe('https://x.azure.com/openai');
  });

  it('is idempotent for an endpoint already ending in /openai', () => {
    expect(normalizeOpenAIBaseUrl('https://x.azure.com/openai')).toBe('https://x.azure.com/openai');
    expect(normalizeOpenAIBaseUrl('https://x.azure.com/openai/')).toBe('https://x.azure.com/openai');
  });

  it('returns undefined for an unparseable URL', () => {
    expect(normalizeOpenAIBaseUrl('http://')).toBeUndefined();
    expect(normalizeOpenAIBaseUrl('garbage')).toBeUndefined();
  });

  it('keeps the host stable across normalization', () => {
    const out = normalizeOpenAIBaseUrl('https://host.example.com/base');
    expect(out).toBe('https://host.example.com/base/openai');
    expect(new URL(out!).host).toBe('host.example.com');
  });
});

describe('memoryFingerprint (cache-invalidation key)', () => {
  const makeCfg = (over: { enabled?: boolean; apiKey?: string; endpoint?: string } = {}) =>
    ({
      memory: {
        enabled: over.enabled ?? true,
        lastMessages: 20,
        workingMemory: { enabled: false, scope: 'thread' },
        observationalMemory: { enabled: false, scope: 'thread' },
        semanticRecall: { enabled: false, topK: 3, scope: 'thread' },
      },
      models: {
        providers: {
          azure_primary: {
            endpoint: over.endpoint ?? 'https://a.example.com',
            apiKey: over.apiKey ?? 'k1',
            apiVersion: '2024',
          },
        },
      },
    }) as unknown as AppConfig;

  it('is stable for the same config + dbPath', () => {
    expect(memoryFingerprint(makeCfg(), '/tmp/db')).toBe(memoryFingerprint(makeCfg(), '/tmp/db'));
  });

  it('changes when dbPath changes', () => {
    expect(memoryFingerprint(makeCfg(), '/tmp/a')).not.toBe(memoryFingerprint(makeCfg(), '/tmp/b'));
  });

  it('changes when a memory setting toggles', () => {
    expect(memoryFingerprint(makeCfg({ enabled: false }), '/tmp/db')).not.toBe(memoryFingerprint(makeCfg(), '/tmp/db'));
  });

  it('changes when the embedding provider key/endpoint changes', () => {
    expect(memoryFingerprint(makeCfg({ apiKey: 'k2' }), '/tmp/db')).not.toBe(memoryFingerprint(makeCfg(), '/tmp/db'));
    expect(memoryFingerprint(makeCfg({ endpoint: 'https://b.example.com' }), '/tmp/db')).not.toBe(
      memoryFingerprint(makeCfg(), '/tmp/db'),
    );
  });
});

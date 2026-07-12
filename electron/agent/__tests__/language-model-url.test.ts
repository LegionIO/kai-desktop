/**
 * Tests for language-model.ts pure URL/routing helpers. These decide which API
 * shape + endpoint a model request uses, so a wrong decision can misroute a
 * request (and its API key) to the wrong provider. normalizeOpenAIBaseUrl in
 * particular must THROW on an unparseable endpoint rather than silently falling
 * back to the default OpenAI host.
 */
import { describe, it, expect } from 'vitest';
import { shouldUseOpenAIResponsesApi } from '../language-model.js';
import { __internal } from '../language-model.js';

const { stripTrailingSlashes, isAzureOpenAIHost, hasOpenAIV1Path, normalizeOpenAIBaseUrl, isResponsesEndpoint } =
  __internal;

describe('shouldUseOpenAIResponsesApi', () => {
  it('is true only for openai-compatible with useResponsesApi===true', () => {
    expect(shouldUseOpenAIResponsesApi({ provider: 'openai-compatible', useResponsesApi: true })).toBe(true);
  });
  it('is false when useResponsesApi is not exactly true', () => {
    expect(shouldUseOpenAIResponsesApi({ provider: 'openai-compatible', useResponsesApi: false })).toBe(false);
    expect(shouldUseOpenAIResponsesApi({ provider: 'openai-compatible', useResponsesApi: undefined })).toBe(false);
  });
  it('is false for any non-openai-compatible provider even with the flag', () => {
    expect(shouldUseOpenAIResponsesApi({ provider: 'anthropic', useResponsesApi: true } as never)).toBe(false);
  });
});

describe('stripTrailingSlashes', () => {
  it('removes trailing slashes and leaves other strings intact', () => {
    expect(stripTrailingSlashes('https://x/y///')).toBe('https://x/y');
    expect(stripTrailingSlashes('https://x/y')).toBe('https://x/y');
    expect(stripTrailingSlashes('/')).toBe('');
    expect(stripTrailingSlashes('')).toBe('');
  });
});

describe('isAzureOpenAIHost', () => {
  it('matches the apex + any subdomain, case-insensitively', () => {
    expect(isAzureOpenAIHost('openai.azure.com')).toBe(true);
    expect(isAzureOpenAIHost('myres.openai.azure.com')).toBe(true);
    expect(isAzureOpenAIHost('MyRes.OpenAI.Azure.Com')).toBe(true);
  });
  it('does NOT match a look-alike suffix-bypass host', () => {
    expect(isAzureOpenAIHost('openai.azure.com.evil.com')).toBe(false);
    // ends with .azure.com but NOT .openai.azure.com (no ".openai" segment boundary)
    expect(isAzureOpenAIHost('notopenai.azure.com')).toBe(false);
    expect(isAzureOpenAIHost('evil.com')).toBe(false);
  });
});

describe('hasOpenAIV1Path', () => {
  it('recognizes the /openai/v1 base path (exact or prefix), case-insensitively', () => {
    expect(hasOpenAIV1Path('/openai/v1')).toBe(true);
    expect(hasOpenAIV1Path('/openai/v1/')).toBe(true);
    expect(hasOpenAIV1Path('/openai/v1/chat/completions')).toBe(true);
    expect(hasOpenAIV1Path('/OpenAI/V1')).toBe(true);
  });
  it('rejects unrelated paths', () => {
    expect(hasOpenAIV1Path('/v1')).toBe(false);
    expect(hasOpenAIV1Path('/openai/v2')).toBe(false);
    expect(hasOpenAIV1Path('/')).toBe(false);
  });
});

describe('normalizeOpenAIBaseUrl', () => {
  it('returns undefined for empty/whitespace endpoints', () => {
    expect(normalizeOpenAIBaseUrl(undefined)).toBeUndefined();
    expect(normalizeOpenAIBaseUrl('')).toBeUndefined();
    expect(normalizeOpenAIBaseUrl('   ')).toBeUndefined();
  });
  it('THROWS on a non-empty but unparseable endpoint (no silent default-host fallback)', () => {
    expect(() => normalizeOpenAIBaseUrl('not a url')).toThrow(/invalid provider endpoint/i);
    expect(() => normalizeOpenAIBaseUrl('http://')).toThrow(/invalid provider endpoint/i);
  });
  it('passes a non-Azure custom endpoint through (trailing slash stripped)', () => {
    expect(normalizeOpenAIBaseUrl('https://api.custom.example/v1/')).toBe('https://api.custom.example/v1');
  });
  it('leaves an endpoint that already has an /openai/v1 path unchanged', () => {
    expect(normalizeOpenAIBaseUrl('https://x.openai.azure.com/openai/v1')).toBe('https://x.openai.azure.com/openai/v1');
  });
  it('appends /openai/v1 for a bare Azure host', () => {
    expect(normalizeOpenAIBaseUrl('https://myres.openai.azure.com')).toBe('https://myres.openai.azure.com/openai/v1');
  });
});

describe('isResponsesEndpoint', () => {
  it('matches a URL whose path ends in /responses', () => {
    expect(isResponsesEndpoint('https://api.example/v1/responses')).toBe(true);
    expect(isResponsesEndpoint('https://api.example/v1/responses/')).toBe(true);
  });
  it('ignores the query string (a ?api-version= must not defeat the suffix check)', () => {
    expect(isResponsesEndpoint('https://api.example/v1/responses?api-version=2024-01')).toBe(true);
  });
  it('rejects non-responses endpoints', () => {
    expect(isResponsesEndpoint('https://api.example/v1/chat/completions')).toBe(false);
    expect(isResponsesEndpoint('https://api.example/responses-extra')).toBe(false);
  });
});

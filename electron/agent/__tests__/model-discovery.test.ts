import { describe, it, expect } from 'vitest';
import {
  buildListUrl,
  parseModelList,
  buildDiscoveryRequest,
  endpointIsExplicitlyLocal,
} from '../model-discovery';

describe('endpointIsExplicitlyLocal', () => {
  it('accepts loopback and private IP literals (local inference servers)', () => {
    expect(endpointIsExplicitlyLocal('http://127.0.0.1:4567/v1')).toBe(true);
    expect(endpointIsExplicitlyLocal('http://localhost:11434')).toBe(true);
    expect(endpointIsExplicitlyLocal('http://192.168.1.50:8000/v1')).toBe(true);
    expect(endpointIsExplicitlyLocal('http://10.0.0.7/v1')).toBe(true);
    expect(endpointIsExplicitlyLocal('http://[::1]:8080')).toBe(true);
  });

  it('rejects public endpoints so the SSRF guard stays fully on for them', () => {
    expect(endpointIsExplicitlyLocal('https://api.openai.com/v1')).toBe(false);
    expect(endpointIsExplicitlyLocal('https://llm-gateway.example.com')).toBe(false);
    expect(endpointIsExplicitlyLocal('https://api.anthropic.com')).toBe(false);
  });

  it('does NOT relax for a public hostname that merely resolves to loopback', () => {
    // Rebinding names like 127.0.0.1.nip.io must keep the guard on — we only trust
    // an explicit IP literal / localhost, never a resolvable name.
    expect(endpointIsExplicitlyLocal('http://127.0.0.1.nip.io')).toBe(false);
  });

  it('is false for unparseable input rather than throwing', () => {
    expect(endpointIsExplicitlyLocal('not a url')).toBe(false);
    expect(endpointIsExplicitlyLocal('')).toBe(false);
  });
});

describe('buildListUrl', () => {
  it('joins a bare base with the list path', () => {
    expect(buildListUrl('https://api.openai.com', 'v1/models')).toBe('https://api.openai.com/v1/models');
  });

  it('tolerates a trailing slash', () => {
    expect(buildListUrl('https://api.openai.com/', 'v1/models')).toBe('https://api.openai.com/v1/models');
  });

  it('does not duplicate a version segment already present on the base', () => {
    // Pasting ".../v1" as the endpoint is extremely common; naive joining would
    // produce /v1/v1/models and 404.
    expect(buildListUrl('https://api.openai.com/v1', 'v1/models')).toBe('https://api.openai.com/v1/models');
    expect(buildListUrl('https://api.openai.com/v1/', 'v1/models')).toBe('https://api.openai.com/v1/models');
  });

  it('keeps a non-matching path segment intact', () => {
    expect(buildListUrl('https://gw.corp/openai', 'v1/models')).toBe('https://gw.corp/openai/v1/models');
  });

  it('handles the google v1beta path', () => {
    expect(buildListUrl('https://generativelanguage.googleapis.com/v1beta', 'v1beta/models')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models',
    );
  });
});

describe('parseModelList', () => {
  it('parses the OpenAI/Anthropic/xAI { data: [...] } shape', () => {
    const models = parseModelList({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] });
    expect(models.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('parses the Google { models: [...] } shape and strips the models/ prefix', () => {
    const models = parseModelList({
      models: [{ name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', inputTokenLimit: 1048576 }],
    });
    expect(models).toEqual([{ id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', maxInputTokens: 1048576 }]);
  });

  it('picks up a context window when the provider reports one', () => {
    const models = parseModelList({ data: [{ id: 'm', context_length: 200000 }] });
    expect(models[0].maxInputTokens).toBe(200000);
  });

  it('ignores a non-positive or non-numeric context window', () => {
    expect(parseModelList({ data: [{ id: 'a', context_length: 0 }] })[0].maxInputTokens).toBeUndefined();
    expect(parseModelList({ data: [{ id: 'b', context_length: 'huge' }] })[0].maxInputTokens).toBeUndefined();
  });

  it('dedupes repeated ids', () => {
    const models = parseModelList({ data: [{ id: 'dup' }, { id: 'dup' }] });
    expect(models).toHaveLength(1);
  });

  it('drops entries with no usable id', () => {
    const models = parseModelList({ data: [{ id: 'ok' }, { id: 42 }, {}, null] });
    expect(models.map((m) => m.id)).toEqual(['ok']);
  });

  it('returns empty for unrecognized shapes rather than throwing', () => {
    expect(parseModelList({ unexpected: true })).toEqual([]);
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList('nope')).toEqual([]);
  });
});

describe('buildDiscoveryRequest', () => {
  it('returns null for bedrock (SigV4 control plane, not a bearer list endpoint)', () => {
    expect(buildDiscoveryRequest({ type: 'amazon-bedrock' })).toBeNull();
  });

  it('sends the anthropic api-key and version headers', () => {
    const req = buildDiscoveryRequest({ type: 'anthropic', apiKey: 'sk-ant' });
    expect(req).toMatchObject({
      url: 'https://api.anthropic.com/v1/models',
      headers: { 'x-api-key': 'sk-ant', 'anthropic-version': '2023-06-01' },
    });
  });

  it('puts the google key in the query string, not a header', () => {
    const req = buildDiscoveryRequest({ type: 'google', apiKey: 'g-key' }) as { url: string; headers: object };
    expect(req.url).toContain('key=g-key');
    expect(JSON.stringify(req.headers)).not.toContain('g-key');
  });

  it('uses a bearer token for openai-compatible providers', () => {
    const req = buildDiscoveryRequest({
      type: 'openai-compatible',
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'sk-1',
    }) as { url: string; headers: Record<string, string> };
    expect(req.url).toBe('https://api.openai.com/v1/models');
    expect(req.headers.authorization).toBe('Bearer sk-1');
  });

  it('appends api-version for azure-style gateways', () => {
    const req = buildDiscoveryRequest({
      type: 'openai-compatible',
      endpoint: 'https://x.azure.com',
      apiKey: 'k',
      apiVersion: '2024-10-21',
    }) as { url: string };
    expect(req.url).toContain('api-version=2024-10-21');
  });

  it('allows a keyless openai-compatible provider (e.g. local ollama)', () => {
    const req = buildDiscoveryRequest({ type: 'openai-compatible', endpoint: 'http://localhost:11434' }) as {
      url: string;
      headers: Record<string, string>;
    };
    expect(req.url).toBe('http://localhost:11434/v1/models');
    expect(req.headers.authorization).toBeUndefined();
  });

  it('errors (not throws) when an endpoint is missing', () => {
    expect(buildDiscoveryRequest({ type: 'openai-compatible' })).toEqual({
      error: 'No endpoint configured for this provider.',
    });
  });

  it('requires a key for providers that mandate one', () => {
    expect(buildDiscoveryRequest({ type: 'anthropic' })).toMatchObject({ error: expect.stringContaining('API key') });
    expect(buildDiscoveryRequest({ type: 'google' })).toMatchObject({ error: expect.stringContaining('API key') });
  });
});

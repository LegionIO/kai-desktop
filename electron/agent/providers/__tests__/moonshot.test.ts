import { describe, it, expect, vi } from 'vitest';
import { isMoonshotModel, sanitizeMoonshotSchema, createMoonshotCompatFetch } from '../moonshot.js';

describe('isMoonshotModel', () => {
  it('matches the Moonshot API host regardless of the model name', () => {
    expect(
      isMoonshotModel({ provider: 'openai-compatible', endpoint: 'https://api.moonshot.ai/v1/', modelName: 'x' }),
    ).toBe(true);
    expect(
      isMoonshotModel({ provider: 'openai-compatible', endpoint: 'https://api.moonshot.cn/v1', modelName: 'x' }),
    ).toBe(true);
  });

  it('matches a kimi-* model name on a non-Moonshot endpoint (e.g. a gateway)', () => {
    expect(
      isMoonshotModel({ provider: 'openai-compatible', endpoint: 'https://my-gateway.example', modelName: 'kimi-k3' }),
    ).toBe(true);
  });

  it('does not match unrelated openai-compatible models', () => {
    expect(
      isMoonshotModel({ provider: 'openai-compatible', endpoint: 'https://api.openai.com/v1', modelName: 'gpt-4o' }),
    ).toBe(false);
  });

  it('does not match non-openai-compatible providers even with a moonshot-looking endpoint', () => {
    expect(isMoonshotModel({ provider: 'anthropic', endpoint: 'https://api.moonshot.ai/v1', modelName: 'x' })).toBe(
      false,
    );
  });
});

describe('sanitizeMoonshotSchema', () => {
  it('strips a constraint keyword duplicated on the parent alongside anyOf', () => {
    const schema = {
      type: 'object',
      properties: {
        id: {
          pattern: '^[a-z]+$',
          anyOf: [{ type: 'string', pattern: '^[a-z]+$' }, { type: 'number' }],
        },
      },
    };
    const sanitized = sanitizeMoonshotSchema(schema) as typeof schema;
    expect(sanitized.properties.id).not.toHaveProperty('pattern');
    // Branch-level constraints are preserved.
    expect((sanitized.properties.id.anyOf[0] as { pattern?: string }).pattern).toBe('^[a-z]+$');
  });

  it('leaves schemas without anyOf/oneOf untouched', () => {
    const schema = { type: 'string', pattern: '^[a-z]+$', description: 'an id' };
    expect(sanitizeMoonshotSchema(schema)).toEqual(schema);
  });

  it('recurses into nested properties, items, and definitions', () => {
    const schema = {
      type: 'object',
      properties: {
        list: {
          type: 'array',
          items: { minLength: 1, oneOf: [{ type: 'string', minLength: 1 }] },
        },
      },
      $defs: {
        Thing: { minimum: 0, anyOf: [{ type: 'number', minimum: 0 }] },
      },
    };
    const sanitized = sanitizeMoonshotSchema(schema) as {
      properties: { list: { items: Record<string, unknown> } };
      $defs: { Thing: Record<string, unknown> };
    };
    expect(sanitized.properties.list.items).not.toHaveProperty('minLength');
    expect(sanitized.$defs.Thing).not.toHaveProperty('minimum');
  });
});

describe('createMoonshotCompatFetch', () => {
  function jsonInit(body: Record<string, unknown>): RequestInit {
    return { method: 'POST', body: JSON.stringify(body) };
  }

  it('sanitizes tool schemas and passes the patched body to the inner fetch', async () => {
    const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
    const compat = createMoonshotCompatFetch(inner as unknown as typeof fetch);

    await compat('https://api.moonshot.ai/v1/chat/completions', {
      ...jsonInit({
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              parameters: {
                type: 'object',
                properties: { id: { pattern: '^x$', anyOf: [{ type: 'string', pattern: '^x$' }] } },
              },
            },
          },
        ],
      }),
    });

    expect(inner).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse((inner.mock.calls[0]![1] as RequestInit).body as string);
    expect(sentBody.tools[0].function.parameters.properties.id).not.toHaveProperty('pattern');
  });

  it('drops a non-1 temperature but leaves temperature=1 untouched', async () => {
    const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
    const compat = createMoonshotCompatFetch(inner as unknown as typeof fetch);

    await compat('https://api.moonshot.ai/v1/chat/completions', jsonInit({ temperature: 0.3, model: 'kimi-k3' }));
    let sentBody = JSON.parse((inner.mock.calls[0]![1] as RequestInit).body as string);
    expect(sentBody).not.toHaveProperty('temperature');

    inner.mockClear();
    await compat('https://api.moonshot.ai/v1/chat/completions', jsonInit({ temperature: 1, model: 'kimi-k3' }));
    // Untouched body → wrapper passes init straight through (no re-stringify).
    expect(inner).toHaveBeenCalledWith(
      'https://api.moonshot.ai/v1/chat/completions',
      jsonInit({ temperature: 1, model: 'kimi-k3' }),
    );
    sentBody = JSON.parse((inner.mock.calls[0]![1] as RequestInit).body as string);
    expect(sentBody.temperature).toBe(1);
  });

  it('passes non-JSON bodies through unchanged', async () => {
    const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
    const compat = createMoonshotCompatFetch(inner as unknown as typeof fetch);
    const init: RequestInit = { method: 'POST', body: 'not-json' };
    await compat('https://api.moonshot.ai/v1/chat/completions', init);
    expect(inner).toHaveBeenCalledWith('https://api.moonshot.ai/v1/chat/completions', init);
  });
});

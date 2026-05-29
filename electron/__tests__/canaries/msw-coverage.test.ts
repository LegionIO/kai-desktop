/**
 * Provider URL coverage canaries.
 *
 * These five tests exist to fail loudly if the msw handler patterns drift
 * away from the real SDK URLs. Each one registers the per-provider handler
 * bundle, triggers a fetch against the canonical URL pattern (with a fake
 * API key so any leak to the real provider would fail-closed), and asserts
 * via the L1 watchdog (`httpMock.expectHit`) that the mock claimed it.
 *
 * msw is installed locally inside this suite (not globally — see the
 * comment in `vitest.setup.ts` for the reasoning).
 *
 * If a canary breaks:
 *   • Check whether the SDK URL changed (real upstream API change) – update
 *     the corresponding `mockX` builder in `electron/__tests__/setup/msw.ts`.
 *   • Check whether the fixture file moved – update the default fixture name
 *     in the builder.
 *   • If both look right, the fetch under test is hitting a different URL
 *     than the handler expects – instrument the call site and reconcile.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';

import { httpMock } from '../../../vitest.setup.js';
import { mockAnthropic, mockOpenAI, mockBedrock, mockAzure, mockCodex } from '../setup/msw.js';

beforeAll(() => {
  httpMock.server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  httpMock.server.resetHandlers();
  httpMock.reset();
});

afterAll(() => {
  httpMock.server.close();
});

const FAKE_KEY = 'test-key-not-real';

describe('msw coverage canaries', () => {
  it('intercepts Anthropic /v1/messages via the real @ai-sdk/anthropic provider', async () => {
    // Use the real SDK so handler URL drift is caught at the SDK level too,
    // not just at the raw fetch boundary. If a future SDK release changes
    // its URL or auth-header shape, this canary will flag it.
    httpMock.use(...mockAnthropic());
    const anthropic = createAnthropic({ apiKey: FAKE_KEY, baseURL: 'https://api.anthropic.com' });
    const model = anthropic('claude-3-5-sonnet-20241022');

    const res = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Say hi.' }] }],
    });

    expect(res).toBeDefined();
    httpMock.expectHit('api.anthropic.com');
    httpMock.expectNoUnhandled();
  });

  it('intercepts OpenAI /v1/chat/completions', async () => {
    httpMock.use(...mockOpenAI());
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${FAKE_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Say hi.' }],
      }),
    });
    expect(res.status).toBe(200);
    httpMock.expectHit('api.openai.com');
    httpMock.expectNoUnhandled();
  });

  it('intercepts Bedrock /model/{id}/invoke', async () => {
    httpMock.use(...mockBedrock());
    const modelId = encodeURIComponent('anthropic.claude-3-5-sonnet-20241022-v2:0');
    const url = `https://bedrock-runtime.us-east-1.amazonaws.com/model/${modelId}/invoke`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `AWS4-HMAC-SHA256 ${FAKE_KEY}`,
      },
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say hi.' }],
      }),
    });
    expect(res.status).toBe(200);
    httpMock.expectHit('bedrock-runtime');
    httpMock.expectNoUnhandled();
  });

  it('intercepts Azure OpenAI deployments chat/completions', async () => {
    httpMock.use(...mockAzure());
    const url =
      'https://kai-test.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-02-15-preview';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-key': FAKE_KEY },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Say hi.' }],
      }),
    });
    expect(res.status).toBe(200);
    httpMock.expectHit('openai.azure.com');
    httpMock.expectNoUnhandled();
  });

  it('intercepts Codex /v1/responses with streaming', async () => {
    httpMock.use(...mockCodex());
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${FAKE_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        input: 'Say hi.',
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    // Drain the SSE stream so msw fully accounts for the request.
    const reader = res.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
    httpMock.expectHit('api.openai.com/v1/responses');
    httpMock.expectNoUnhandled();
  });
});

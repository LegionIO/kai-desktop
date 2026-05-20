/**
 * Tests for the language-model factory.
 *
 * Exercises the real `createLanguageModelFromConfig()` (Anthropic / OpenAI /
 * Bedrock / Azure providers via @ai-sdk/*) by mocking at the HTTP egress
 * boundary with msw. Each test installs the per-provider handler bundle,
 * runs a `model.doGenerate()` call, and asserts on the shape of the result.
 *
 * msw is installed locally inside this suite per the project's "opt-in"
 * pattern documented in vitest.setup.ts.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { httpMock } from '../../../vitest.setup.js';
import { mockAnthropic, mockOpenAI, mockAzure, mockBedrock } from '../../__tests__/setup/msw.js';

// Stub the electron module — only `app.getVersion()` is read at module load by
// the brand-user-agent helper. In test mode there is no Electron runtime, so
// returning a static version keeps the SDK construction path happy.
vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0-test',
    getPath: () => '/tmp',
  },
}));

const { createLanguageModelFromConfig } = await import('../language-model.js');
import type { LLMModelConfig } from '../model-catalog.js';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function anthropicConfig(): LLMModelConfig {
  return {
    provider: 'anthropic',
    endpoint: 'https://api.anthropic.com',
    apiKey: 'test-key-not-real',
    modelName: 'claude-3-5-sonnet-20241022',
    temperature: 0.7,
    maxSteps: 25,
    maxRetries: 1,
  };
}

function openaiConfig(): LLMModelConfig {
  return {
    provider: 'openai-compatible',
    endpoint: 'https://api.openai.com',
    apiKey: 'test-key-not-real',
    modelName: 'gpt-4o-mini',
    temperature: 0.7,
    maxSteps: 25,
    maxRetries: 1,
  };
}

function azureConfig(): LLMModelConfig {
  return {
    provider: 'openai-compatible',
    endpoint: 'https://kai-test.openai.azure.com',
    apiKey: 'test-key-not-real',
    modelName: 'gpt-4o-mini',
    deploymentName: 'gpt-4o-mini',
    apiVersion: '2024-02-15-preview',
    temperature: 0.7,
    maxSteps: 25,
    maxRetries: 1,
  };
}

function bedrockConfig(): LLMModelConfig {
  return {
    provider: 'amazon-bedrock',
    endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    apiKey: 'unused-aws-uses-credential-chain',
    region: 'us-east-1',
    accessKeyId: 'AKIA-TEST-NOT-REAL',
    secretAccessKey: 'test-secret-not-real',
    modelName: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    temperature: 0.7,
    maxSteps: 25,
    maxRetries: 1,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createLanguageModelFromConfig — HTTP integration', () => {
  describe('Anthropic', () => {
    it('routes a doGenerate() call to /v1/messages and parses the response', async () => {
      httpMock.use(...mockAnthropic());
      const model = await createLanguageModelFromConfig(anthropicConfig());

      // The AI SDK v5 LanguageModelV2 surface uses doGenerate.
      const res = await (model as unknown as { doGenerate: (opts: unknown) => Promise<unknown> }).doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Say hi.' }] }],
        // Required by LanguageModelV2 — pick any non-streaming generation mode.
      });

      expect(res).toBeDefined();
      httpMock.expectHit('api.anthropic.com');
      httpMock.expectNoUnhandled();
    });
  });

  describe('OpenAI', () => {
    it('routes a doGenerate() call to /v1/chat/completions and parses the response', async () => {
      httpMock.use(...mockOpenAI());
      const model = await createLanguageModelFromConfig(openaiConfig());

      const res = await (model as unknown as { doGenerate: (opts: unknown) => Promise<unknown> }).doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Say hi.' }] }],
      });

      expect(res).toBeDefined();
      httpMock.expectHit('api.openai.com');
      httpMock.expectNoUnhandled();
    });
  });

  describe('Azure OpenAI', () => {
    it('routes a doGenerate() call to the Azure deployment endpoint', async () => {
      httpMock.use(...mockAzure());
      const model = await createLanguageModelFromConfig(azureConfig());

      const res = await (model as unknown as { doGenerate: (opts: unknown) => Promise<unknown> }).doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Say hi.' }] }],
      });

      expect(res).toBeDefined();
      httpMock.expectHit('openai.azure.com');
      httpMock.expectNoUnhandled();
    });
  });

  describe('Bedrock', () => {
    it('routes a doGenerate() call to the bedrock-runtime converse endpoint', async () => {
      // `@ai-sdk/amazon-bedrock` calls the `/converse` API (not the legacy
      // `/invoke`), so we install a one-off handler returning a minimal
      // converse-shaped response. `mockBedrock()` targets `/invoke` for
      // direct SDK callers and stays useful for those tests.
      httpMock.server.use(
        http.post(/https:\/\/bedrock-runtime\.[^/]+\.amazonaws\.com\/model\/.+\/converse/, async () => {
          return HttpResponse.json({
            output: {
              message: {
                role: 'assistant',
                content: [{ text: 'Hi.' }],
              },
            },
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            metrics: { latencyMs: 1 },
          });
        }),
      );

      const model = await createLanguageModelFromConfig(bedrockConfig());

      const res = await (model as unknown as { doGenerate: (opts: unknown) => Promise<unknown> }).doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Say hi.' }] }],
      });

      expect(res).toBeDefined();
      httpMock.expectHit(/bedrock-runtime\..+\.amazonaws\.com/);
      httpMock.expectNoUnhandled();
    });
  });

  describe('authorization header propagation', () => {
    it('forwards the API key on Anthropic requests', async () => {
      // Capture the x-api-key inside the handler instead of via
      // `server.events.on('request:match', ...)`. Event listeners persist
      // across tests in the same suite unless explicitly removed; the
      // single-handler form ties the capture's lifetime to the suite's
      // `resetHandlers()` call in `afterEach`.
      let observedKey: string | null = null;
      httpMock.server.use(
        http.post(/api\.anthropic\.com(\/v1)?\/messages.*/, async ({ request }) => {
          observedKey = request.headers.get('x-api-key');
          return HttpResponse.json({
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi.' }],
            model: 'claude-3-5-sonnet-20241022',
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        }),
      );

      const model = await createLanguageModelFromConfig(anthropicConfig());
      await (model as unknown as { doGenerate: (opts: unknown) => Promise<unknown> }).doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Say hi.' }] }],
      });

      expect(observedKey).toBe('test-key-not-real');
    });
  });
});

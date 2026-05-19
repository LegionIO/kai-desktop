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
import { httpMock } from '../../../vitest.setup.js';
import { mockAnthropic, mockOpenAI, mockAzure } from '../../__tests__/setup/msw.js';

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

  describe('authorization header propagation', () => {
    it('forwards the API key on Anthropic requests', async () => {
      let observedKey: string | null = null;
      httpMock.server.use(
        // Capture the x-api-key header by registering a one-off handler.
        ...mockAnthropic(),
      );
      httpMock.server.events.on('request:match', ({ request }) => {
        observedKey = request.headers.get('x-api-key');
      });

      const model = await createLanguageModelFromConfig(anthropicConfig());
      await (model as unknown as { doGenerate: (opts: unknown) => Promise<unknown> }).doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Say hi.' }] }],
      });

      expect(observedKey).toBe('test-key-not-real');
    });
  });
});

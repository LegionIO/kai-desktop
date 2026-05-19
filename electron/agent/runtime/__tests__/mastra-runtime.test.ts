/**
 * Unit tests for the Mastra runtime adapter.
 *
 * The runtime is a thin shim over `streamAgentResponse` / `streamWithFallback`
 * in `mastra-agent.ts`. We mock those factory functions at their export
 * boundary so the tests stay focused on the adapter's branching and
 * pass-through behavior — not on Mastra internals.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from '../../../config/schema.js';
import type { StreamOptions, StreamEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Mock at Kai's factory boundary — NOT @mastra/core.
// ---------------------------------------------------------------------------

const mastraState: {
  primaryEvents: StreamEvent[];
  fallbackEvents: StreamEvent[];
  primaryCallCount: number;
  fallbackCallCount: number;
  lastPrimaryArgs?: unknown[];
  lastFallbackArgs?: unknown[];
  shouldAbort?: boolean;
} = {
  primaryEvents: [],
  fallbackEvents: [],
  primaryCallCount: 0,
  fallbackCallCount: 0,
};

vi.mock('../../mastra-agent.js', () => {
  return {
    streamAgentResponse: vi.fn((...args: unknown[]) => {
      mastraState.primaryCallCount += 1;
      mastraState.lastPrimaryArgs = args;
      const evts = mastraState.primaryEvents;
      const abort = mastraState.shouldAbort;
      return (async function* () {
        if (abort) throw new Error('aborted by test');
        for (const e of evts) yield e;
      })();
    }),
    streamWithFallback: vi.fn((...args: unknown[]) => {
      mastraState.fallbackCallCount += 1;
      mastraState.lastFallbackArgs = args;
      const evts = mastraState.fallbackEvents;
      return (async function* () {
        for (const e of evts) yield e;
      })();
    }),
  };
});

// model-catalog — resolve a deterministic model entry.
vi.mock('../../model-catalog.js', () => ({
  resolveStreamConfig: vi.fn(() => ({
    primaryModel: {
      key: 'test-model',
      displayName: 'Test Model',
      modelConfig: {
        provider: 'openai-compatible',
        endpoint: 'https://api.openai.com',
        apiKey: 'test-key-not-real',
        modelName: 'gpt-4o-mini',
        temperature: 0.7,
        maxSteps: 25,
      },
    },
    systemPrompt: 'You are helpful.',
    temperature: 0.7,
    maxSteps: 25,
    maxRetries: 2,
    fallbackEnabled: false,
    fallbackModels: [],
  })),
}));

vi.mock('../../instructions.js', () => ({
  withWorkingDirectoryPrompt: vi.fn(async (prompt: string) => prompt),
}));

const { MastraRuntime } = await import('../mastra-runtime.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): AppConfig {
  return {
    agent: { runtime: 'mastra' },
    advanced: { temperature: 0.7, maxSteps: 25, maxRetries: 2 },
    systemPrompt: 'You are helpful.',
    systemPrompts: {},
    models: { defaultModelKey: 'test-model', providers: {}, catalog: [] },
  } as unknown as AppConfig;
}

function makeOptions(overrides: Partial<StreamOptions> = {}): StreamOptions {
  return {
    conversationId: 'conv-mastra',
    messages: [{ role: 'user', content: 'Run.' }],
    config: makeConfig(),
    tools: [],
    appHome: '/tmp/kai-test',
    ...overrides,
  } as StreamOptions;
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

beforeEach(() => {
  mastraState.primaryEvents = [];
  mastraState.fallbackEvents = [];
  mastraState.primaryCallCount = 0;
  mastraState.fallbackCallCount = 0;
  mastraState.lastPrimaryArgs = undefined;
  mastraState.lastFallbackArgs = undefined;
  mastraState.shouldAbort = undefined;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MastraRuntime', () => {
  describe('isAvailable', () => {
    it('always reports true (Mastra is bundled)', async () => {
      const rt = new MastraRuntime();
      await expect(rt.isAvailable()).resolves.toBe(true);
    });
  });

  describe('stream — happy path', () => {
    it('delegates to streamAgentResponse and yields its events through', async () => {
      mastraState.primaryEvents = [
        { conversationId: 'conv-mastra', type: 'text-delta', text: 'Hi.' },
        { conversationId: 'conv-mastra', type: 'done' },
      ];

      const rt = new MastraRuntime();
      const events = await collect(rt.stream(makeOptions()));

      expect(mastraState.primaryCallCount).toBe(1);
      expect(mastraState.fallbackCallCount).toBe(0);
      expect(events).toEqual(mastraState.primaryEvents);
    });
  });

  describe('stream — error wrap', () => {
    it('lets exceptions from streamAgentResponse propagate to the caller', async () => {
      mastraState.shouldAbort = true;

      const rt = new MastraRuntime();
      await expect(collect(rt.stream(makeOptions()))).rejects.toThrow('aborted by test');
    });
  });

  describe('stream — abort propagation', () => {
    it('passes the AbortSignal through into the inner stream options', async () => {
      mastraState.primaryEvents = [{ conversationId: 'conv-mastra', type: 'done' }];

      const ac = new AbortController();
      const rt = new MastraRuntime();
      await collect(rt.stream(makeOptions({ abortSignal: ac.signal })));

      // streamAgentResponse signature: (conversationId, messages, modelConfig, config, tools, dbPath, options)
      const lastOpts = (mastraState.lastPrimaryArgs?.[6] ?? {}) as { abortSignal?: AbortSignal };
      expect(lastOpts.abortSignal).toBe(ac.signal);
    });
  });
});

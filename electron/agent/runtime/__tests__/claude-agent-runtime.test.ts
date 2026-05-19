/**
 * Unit tests for the Claude Agent SDK runtime adapter.
 *
 * The SDK is intentionally mocked at its package boundary
 * (`@anthropic-ai/claude-agent-sdk`) so these tests exercise the wrapper's
 * own translation logic (SDK messages → Kai StreamEvent) without spawning
 * the real `claude` CLI subprocess.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from '../../../config/schema.js';
import type { StreamOptions, StreamEvent } from '../types.js';

// ---------------------------------------------------------------------------
// SDK mock — controls what `query()` yields per test.
// ---------------------------------------------------------------------------

const sdkState: {
  messages: Array<Record<string, unknown>>;
  lastOptions?: Record<string, unknown>;
  queryCallCount: number;
  shouldThrow?: Error;
} = {
  messages: [],
  queryCallCount: 0,
};

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: vi.fn(({ options }: { prompt: unknown; options?: Record<string, unknown> }) => {
      sdkState.lastOptions = options;
      sdkState.queryCallCount += 1;
      const messages = sdkState.messages;
      const shouldThrow = sdkState.shouldThrow;
      return (async function* () {
        if (shouldThrow) throw shouldThrow;
        for (const msg of messages) yield msg;
      })();
    }),
    createSdkMcpServer: vi.fn((opts: { name: string; tools?: unknown[] }) => ({
      __server: true,
      name: opts.name,
      toolCount: opts.tools?.length ?? 0,
    })),
    tool: vi.fn((name: string, desc: string, schema: Record<string, unknown>) => ({
      __tool: true,
      name,
      desc,
      schema,
    })),
  };
});

// Also mock `detect.ts` so the CLI-availability probe doesn't shell out.
vi.mock('../detect.js', () => ({
  detectClaudeAgentSdk: vi.fn(async () => true),
  resolveClaudeCliPath: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Imports — placed AFTER vi.mock so the mocks land first.
// ---------------------------------------------------------------------------
const { ClaudeAgentRuntime } = await import('../claude-agent-runtime.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): AppConfig {
  return {
    agent: { runtime: 'claude-agent-sdk', maxTurns: 5, claudeAgentSdk: {} },
    advanced: { temperature: 0.7, maxSteps: 25, maxRetries: 2 },
    models: { defaultModelKey: 'k', providers: {}, catalog: [] },
    systemPrompt: 'You are helpful.',
    systemPrompts: {},
  } as unknown as AppConfig;
}

function makeOptions(overrides: Partial<StreamOptions> = {}): StreamOptions {
  return {
    conversationId: 'conv-1',
    messages: [{ role: 'user', content: 'Hello.' }],
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
  sdkState.messages = [];
  sdkState.lastOptions = undefined;
  sdkState.queryCallCount = 0;
  sdkState.shouldThrow = undefined;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeAgentRuntime', () => {
  describe('isAvailable', () => {
    it('returns true when the SDK + CLI are detectable', async () => {
      const rt = new ClaudeAgentRuntime();
      await expect(rt.isAvailable()).resolves.toBe(true);
    });
  });

  describe('stream — happy path', () => {
    it('translates an init + text response into text-delta + done events', async () => {
      sdkState.messages = [
        { type: 'system', session_id: 'sess-1', subtype: 'init' },
        {
          type: 'stream_event',
          session_id: 'sess-1',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Hi.' },
          },
        },
        {
          type: 'assistant',
          session_id: 'sess-1',
          message: {
            content: [{ type: 'text', text: 'Hi.' }],
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-1',
          result: 'Hi.',
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      ];

      const rt = new ClaudeAgentRuntime();
      const events = await collect(rt.stream(makeOptions()));

      expect(sdkState.queryCallCount).toBe(1);
      expect(events.some((e) => e.type === 'text-delta' && e.text === 'Hi.')).toBe(true);
      expect(events[events.length - 1].type).toBe('done');
    });
  });

  describe('stream — tool-use round-trip', () => {
    it('translates content_block_start (tool_use) into a tool-call event', async () => {
      sdkState.messages = [
        {
          type: 'stream_event',
          session_id: 'sess-2',
          event: {
            type: 'content_block_start',
            content_block: {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'mcp__kai__list_files',
              input: { path: '.' },
            },
          },
        },
        {
          type: 'assistant',
          session_id: 'sess-2',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'mcp__kai__list_files',
                input: { path: '.' },
              },
            ],
            usage: { input_tokens: 10, output_tokens: 4 },
          },
        },
        { type: 'result', subtype: 'success', session_id: 'sess-2' },
      ];

      const rt = new ClaudeAgentRuntime();
      const events = await collect(rt.stream(makeOptions()));

      const toolCalls = events.filter((e) => e.type === 'tool-call');
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);
      // MCP prefix should be stripped: mcp__kai__list_files → list_files
      expect(toolCalls[0].toolName).toBe('list_files');
      expect(toolCalls[0].toolCallId).toBe('toolu_1');
    });
  });

  describe('stream — session resume', () => {
    it('captures session_id from the first message and stores it for resume', async () => {
      sdkState.messages = [
        { type: 'system', session_id: 'sess-resume-1', subtype: 'init' },
        { type: 'result', subtype: 'success', session_id: 'sess-resume-1' },
      ];

      const rt = new ClaudeAgentRuntime();
      await collect(rt.stream(makeOptions({ conversationId: 'conv-resume' })));

      // Second turn — runtime should pass `resume: 'sess-resume-1'` in options.
      sdkState.messages = [{ type: 'result', subtype: 'success' }];
      await collect(rt.stream(makeOptions({ conversationId: 'conv-resume' })));
      expect(sdkState.lastOptions?.resume).toBe('sess-resume-1');
    });
  });

  describe('stream — rate-limit error path', () => {
    it('emits a typed error event and a terminal done when the SDK throws', async () => {
      sdkState.shouldThrow = new Error('429 Number of request tokens has exceeded your per-minute rate limit.');

      const rt = new ClaudeAgentRuntime();
      const events = await collect(rt.stream(makeOptions()));

      const errs = events.filter((e) => e.type === 'error');
      expect(errs.length).toBe(1);
      expect(errs[0].error).toContain('rate limit');
      expect(events[events.length - 1].type).toBe('done');
    });
  });
});

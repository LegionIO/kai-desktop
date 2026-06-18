/**
 * Unit tests for the Codex SDK runtime adapter.
 *
 * The SDK is mocked at the `@openai/codex-sdk` package boundary. The tests
 * drive `runStreamed()` with synthetic `ThreadEvent` objects (matching the
 * shapes the real SDK emits) and assert on the translated Kai `StreamEvent`
 * sequence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from '../../../config/schema.js';
import type { StreamOptions, StreamEvent } from '../types.js';

// ---------------------------------------------------------------------------
// SDK mock
// ---------------------------------------------------------------------------

const codexState: {
  events: Array<Record<string, unknown>>;
  threadIds: string[];
  lastInput?: unknown;
  startCallCount: number;
  resumeCallCount: number;
  shouldThrowOnRun?: Error;
} = {
  events: [],
  threadIds: [],
  startCallCount: 0,
  resumeCallCount: 0,
};

function makeThread() {
  return {
    id: 'thread-test-1' as string | null,
    runStreamed: vi.fn(async (input: unknown) => {
      codexState.lastInput = input;
      if (codexState.shouldThrowOnRun) throw codexState.shouldThrowOnRun;
      const evts = codexState.events;
      return {
        events: (async function* () {
          for (const ev of evts) yield ev;
        })(),
      };
    }),
    run: vi.fn(async () => ({ items: [], finalResponse: '', usage: null })),
  };
}

vi.mock('@openai/codex-sdk', () => {
  return {
    Codex: vi.fn(function () {
      return {
        startThread: vi.fn(() => {
          codexState.startCallCount += 1;
          return makeThread();
        }),
        resumeThread: vi.fn((id: string) => {
          codexState.resumeCallCount += 1;
          codexState.threadIds.push(id);
          return makeThread();
        }),
      };
    }),
  };
});

vi.mock('../detect.js', () => ({
  detectCodexSdk: vi.fn(async () => true),
}));

// Bridge — we don't want it actually starting an MCP server.
vi.mock('../codex-mcp-bridge.js', () => ({
  CodexMcpBridge: vi.fn(function () {
    return {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getAuthToken: vi.fn(() => null),
      getAuthTokenEnvVar: vi.fn(() => null),
    };
  }),
  buildCodexMcpPrompt: vi.fn((text: string) => text),
  buildCodexMcpServerConfig: vi.fn(() => ({})),
}));

const { CodexRuntime } = await import('../codex-runtime.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): AppConfig {
  return {
    agent: { runtime: 'codex-sdk', codexSdk: { approval: 'suggest' } },
    advanced: { temperature: 0.7, maxSteps: 25, maxRetries: 2 },
    models: {
      defaultModelKey: 'k',
      providers: {
        openai: { type: 'openai-compatible', apiKey: 'test-key-not-real', endpoint: 'https://api.openai.com' },
      },
      catalog: [],
    },
    systemPrompt: '',
    systemPrompts: {},
  } as unknown as AppConfig;
}

function makeOptions(overrides: Partial<StreamOptions> = {}): StreamOptions {
  return {
    conversationId: 'conv-1',
    messages: [{ role: 'user', content: 'Run a quick command.' }],
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
  codexState.events = [];
  codexState.threadIds = [];
  codexState.lastInput = undefined;
  codexState.startCallCount = 0;
  codexState.resumeCallCount = 0;
  codexState.shouldThrowOnRun = undefined;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodexRuntime', () => {
  describe('isAvailable', () => {
    it('returns true when the codex CLI is detectable', async () => {
      const rt = new CodexRuntime();
      await expect(rt.isAvailable()).resolves.toBe(true);
    });
  });

  describe('stream — streaming events', () => {
    it('translates thread.started + agent_message into enrichment + text-delta + done', async () => {
      codexState.events = [
        { type: 'thread.started', thread_id: 'thr-1' },
        {
          type: 'item.completed',
          item: { id: 'item-1', type: 'agent_message', text: 'Hello world.' },
        },
      ];

      const rt = new CodexRuntime();
      const events = await collect(rt.stream(makeOptions()));

      const enrichments = events.filter((e) => e.type === 'enrichment');
      expect(enrichments.length).toBe(1);
      expect((enrichments[0].data as { codexSdkThreadId?: string }).codexSdkThreadId).toBe('thr-1');

      const text = events.filter((e) => e.type === 'text-delta');
      expect(text.length).toBeGreaterThanOrEqual(1);
      expect(text.some((e) => (e.text ?? '').includes('Hello world.'))).toBe(true);
      expect(events[events.length - 1].type).toBe('done');
    });
  });

  describe('stream — tool-call deltas', () => {
    it('translates command_execution started + completed into tool-call + tool-result', async () => {
      codexState.events = [
        {
          type: 'item.started',
          item: { id: 'cmd-1', type: 'command_execution', command: 'ls -la' },
        },
        {
          type: 'item.completed',
          item: { id: 'cmd-1', type: 'command_execution', command: 'ls -la', aggregated_output: 'file.txt' },
        },
      ];

      const rt = new CodexRuntime();
      const events = await collect(rt.stream(makeOptions()));

      const toolCalls = events.filter((e) => e.type === 'tool-call');
      const toolResults = events.filter((e) => e.type === 'tool-result');
      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0].toolName).toBe('Bash');
      expect(toolResults.length).toBe(1);
      expect(toolResults[0].result).toBe('file.txt');
    });
  });

  describe('stream — mcp roundtrip stub', () => {
    it('translates mcp_tool_call started + completed into a tool-call + tool-result pair', async () => {
      codexState.events = [
        {
          type: 'item.started',
          item: {
            id: 'mcp-1',
            type: 'mcp_tool_call',
            server: 'kai',
            tool: 'list_files',
            arguments: { path: '.' },
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'mcp-1',
            type: 'mcp_tool_call',
            server: 'kai',
            tool: 'list_files',
            arguments: { path: '.' },
            result: { content: [{ type: 'text', text: 'README.md' }] },
          },
        },
      ];

      const rt = new CodexRuntime();
      const events = await collect(rt.stream(makeOptions()));

      const toolCalls = events.filter((e) => e.type === 'tool-call');
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);
      // The bridge translates the tool name to either `list_files` or `kai_list_files`
      // depending on naming convention; assert the call exists with the right id.
      expect(toolCalls.some((c) => c.toolCallId === 'mcp-1')).toBe(true);
    });
  });
});

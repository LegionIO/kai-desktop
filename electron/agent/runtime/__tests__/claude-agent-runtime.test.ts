/**
 * Unit tests for the Claude Agent SDK runtime adapter.
 *
 * The SDK is intentionally mocked at its package boundary
 * (`@anthropic-ai/claude-agent-sdk`) so these tests exercise the wrapper's
 * own translation logic (SDK messages → Kai StreamEvent) without spawning
 * the real `claude` CLI subprocess.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { AppConfig } from '../../../config/schema.js';
import type { StreamOptions, StreamEvent } from '../types.js';
import type { ToolDefinition } from '../../../tools/types.js';
import { hookDispatcher } from '../../hooks/dispatcher.js';
import { pendingToolApprovals } from '../../../ipc/tool-approval.js';
import { pendingQuestionAnswers, makeAnswerKey } from '../../../tools/ask-user.js';

// ---------------------------------------------------------------------------
// SDK mock — controls what `query()` yields per test.
// ---------------------------------------------------------------------------

const sdkState: {
  messages: Array<Record<string, unknown>>;
  lastOptions?: Record<string, unknown>;
  queryCallCount: number;
  shouldThrow?: Error;
  toolHandlers: Map<string, (args: unknown, extra: unknown) => Promise<unknown>>;
} = {
  messages: [],
  queryCallCount: 0,
  toolHandlers: new Map(),
};

const appendFileSyncMock = vi.hoisted(() => vi.fn());
const mkdirSyncMock = vi.hoisted(() => vi.fn());

vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  appendFileSync: appendFileSyncMock,
  mkdirSync: mkdirSyncMock,
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

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
    tool: vi.fn(
      (
        name: string,
        desc: string,
        schema: Record<string, unknown>,
        handler: (args: unknown, extra: unknown) => Promise<unknown>,
      ) => {
        sdkState.toolHandlers.set(name, handler);
        return { __tool: true, name, desc, schema, handler };
      },
    ),
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
const previousClaudeDebug = process.env.KAI_DEBUG_CLAUDE_SDK;
process.env.KAI_DEBUG_CLAUDE_SDK = '1';
const { ClaudeAgentRuntime } = await import('../claude-agent-runtime.js');
if (previousClaudeDebug === undefined) delete process.env.KAI_DEBUG_CLAUDE_SDK;
else process.env.KAI_DEBUG_CLAUDE_SDK = previousClaudeDebug;
// Read the SDK mock's spies to assert what got bridged.
const sdkMock = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as {
  createSdkMcpServer: ReturnType<typeof vi.fn>;
  tool: ReturnType<typeof vi.fn>;
};

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
  sdkState.toolHandlers.clear();
  sdkMock.createSdkMcpServer.mockClear();
  sdkMock.tool.mockClear();
  appendFileSyncMock.mockClear();
  mkdirSyncMock.mockClear();
  pendingToolApprovals.clear();
  pendingQuestionAnswers.clear();
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

    it('keeps SDK diagnostics structural when messages contain Browser secrets', async () => {
      const secrets = [
        'PROMPT_SECRET_7f196d',
        'TYPED_PASSWORD_6c322a',
        'RAW_SCRIPT_0f91ab',
        'https://alice:password@example.com/private?token=URL_SECRET_485dc1',
        'TOOL_RESULT_SECRET_2b2138',
        'STRUCTURED_SECRET_a521e2',
        'THROWN_SECRET_f4d2bc',
      ];
      sdkState.messages = [
        {
          type: 'assistant',
          session_id: 'sess-secret',
          message: {
            content: [
              { type: 'text', text: secrets[1] },
              {
                type: 'tool_use',
                id: 'tool-secret',
                name: 'mcp__kai__browser_evaluate',
                input: { script: secrets[2], url: secrets[3] },
              },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tool-secret', content: secrets[4] }],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          result: secrets[3],
          structured_output: { private: secrets[5] },
        },
      ];

      await collect(
        new ClaudeAgentRuntime().stream(makeOptions({ messages: [{ role: 'user', content: secrets[0] }] })),
      );
      sdkState.messages = [];
      sdkState.shouldThrow = new Error(secrets[6]);
      await collect(new ClaudeAgentRuntime().stream(makeOptions()));

      const diagnostics = appendFileSyncMock.mock.calls.map((call) => String(call[1])).join('\n');
      expect(diagnostics).toContain('[MSG 1]');
      expect(diagnostics).toContain('string(length=');
      for (const secret of secrets) expect(diagnostics).not.toContain(secret);
      expect(diagnostics).not.toContain('alice:password');
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

  describe('stream — tool-result round-trip', () => {
    it('translates `user` content_block tool_result into a tool-result StreamEvent', async () => {
      // The SDK emits a `user` message with `tool_result` blocks AFTER the
      // assistant's tool_use. A regression that drops the result event would
      // leave the renderer waiting forever — this test pins the contract.
      sdkState.messages = [
        {
          type: 'assistant',
          session_id: 'sess-tr',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_2',
                name: 'mcp__kai__read_file',
                input: { path: 'README.md' },
              },
            ],
            usage: { input_tokens: 10, output_tokens: 4 },
          },
        },
        {
          type: 'user',
          session_id: 'sess-tr',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_2',
                content: '# Hello world',
                is_error: false,
              },
            ],
          },
        },
        { type: 'result', subtype: 'success', session_id: 'sess-tr' },
      ];

      const rt = new ClaudeAgentRuntime();
      const events = await collect(rt.stream(makeOptions()));

      const toolResults = events.filter((e) => e.type === 'tool-result');
      expect(toolResults.length).toBeGreaterThanOrEqual(1);
      const tr = toolResults[0];
      if (tr.type === 'tool-result') {
        expect(tr.toolCallId).toBe('toolu_2');
        // The tool NAME recorded at the tool-CALL block is stamped onto the result event so
        // MAIN's mid-stream enter_plan_mode/exit_plan_mode interception fires for SDK runs (R138 f-4).
        expect(tr.toolName).toBe('read_file');
        // Result content should reach the renderer verbatim.
        const resultStr = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result);
        expect(resultStr).toContain('Hello world');
      }
      expect(events[events.length - 1].type).toBe('done');
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

  describe('stream — tool bridging', () => {
    function tool(name: string, source: ToolDefinition['source']): ToolDefinition {
      return {
        name,
        description: `${name} desc`,
        source,
        inputSchema: z.object({ q: z.string() }),
        execute: async () => ({ ok: true }),
      } as unknown as ToolDefinition;
    }

    it('bridges builtin/cli tools (web_search/web_fetch/memory) into the kai MCP server, skips sub_agent', async () => {
      sdkState.messages = [{ type: 'system', session_id: 's', subtype: 'init' }];
      const rt = new ClaudeAgentRuntime();
      await collect(
        rt.stream(
          makeOptions({
            tools: [
              tool('web_search', 'builtin'),
              tool('web_fetch', 'builtin'),
              tool('memory', 'builtin'),
              tool('my_cli_tool', 'cli'),
              tool('some_plugin_tool', 'plugin'),
              tool('sub_agent', 'builtin'), // must be skipped
            ],
          }),
        ),
      );

      // Each bridged tool becomes a tool() call; sub_agent is excluded.
      const bridgedNames = sdkMock.tool.mock.calls.map((c) => c[0] as string);
      expect(bridgedNames).toContain('web_search');
      expect(bridgedNames).toContain('web_fetch');
      expect(bridgedNames).toContain('memory');
      expect(bridgedNames).toContain('my_cli_tool');
      expect(bridgedNames).toContain('some_plugin_tool');
      expect(bridgedNames).not.toContain('sub_agent');

      // The kai MCP server was created with exactly those 5 tools.
      expect(sdkMock.createSdkMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'kai', tools: expect.arrayContaining([]) }),
      );
      const serverCall = sdkMock.createSdkMcpServer.mock.calls.at(-1)?.[0] as { tools?: unknown[] };
      expect(serverCall.tools).toHaveLength(5);
    });

    it('redacts Browser execution failures before returning them through the SDK handler', async () => {
      const secretUrl = 'https://alice:password@example.com/callback?token=claude-secret';
      sdkState.messages = [{ type: 'system', session_id: 's', subtype: 'init' }];
      const rt = new ClaudeAgentRuntime();
      await collect(
        rt.stream(
          makeOptions({
            tools: [
              {
                name: 'browser_action',
                description: 'Browser action',
                source: 'browser',
                inputSchema: z.object({}),
                execute: async () => {
                  throw new Error(`ERR_FAILED while loading ${secretUrl}`);
                },
              },
            ],
          }),
        ),
      );

      const result = (await sdkState.toolHandlers.get('browser_action')?.({}, {})) as {
        content?: Array<{ text?: string }>;
        isError?: boolean;
      };
      const exposed = JSON.stringify(result);
      expect(result.isError).toBe(true);
      expect(exposed).toContain('[redacted browser URL: https://example.com]');
      expect(exposed).not.toMatch(/claude-secret|alice:password/);
    });

    it('enforces lifecycle hook modifications for Claude Browser calls', async () => {
      const execute = vi.fn(async (input) => ({ raw: true, input }));
      const unregisterPre = hookDispatcher.register(
        'PreToolUse',
        () => ({ payload: { args: { script: 'safe-script' } } }),
        { mode: 'modify', matcher: 'browser_evaluate' },
      );
      const unregisterPost = hookDispatcher.register(
        'PostToolUse',
        () => ({ payload: { result: { sanitized: true } } }),
        { mode: 'modify', matcher: 'browser_evaluate' },
      );
      try {
        sdkState.messages = [{ type: 'system', session_id: 's', subtype: 'init' }];
        const rt = new ClaudeAgentRuntime();
        await collect(
          rt.stream(
            makeOptions({
              browserOwnerId: 'browser-run-hooks',
              tools: [
                {
                  name: 'browser_evaluate',
                  description: 'Browser evaluation',
                  source: 'browser',
                  inputSchema: z.object({ script: z.string() }),
                  execute,
                },
              ],
            }),
          ),
        );

        const result = (await sdkState.toolHandlers.get('browser_evaluate')?.({ script: 'raw-secret-script' }, {})) as {
          content?: Array<{ text?: string }>;
          isError?: boolean;
        };

        expect(execute).toHaveBeenCalledWith(
          { script: 'safe-script' },
          expect.objectContaining({
            conversationId: 'conv-1',
            browserOwnerId: 'browser-run-hooks',
          }),
        );
        expect(result.isError).toBeUndefined();
        expect(JSON.stringify(result)).toContain('sanitized');
        expect(JSON.stringify(result)).not.toContain('raw-secret-script');
      } finally {
        unregisterPost();
        unregisterPre();
      }
    });

    it.each(['ask_user', 'exit_plan_mode'])('enforces PreToolUse denials for Claude special tool %s', async (name) => {
      const execute = vi.fn(async () => ({ shouldNotRun: true }));
      const unregister = hookDispatcher.register(
        'PreToolUse',
        () => ({ decision: 'deny', reason: 'blocked special tool' }),
        { mode: 'block', matcher: name },
      );
      try {
        sdkState.messages = [{ type: 'system', session_id: 's', subtype: 'init' }];
        const rt = new ClaudeAgentRuntime();
        await collect(
          rt.stream(
            makeOptions({
              tools: [
                {
                  name,
                  description: name,
                  source: 'builtin',
                  inputSchema: z.object({ value: z.string() }),
                  execute,
                },
              ],
            }),
          ),
        );

        const result = (await sdkState.toolHandlers.get(name)?.({ value: 'private input' }, {})) as {
          content?: Array<{ text?: string }>;
          isError?: boolean;
        };
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain('blocked special tool');
        expect(pendingToolApprovals.size).toBe(0);
        expect(execute).not.toHaveBeenCalled();
      } finally {
        unregister();
      }
    });

    it('applies PreToolUse changes and PostToolUse redaction to ask_user answers', async () => {
      let postPayload: unknown;
      const unregisterPre = hookDispatcher.register(
        'PreToolUse',
        () => ({ payload: { args: { prompt: 'approved prompt' } } }),
        { mode: 'modify', matcher: 'ask_user' },
      );
      const unregisterPost = hookDispatcher.register(
        'PostToolUse',
        (payload) => {
          postPayload = payload;
          return { payload: { result: { sanitized: true } } };
        },
        { mode: 'modify', matcher: 'ask_user' },
      );
      try {
        sdkState.messages = [{ type: 'system', session_id: 's', subtype: 'init' }];
        const rt = new ClaudeAgentRuntime();
        await collect(
          rt.stream(
            makeOptions({
              tools: [
                {
                  name: 'ask_user',
                  description: 'Ask the user',
                  source: 'builtin',
                  inputSchema: z.object({ prompt: z.string() }),
                  execute: vi.fn(async () => null),
                },
              ],
            }),
          ),
        );

        const response = sdkState.toolHandlers.get('ask_user')?.({ prompt: 'private prompt' }, {});
        await vi.waitFor(() => expect(pendingToolApprovals.size).toBe(1));
        const [toolCallId, pending] = [...pendingToolApprovals.entries()][0]!;
        // The answer stash is conversation-scoped (R191); seed under the composite key the SDK
        // handler reads (conversationId 'conv-1' from makeOptions).
        pendingQuestionAnswers.set(makeAnswerKey('conv-1', toolCallId), { answer: 'private answer' });
        pending.resolve(true);
        const result = (await response) as { content?: Array<{ text?: string }>; isError?: boolean };

        expect(postPayload).toMatchObject({
          args: { prompt: 'approved prompt' },
          result: { success: true, answers: { answer: 'private answer' } },
        });
        expect(JSON.stringify(result)).toContain('sanitized');
        expect(JSON.stringify(result)).not.toMatch(/private prompt|private answer/);
      } finally {
        for (const pending of pendingToolApprovals.values()) pending.resolve('dismiss');
        unregisterPost();
        unregisterPre();
      }
    });

    it('applies lifecycle changes around an approved exit_plan_mode execution', async () => {
      const execute = vi.fn(async () => ({ rawPlanResult: true }));
      const unregisterPre = hookDispatcher.register(
        'PreToolUse',
        () => ({ payload: { args: { plan: 'approved plan' } } }),
        { mode: 'modify', matcher: 'exit_plan_mode' },
      );
      const unregisterPost = hookDispatcher.register(
        'PostToolUse',
        () => ({ payload: { result: { sanitized: true } } }),
        { mode: 'modify', matcher: 'exit_plan_mode' },
      );
      try {
        sdkState.messages = [{ type: 'system', session_id: 's', subtype: 'init' }];
        const rt = new ClaudeAgentRuntime();
        await collect(
          rt.stream(
            makeOptions({
              browserOwnerId: 'plan-owner',
              tools: [
                {
                  name: 'exit_plan_mode',
                  description: 'Exit plan mode',
                  source: 'builtin',
                  inputSchema: z.object({ plan: z.string() }),
                  execute,
                },
              ],
            }),
          ),
        );

        const response = sdkState.toolHandlers.get('exit_plan_mode')?.({ plan: 'private plan' }, {});
        await vi.waitFor(() => expect(pendingToolApprovals.size).toBe(1));
        [...pendingToolApprovals.values()][0]!.resolve(true);
        const result = (await response) as { content?: Array<{ text?: string }>; isError?: boolean };

        expect(execute).toHaveBeenCalledWith(
          { plan: 'approved plan' },
          expect.objectContaining({
            conversationId: 'conv-1',
            browserOwnerId: 'plan-owner',
            toolCallId: expect.stringMatching(/^sdk-plan-/),
          }),
        );
        expect(JSON.stringify(result)).toContain('sanitized');
        expect(JSON.stringify(result)).not.toMatch(/private plan|rawPlanResult/);
      } finally {
        for (const pending of pendingToolApprovals.values()) pending.resolve('dismiss');
        unregisterPost();
        unregisterPre();
      }
    });
  });
});

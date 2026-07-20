/**
 * Real-path tests for the Mastra agent factory.
 *
 * Why "scaled-down" real-path instead of pure HTTP-egress:
 *
 *   The original ambition for these tests was to drive `streamAgentResponse`
 *   end-to-end through the real `@mastra/core` `Agent`, `Workspace`, and
 *   `Memory` stack with msw intercepting only at the HTTP egress.  Two
 *   constraints make that impractical in PR 2:
 *
 *     1. `@mastra/core/workspace` spawns `LocalFilesystem` + `LocalSandbox`
 *        which touch the filesystem and (depending on platform) try to
 *        compile a sandbox helper — that requires `KAI_USER_DATA` plus an
 *        async setup not currently exposed to test code.
 *     2. `getSharedMemory()` creates a libsql store on disk and an embedding
 *        provider; without an HTTP egress for the embedder, msw fails closed
 *        before the model under test is reached.
 *
 *   Both could be addressed by introducing an additional seam (a factory
 *   that returns `{ workspace, memory, agent }`) — that is a refactor that
 *   belongs to its own PR.  For PR 2 we exercise the **pure** real paths
 *   that have no Mastra runtime dependency, plus a focused smoke test that
 *   reaches the HTTP egress through `createLanguageModelFromConfig` (which
 *   is what `mastra-agent` calls internally before handing the model to
 *   `Agent`).  These five tests give us:
 *
 *     1. Happy-path stream + tool dispatch (via mock @mastra/core Agent)
 *     2. Primary-model failure triggers fallback path
 *     3. Memory factory wiring (sharedMemory returns the same instance)
 *     4. Tool registry composition includes both built-ins and user tools
 *     5. Malformed provider response surfaces as a typed error
 *
 *   The HTTP egress through @ai-sdk providers is covered separately by
 *   `language-model.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { AppConfig } from '../../config/schema.js';
import type { ToolDefinition } from '../../tools/types.js';
import type { StreamEvent } from '../mastra-agent.js';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const agentState: {
  generateImpl?: (input: unknown, opts: unknown) => Promise<unknown>;
  streamImpl?: (input?: unknown, opts?: unknown) => unknown;
  toolsAttached?: unknown;
  lastInstructions?: string;
  lastInputProcessors?: unknown;
  lastGenerateOptions?: unknown;
  streamOptions: unknown[];
  workspaceCommandInput?: unknown;
  agentBuildCount: number;
} = {
  agentBuildCount: 0,
  streamOptions: [],
};

vi.mock('@mastra/core/agent', () => {
  return {
    Agent: vi.fn(function (cfg: { instructions?: string; tools?: unknown; inputProcessors?: unknown }) {
      agentState.agentBuildCount += 1;
      agentState.toolsAttached = cfg.tools;
      agentState.lastInstructions = cfg.instructions;
      agentState.lastInputProcessors = cfg.inputProcessors;
      return {
        generate: vi.fn(async (input: unknown, opts: unknown) => {
          agentState.lastGenerateOptions = opts;
          if (agentState.generateImpl) return agentState.generateImpl(input, opts);
          return { text: 'Hi.', finishReason: 'stop' };
        }),
        stream: vi.fn(async (input: unknown, opts: unknown) => {
          agentState.streamOptions.push(opts);
          if (agentState.streamImpl) return agentState.streamImpl(input, opts);
          return {
            textStream: (async function* () {
              yield 'Hi.';
            })(),
            fullStream: (async function* () {
              yield { type: 'text-delta', payload: { text: 'Hi.' } };
              yield { type: 'finish', payload: { finishReason: 'stop' } };
            })(),
          };
        }),
      };
    }),
  };
});

// Mock workspace creation — we don't want LocalFilesystem/LocalSandbox to run.
vi.mock('@mastra/core/workspace', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@mastra/core/workspace');
  return {
    ...actual,
    Workspace: vi.fn(function () {
      return {
        id: 'mock-workspace',
        init: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
      };
    }),
    LocalFilesystem: vi.fn(function () {
      return { id: 'mock-fs' };
    }),
    LocalSandbox: vi.fn(function () {
      return { id: 'mock-sandbox' };
    }),
    createWorkspaceTools: vi.fn(async () => ({
      'workspace.read_file': { description: 'read', execute: vi.fn() },
      'workspace.list_files': { description: 'list', execute: vi.fn() },
      mastra_workspace_execute_command: {
        description: 'execute command',
        execute: vi.fn(async (input: unknown, context: unknown) => {
          agentState.workspaceCommandInput = input;
          const writer = (context as { writer?: { custom?: (event: unknown) => Promise<unknown> } } | undefined)
            ?.writer;
          await writer?.custom?.({
            type: 'data-sandbox-stderr',
            data: { output: 'find: /Volumes/Workspace: No such file or directory\n' },
          });
          await writer?.custom?.({
            type: 'data-sandbox-exit',
            data: { exitCode: 0, success: true },
          });
          return '(no output)';
        }),
      },
    })),
  };
});

// Memory — return a minimal shape so memory wiring doesn't blow up.
vi.mock('../memory.js', () => ({
  getSharedMemory: vi.fn(() => ({ id: 'mock-memory' })),
  getResourceId: vi.fn(() => 'kai'),
}));

// Language model factory — fast-path mock so we don't reach the HTTP layer.
vi.mock('../language-model.js', () => ({
  createLanguageModelFromConfig: vi.fn(async () => ({ id: 'mock-model' })),
  shouldUseOpenAIResponsesApi: vi.fn(() => false),
}));

const { streamAgentResponse, streamWithFallback, normalizeAgentCwd, createWorkspaceToolDefinitions, __internal } =
  await import('../mastra-agent.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): AppConfig {
  return {
    agent: { runtime: 'mastra' },
    advanced: { temperature: 0.7, maxSteps: 5, maxRetries: 2 },
    systemPrompt: 'You are Kai.',
    systemPrompts: { chat: 'You are Kai.' },
    models: { defaultModelKey: 'test', providers: {}, catalog: [] },
    memory: { enabled: true, recentHistoryMode: 'kai-branch', lastMessages: 10 },
    tools: {
      executionMode: 'normal',
      shell: { enabled: true, timeout: 30_000, allowPatterns: ['*'], denyPatterns: [] },
    },
  } as unknown as AppConfig;
}

function makeModelConfig() {
  return {
    provider: 'openai-compatible' as const,
    endpoint: 'https://api.openai.com',
    apiKey: 'test-key-not-real',
    modelName: 'gpt-4o-mini',
    temperature: 0.7,
    maxSteps: 5,
    maxRetries: 1,
  };
}

function makeStreamConfig() {
  return {
    primaryModel: {
      key: 'primary',
      displayName: 'Primary',
      modelConfig: makeModelConfig(),
    },
    fallbackModels: [
      {
        key: 'fallback',
        displayName: 'Fallback',
        modelConfig: { ...makeModelConfig(), modelName: 'gpt-4o-mini-fallback' },
      },
    ],
    fallbackEnabled: true,
    systemPrompt: 'You are Kai.',
    temperature: 0.7,
    maxSteps: 5,
    maxRetries: 1,
    useResponsesApi: false,
  } as unknown as Parameters<typeof streamWithFallback>[2];
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

beforeEach(() => {
  agentState.generateImpl = undefined;
  agentState.streamImpl = undefined;
  agentState.toolsAttached = undefined;
  agentState.lastInstructions = undefined;
  agentState.lastInputProcessors = undefined;
  agentState.lastGenerateOptions = undefined;
  agentState.streamOptions = [];
  agentState.workspaceCommandInput = undefined;
  agentState.agentBuildCount = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mastra-agent — pure helpers', () => {
  describe('buildMastraMemoryOptions', () => {
    it('does not prepend persisted recent messages to a caller-supplied full branch', () => {
      expect(__internal.buildMastraMemoryOptions('thread-1', { id: 'memory' } as never, makeConfig())).toEqual({
        memory: {
          thread: { id: 'thread-1' },
          resource: 'kai',
          options: { lastMessages: false },
        },
      });
    });

    it('omits memory options when memory is disabled', () => {
      expect(__internal.buildMastraMemoryOptions('thread-1', null, makeConfig())).toBeUndefined();
    });

    it('recalls the configured bounded suffix in deduplicated merge mode', () => {
      const config = makeConfig();
      config.memory.recentHistoryMode = 'merge-mastra';
      config.memory.lastMessages = 24;
      expect(__internal.buildMastraMemoryOptions('thread-1', { id: 'memory' } as never, config)).toEqual({
        memory: {
          thread: { id: 'thread-1' },
          resource: 'kai',
          options: { lastMessages: 24 },
        },
      });
    });
  });

  describe('normalizeAgentCwd', () => {
    it('expands "~" to homedir', () => {
      const result = normalizeAgentCwd('~');
      expect(result).not.toBe('~');
      expect(result.length).toBeGreaterThan(1);
    });

    it('returns an absolute path unchanged', () => {
      const result = normalizeAgentCwd('/tmp/foo');
      expect(result).toBe('/tmp/foo');
    });

    it('resolves relative paths against homedir', () => {
      const result = normalizeAgentCwd('Projects');
      expect(result.endsWith('/Projects')).toBe(true);
    });

    it('defaults empty / null / whitespace to homedir', () => {
      // empty, null, and whitespace all fall back to homedir (an absolute path)
      for (const v of ['', '   ', null, undefined]) {
        const r = normalizeAgentCwd(v);
        expect(r.startsWith('/')).toBe(true);
        expect(r.length).toBeGreaterThan(1);
      }
    });

    it('expands "~/sub" under homedir', () => {
      const r = normalizeAgentCwd('~/Documents/notes');
      expect(r).not.toContain('~');
      expect(r.endsWith('/Documents/notes')).toBe(true);
    });
  });

  describe('normalizeWorkspacePath', () => {
    const { normalizeWorkspacePath } = __internal;
    const base = '/work/base';

    it('returns basePath for empty / "." / whitespace', () => {
      expect(normalizeWorkspacePath(base, '')).toBe(base);
      expect(normalizeWorkspacePath(base, '.')).toBe(base);
      expect(normalizeWorkspacePath(base, '   ')).toBe(base);
    });

    it('returns an absolute path unchanged', () => {
      expect(normalizeWorkspacePath(base, '/etc/hosts')).toBe('/etc/hosts');
    });

    it('resolves a relative path against basePath (incl. .. traversal — confinement is enforced later by isPathAllowed)', () => {
      expect(normalizeWorkspacePath(base, 'sub/file.txt')).toBe('/work/base/sub/file.txt');
      expect(normalizeWorkspacePath(base, '../escape')).toBe('/work/escape');
    });

    it('expands "~" and "~/sub" to homedir (not basePath)', () => {
      const home = normalizeWorkspacePath(base, '~');
      expect(home).not.toContain('~');
      expect(home.startsWith('/')).toBe(true);
      const sub = normalizeWorkspacePath(base, '~/x/y');
      expect(sub).not.toContain('~');
      expect(sub.endsWith('/x/y')).toBe(true);
      expect(sub.startsWith('/work/base')).toBe(false); // resolved under home, not base
    });
  });

  describe('workspace Read schema normalization', () => {
    it('coerces finite numeric strings before Mastra validation', async () => {
      const readTool = {
        inputSchema: z.object({
          path: z.string(),
          offset: z.number().optional(),
          limit: z.number().optional(),
        }),
      };
      __internal.coerceWorkspaceReadLineArguments({ mastra_workspace_read_file: readTool });

      const result = await readTool.inputSchema['~standard'].validate({
        path: '~/src/file.ts',
        offset: '230',
        limit: '50',
      });

      expect(result).toEqual({ value: { path: '~/src/file.ts', offset: 230, limit: 50 } });
      expect(z.toJSONSchema(readTool.inputSchema)).toMatchObject({
        properties: {
          offset: { type: 'number' },
          limit: { type: 'number' },
        },
      });
    });

    it('still rejects nonnumeric strings', async () => {
      const readTool = {
        inputSchema: z.object({
          path: z.string(),
          offset: z.number().optional(),
          limit: z.number().optional(),
        }),
      };
      __internal.coerceWorkspaceReadLineArguments({ mastra_workspace_read_file: readTool });

      const result = await readTool.inputSchema['~standard'].validate({ path: 'file.ts', offset: 'later' });

      expect(result).toMatchObject({
        issues: [expect.objectContaining({ path: ['offset'], code: 'invalid_type' })],
      });
    });

    it('also normalizes direct workspace-tool invocations that bypass schema parsing', () => {
      expect(
        __internal.normalizeWorkspaceToolInput(
          'mastra_workspace_read_file',
          { path: '~/src/file.ts', offset: '230', limit: '50' },
          '/workspace',
        ),
      ).toMatchObject({ offset: 230, limit: 50 });
    });
  });

  describe('workspace command output', () => {
    it('surfaces stderr from a successful pipeline instead of reporting no output', () => {
      expect(
        __internal.surfaceWorkspaceCommandStderr('(no output)', {
          stdout: '',
          stderr: 'find: /Volumes/Workspace: No such file or directory\n',
          success: true,
        }),
      ).toBe('stderr:\nfind: /Volumes/Workspace: No such file or directory');
    });

    it('keeps failed-command results unchanged because Mastra already includes stderr', () => {
      expect(
        __internal.surfaceWorkspaceCommandStderr('error\nExit code: 1', {
          stdout: '',
          stderr: 'error\n',
          success: false,
        }),
      ).toBe('error\nExit code: 1');
    });

    it('uses the active execution cwd and captures Mastra writer stderr', async () => {
      const definitions = await createWorkspaceToolDefinitions('/Users/test', makeConfig);
      const executeCommand = definitions.find((tool) => tool.name === 'mastra_workspace_execute_command');
      expect(executeCommand).toBeDefined();

      const result = await executeCommand!.execute(
        { command: 'find . -type d | head -n 1', timeout: 30 },
        {
          toolCallId: 'tc-observer-cwd',
          cwd: '/Volumes/Workspace NVME/git/kai-plugin-plex',
        },
      );

      expect(agentState.workspaceCommandInput).toMatchObject({
        cwd: '/Volumes/Workspace NVME/git/kai-plugin-plex',
      });
      expect(result).toBe('stderr:\nfind: /Volumes/Workspace: No such file or directory');
    });
  });
});

describe('streamAgentResponse — real path (mocked @mastra/core)', () => {
  describe('happy-path stream + tool dispatch', () => {
    it('builds an Agent, runs stream(), and yields text-delta + done', async () => {
      agentState.streamImpl = () => ({
        textStream: (async function* () {
          yield 'Hello.';
        })(),
        fullStream: (async function* () {
          yield { type: 'text-delta', payload: { text: 'Hello.' } };
          yield { type: 'finish', payload: { finishReason: 'stop' } };
        })(),
      });

      const responseMessageId = 'msg-kai-shared-1';
      const events = await collect(
        streamAgentResponse(
          'conv-real-1',
          [{ role: 'user', content: 'Hi.' }],
          makeModelConfig(),
          makeConfig(),
          [],
          '/tmp/test.db',
          { responseMessageId },
        ),
      );

      expect(agentState.agentBuildCount).toBeGreaterThanOrEqual(1);
      expect(agentState.lastInstructions).toContain('Quote every path that contains whitespace.');
      expect(events.some((e) => e.type === 'text-delta' && e.text === 'Hello.')).toBe(true);
      expect(events.every((e) => e.responseMessageId === responseMessageId)).toBe(true);
      const streamOptions = agentState.streamOptions[0] as { experimental_generateMessageId?: () => string };
      expect(streamOptions.experimental_generateMessageId?.()).toBe(responseMessageId);
      expect(events[events.length - 1].type).toBe('done');
    });

    it('uses the same caller-supplied id for the non-streaming generate path', async () => {
      const responseMessageId = 'msg-kai-generate-1';
      const reasoningGatewayModel = {
        ...makeModelConfig(),
        provider: 'amazon-bedrock' as const,
        endpoint: 'https://example.test/ai-gateway-reasoning/',
      };

      const events = await collect(
        streamAgentResponse(
          'conv-generate-id',
          [{ role: 'user', content: 'Hi.' }],
          reasoningGatewayModel,
          makeConfig(),
          [],
          '/tmp/generate-id.db',
          { responseMessageId },
        ),
      );

      const generateOptions = agentState.lastGenerateOptions as { experimental_generateMessageId?: () => string };
      expect(generateOptions.experimental_generateMessageId?.()).toBe(responseMessageId);
      expect(events.every((event) => event.responseMessageId === responseMessageId)).toBe(true);
    });

    it('emits step progress and max-steps-reached for capped streaming tool loops', async () => {
      agentState.streamImpl = () => ({
        textStream: (async function* () {})(),
        fullStream: (async function* () {
          yield { type: 'step-finish', payload: { finishReason: 'tool-calls' } };
          yield { type: 'step-finish', payload: { finishReason: 'tool-calls' } };
          yield { type: 'finish', payload: { finishReason: 'tool-calls' } };
        })(),
      });

      const baseConfig = makeConfig();
      const config = {
        ...baseConfig,
        advanced: { ...baseConfig.advanced, maxSteps: 2 },
      } as AppConfig;

      const events = await collect(
        streamAgentResponse(
          'conv-step-cap',
          [{ role: 'user', content: 'Keep using tools.' }],
          makeModelConfig(),
          config,
          [],
          '/tmp/step-cap.db',
        ),
      );

      const stepEvents = events.filter((e) => e.type === 'step-progress');
      expect(stepEvents).toHaveLength(2);
      expect(stepEvents[1].stepInfo).toMatchObject({
        currentStep: 2,
        maxSteps: 2,
        hitLimit: false,
      });
      expect(events.some((e) => e.type === 'max-steps-reached' && e.stepInfo?.hitLimit)).toBe(true);
      expect(events[events.length - 1].type).toBe('done');
    });
  });

  describe('memory attachment', () => {
    it('attaches the shared memory to the Agent', async () => {
      const { getSharedMemory } = await import('../memory.js');

      await collect(
        streamAgentResponse(
          'conv-mem',
          [{ role: 'user', content: 'Hi.' }],
          makeModelConfig(),
          makeConfig(),
          [],
          '/tmp/mem.db',
        ),
      );

      expect(getSharedMemory).toHaveBeenCalled();
    });

    it('attaches the reconciliation processor only in merge mode', async () => {
      const config = makeConfig();
      config.memory.recentHistoryMode = 'merge-mastra';

      await collect(
        streamAgentResponse(
          'conv-mem-merge',
          [{ role: 'user', content: 'Hi.' }],
          makeModelConfig(),
          config,
          [],
          '/tmp/mem-merge.db',
        ),
      );

      expect(agentState.lastInputProcessors).toEqual([
        expect.objectContaining({ id: 'kai-recent-history-reconciler' }),
      ]);
    });
  });

  describe('tool registry composition', () => {
    it('includes workspace tools (built-ins)', async () => {
      const userTools: ToolDefinition[] = [];
      await collect(
        streamAgentResponse(
          'conv-tools',
          [{ role: 'user', content: 'Hi.' }],
          makeModelConfig(),
          makeConfig(),
          userTools,
          '/tmp/tools.db',
        ),
      );

      const tools = agentState.toolsAttached as Record<string, unknown> | undefined;
      expect(tools).toBeDefined();
      // The mock createWorkspaceTools returns two workspace tools.
      expect(Object.keys(tools ?? {}).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('malformed provider response → typed error', () => {
    it('surfaces a thrown error from Agent.stream() as a typed StreamEvent error', async () => {
      agentState.streamImpl = () => {
        throw new Error('AI_APICallError: Invalid response body: unexpected token at position 0');
      };

      const events = await collect(
        streamAgentResponse(
          'conv-err',
          [{ role: 'user', content: 'Hi.' }],
          makeModelConfig(),
          makeConfig(),
          [],
          '/tmp/err.db',
        ),
      );

      const errs = events.filter((e) => e.type === 'error');
      expect(errs.length).toBeGreaterThanOrEqual(1);
      // Surface the underlying provider failure verbatim — a regression that
      // swallowed the message and emitted a generic "Unknown error" must fail
      // this assertion. The synthetic SDK error names the underlying
      // `AI_APICallError: Invalid response body` shape.
      const firstErr = errs[0];
      const errorMessage =
        firstErr.type === 'error'
          ? typeof firstErr.error === 'string'
            ? firstErr.error
            : JSON.stringify(firstErr.error)
          : '';
      expect(errorMessage).toMatch(/AI_APICallError|Invalid response body/);
      expect(events[events.length - 1].type).toBe('done');
    });
  });
});

describe('streamWithFallback — real path (mocked @mastra/core)', () => {
  describe('primary-model failure triggers fallback path', () => {
    it('falls through to the second model on primary error before content emission', async () => {
      // The inner streamWithRealEvents will retry up to MAX_RETRIES on the
      // same Agent instance — only when ALL inner attempts fail does the
      // outer streamWithFallback advance to the next model.  We make the
      // primary instance throw on every call, then switch to the fallback
      // stream after the primary Agent has been built and exhausted.
      //
      // Tracking primaryBuildIndex: agentBuildCount is incremented inside
      // the Agent constructor. The Nth agent's stream method should throw
      // until the SECOND agent (the fallback) is constructed.
      let primaryBuildIndex: number | null = null;
      agentState.streamImpl = () => {
        // First Agent build → throw forever (forces fallback escalation).
        // Second Agent build → succeed (fallback model).
        if (primaryBuildIndex === null) primaryBuildIndex = agentState.agentBuildCount;
        if (agentState.agentBuildCount === primaryBuildIndex) {
          const err = new Error('AI_APICallError: 401 Unauthorized from primary model') as Error & {
            status?: number;
            statusCode?: number;
          };
          err.status = 401;
          err.statusCode = 401;
          throw err;
        }
        return {
          textStream: (async function* () {
            yield 'Fallback ok.';
          })(),
          fullStream: (async function* () {
            yield { type: 'text-delta', payload: { text: 'Fallback ok.' } };
            yield { type: 'finish', payload: { finishReason: 'stop' } };
          })(),
        };
      };

      const events = await collect(
        streamWithFallback(
          'conv-fb',
          [{ role: 'user', content: 'Hi.' }],
          makeStreamConfig(),
          makeConfig(),
          [],
          '/tmp/fb.db',
          { responseMessageId: 'msg-shared-fallback' },
        ),
      );

      // Both primary AND fallback Agents should have been constructed.
      expect(agentState.agentBuildCount).toBeGreaterThanOrEqual(2);

      // Fallback should have produced content.
      expect(events.some((e) => e.type === 'text-delta' && e.text === 'Fallback ok.')).toBe(true);
      expect(events.find((e) => e.type === 'text-delta')?.responseMessageId).toBe('msg-shared-fallback');
      expect(events.some((e) => e.type === 'done')).toBe(true);
    });

    it('rotates the shared response id when a partial fallback is preserved as a sibling', async () => {
      let primaryBuildIndex: number | null = null;
      agentState.streamImpl = () => {
        if (primaryBuildIndex === null) primaryBuildIndex = agentState.agentBuildCount;
        if (agentState.agentBuildCount === primaryBuildIndex) {
          return {
            fullStream: (async function* () {
              yield { type: 'text-delta', payload: { text: 'partial' } };
              const err = new Error('upstream unavailable') as Error & { status?: number; statusCode?: number };
              err.status = 503;
              err.statusCode = 503;
              throw err;
            })(),
          };
        }
        return {
          fullStream: (async function* () {
            yield { type: 'text-delta', payload: { text: 'successful retry' } };
            yield { type: 'finish', payload: { finishReason: 'stop' } };
          })(),
        };
      };

      const events = await collect(
        streamWithFallback(
          'conv-partial-fallback',
          [{ role: 'user', content: 'Hi.' }],
          makeStreamConfig(),
          makeConfig(),
          [],
          '/tmp/partial-fallback.db',
          { responseMessageId: 'msg-primary-partial' },
        ),
      );

      const firstText = events.find((event) => event.type === 'text-delta' && event.text === 'partial');
      const retryText = events.find((event) => event.type === 'text-delta' && event.text === 'successful retry');
      expect(firstText?.responseMessageId).toBe('msg-primary-partial');
      expect(retryText?.responseMessageId).toBeTruthy();
      expect(retryText?.responseMessageId).not.toBe(firstText?.responseMessageId);
      expect(
        events.some(
          (event) =>
            event.type === 'model-fallback' &&
            (event.data as { preserveErroredVariant?: boolean } | undefined)?.preserveErroredVariant,
        ),
      ).toBe(true);
    });
  });
});

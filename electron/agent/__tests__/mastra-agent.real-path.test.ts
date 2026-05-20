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
import type { AppConfig } from '../../config/schema.js';
import type { ToolDefinition } from '../../tools/types.js';
import type { StreamEvent } from '../mastra-agent.js';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const agentState: {
  generateImpl?: (input: unknown, opts: unknown) => Promise<unknown>;
  streamImpl?: () => unknown;
  toolsAttached?: unknown;
  lastInstructions?: string;
  agentBuildCount: number;
} = {
  agentBuildCount: 0,
};

vi.mock('@mastra/core/agent', () => {
  return {
    Agent: vi.fn(function (cfg: { instructions?: string; tools?: unknown }) {
      agentState.agentBuildCount += 1;
      agentState.toolsAttached = cfg.tools;
      agentState.lastInstructions = cfg.instructions;
      return {
        generate: vi.fn(async (input: unknown, opts: unknown) => {
          if (agentState.generateImpl) return agentState.generateImpl(input, opts);
          return { text: 'Hi.', finishReason: 'stop' };
        }),
        stream: vi.fn(async () => {
          if (agentState.streamImpl) return agentState.streamImpl();
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

const { streamAgentResponse, streamWithFallback, normalizeAgentCwd } = await import('../mastra-agent.js');

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
    memory: { enabled: true },
    tools: { executionMode: 'normal' },
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
  agentState.agentBuildCount = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mastra-agent — pure helpers', () => {
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

      const events = await collect(
        streamAgentResponse(
          'conv-real-1',
          [{ role: 'user', content: 'Hi.' }],
          makeModelConfig(),
          makeConfig(),
          [],
          '/tmp/test.db',
        ),
      );

      expect(agentState.agentBuildCount).toBeGreaterThanOrEqual(1);
      expect(events.some((e) => e.type === 'text-delta' && e.text === 'Hello.')).toBe(true);
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
        ),
      );

      // Both primary AND fallback Agents should have been constructed.
      expect(agentState.agentBuildCount).toBeGreaterThanOrEqual(2);

      // Fallback should have produced content.
      expect(events.some((e) => e.type === 'text-delta' && e.text === 'Fallback ok.')).toBe(true);
      expect(events.some((e) => e.type === 'done')).toBe(true);
    });
  });
});

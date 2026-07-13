/**
 * IPC handler tests for `electron/ipc/agent.ts`.
 *
 * Covers the lightweight approval / sub-agent channels exposed by
 * `registerAgentHandlers`. These do not need the full streaming pipeline,
 * so we can register them through `createIpcHarness` after mocking the
 * heavy production dependencies (Mastra, web-server, plugins, etc.).
 *
 * The `stubMastra` fixture self-tests live in
 * `test-utils/__tests__/runtime-stubs.test.ts` — they pin the fake-runtime
 * shape but do not exercise any agent.ts code path.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { createIpcHarness } from '../../../test-utils/ipc-harness.js';

// ---------------------------------------------------------------------------
// Mocks for the heavy production graph that `electron/ipc/agent.ts` pulls in.
//
// We are testing the simple approval / sub-agent handlers, not the streaming
// pipeline, so every dependency below is mocked with a minimal shape that
// keeps the import side-effects predictable.
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('../../web-server/web-clients.js', () => ({
  broadcastToWebClients: vi.fn(),
  webClients: new Set(),
}));

vi.mock('../../web-server/web-server.js', () => ({
  createLoginToken: vi.fn(() => 'token'),
}));

vi.mock('../../agent/model-catalog.js', () => ({
  resolveModelCatalog: vi.fn(() => ({ entries: [], defaultEntry: null })),
  resolveStreamConfig: vi.fn(() => null),
  resolveModelForThread: vi.fn(() => null),
}));

vi.mock('../../agent/mastra-agent.js', () => ({
  normalizeAgentCwd: vi.fn((cwd: string | undefined) => cwd ?? '/tmp'),
  streamAgentResponse: vi.fn(),
}));

vi.mock('../../agent/title-generation.js', () => ({
  generateTitle: vi.fn(async () => 'Test Title'),
}));

vi.mock('../../agent/runtime-switch.js', () => ({
  detectRuntimeSwitch: vi.fn(() => null),
  generateSwitchContext: vi.fn(async () => ''),
  wrapSwitchContext: vi.fn((ctx: string) => ctx),
}));

vi.mock('../../agent/compaction.js', () => ({
  shouldCompact: vi.fn(() => ({ shouldCompact: false })),
  compactConversationPrefix: vi.fn(async () => ({ compactedMessages: null })),
  compactToolResult: vi.fn(async (content: string) => ({ content, wasCompacted: false })),
  estimateToolTokens: vi.fn(() => 0),
}));

vi.mock('../../agent/tool-observer.js', () => ({
  ToolObserverManager: vi.fn(),
  resolveToolObserverConfig: vi.fn(() => ({})),
  summarizeLatestUserRequest: vi.fn(() => ''),
  summarizeThreadContext: vi.fn(() => ''),
}));

vi.mock('../../agent/runtime/index.js', () => ({
  resolveRuntimeForStream: vi.fn(async () => ({
    runtime: { id: 'mastra', name: 'Mastra', capabilities: {} },
    resolution: { runtimeId: 'mastra' },
  })),
  getAvailableRuntimes: vi.fn(async () => [{ id: 'mastra', name: 'Mastra', available: true }]),
  getActiveRuntimeId: vi.fn(async () => 'mastra'),
}));

vi.mock('../../tools/sub-agent.js', () => ({
  sendSubAgentFollowUp: vi.fn(() => true),
  sendSubAgentFollowUpByToolCall: vi.fn(() => true),
  stopSubAgent: vi.fn(() => true),
  getActiveSubAgentIds: vi.fn(() => ['sub-1', 'sub-2']),
}));

vi.mock('../../tools/naming.js', () => ({
  ensureSafeToolDefinitions: vi.fn((tools: unknown[]) => tools),
  findToolByName: vi.fn(() => null),
}));

vi.mock('../usage.js', () => ({
  recordUsageEvent: vi.fn(),
}));

vi.mock('../config.js', () => ({
  readEffectiveConfig: vi.fn(() => ({
    models: { defaultModelKey: 'placeholder', providers: {}, catalog: [] },
    profiles: [],
    defaultProfileKey: undefined,
    titleGeneration: { enabled: true },
  })),
}));

vi.mock('../conversations.js', () => ({
  broadcastUpsert: vi.fn(),
  ensureConversationTree: vi.fn((c: { messageTree?: unknown[]; headId?: string | null }) => ({
    tree: c.messageTree ?? [],
    headId: c.headId ?? null,
  })),
  getConversationBranch: vi.fn((tree: unknown[]) => tree),
}));
vi.mock('../conversation-store.js', () => ({
  readConversation: vi.fn(() => null),
  writeConversation: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports under test — must come after the mocks above so `vi.mock` rewrites
// the resolution before the production module loads.
// ---------------------------------------------------------------------------

import { registerAgentHandlers, __internal } from '../agent.js';
import { pendingToolApprovals } from '../tool-approval.js';
import { pendingQuestionAnswers } from '../../tools/ask-user.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Production handlers are registered with the signature
// `(event, ...args) => ...`. The harness passes args verbatim, so tests must
// supply an event placeholder as the first argument when invoking.
const FAKE_EVENT = Object.freeze({}) as unknown;

beforeEach(() => {
  pendingToolApprovals.clear();
  pendingQuestionAnswers.clear();
});

afterEach(() => {
  pendingToolApprovals.clear();
  pendingQuestionAnswers.clear();
});

// ---------------------------------------------------------------------------
// Approval-channel coverage
// ---------------------------------------------------------------------------

describe('agent IPC: tool approval channels', () => {
  it('resolves the pending approval promise with true on agent:approve-tool', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });

    const decisions: Array<boolean | 'dismiss'> = [];
    const pending = new Promise<boolean | 'dismiss'>((resolve) => {
      pendingToolApprovals.set('tc-approve', { resolve });
    }).then((value) => {
      decisions.push(value);
      return value;
    });

    const result = await harness.invoke<{ ok: boolean }>('agent:approve-tool', FAKE_EVENT, 'tc-approve');
    expect(result).toEqual({ ok: true });

    await pending;
    expect(decisions).toEqual([true]);
    expect(pendingToolApprovals.has('tc-approve')).toBe(false);
  });

  it('resolves the pending approval promise with false on agent:reject-tool', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });

    const decisions: Array<boolean | 'dismiss'> = [];
    const pending = new Promise<boolean | 'dismiss'>((resolve) => {
      pendingToolApprovals.set('tc-reject', { resolve });
    }).then((value) => {
      decisions.push(value);
      return value;
    });

    const result = await harness.invoke<{ ok: boolean }>('agent:reject-tool', FAKE_EVENT, 'tc-reject');
    expect(result).toEqual({ ok: true });

    await pending;
    expect(decisions).toEqual([false]);
    expect(pendingToolApprovals.has('tc-reject')).toBe(false);
  });

  it('resolves with the sentinel "dismiss" string on agent:dismiss-tool', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });

    const decisions: Array<boolean | 'dismiss'> = [];
    const pending = new Promise<boolean | 'dismiss'>((resolve) => {
      pendingToolApprovals.set('tc-dismiss', { resolve });
    }).then((value) => {
      decisions.push(value);
      return value;
    });

    await harness.invoke('agent:dismiss-tool', FAKE_EVENT, 'tc-dismiss');
    await pending;
    expect(decisions).toEqual(['dismiss']);
  });

  it('stores answers and approves the call on agent:answer-tool-question', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });

    const decisions: Array<boolean | 'dismiss'> = [];
    new Promise<boolean | 'dismiss'>((resolve) => {
      pendingToolApprovals.set('tc-ask', { resolve });
    }).then((value) => {
      decisions.push(value);
    });

    const answers = { q1: 'Yes please' };
    await harness.invoke('agent:answer-tool-question', FAKE_EVENT, 'tc-ask', answers);

    expect(pendingQuestionAnswers.get('tc-ask')).toEqual(answers);
    // Drain microtasks so the resolved promise's `.then` runs.
    await Promise.resolve();
    expect(decisions).toEqual([true]);
  });

  it('does NOT stash answers on agent:answer-tool-question when the toolCallId has no pending approval', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });

    // No pendingToolApprovals entry for this id (already dismissed/aborted).
    const result = await harness.invoke<{ ok: boolean }>('agent:answer-tool-question', FAKE_EVENT, 'tc-stale', {
      q1: 'ignored',
    });

    expect(result).toEqual({ ok: true });
    // Guard: a stale id must not leave an orphaned answers entry the terminated
    // tool will never read.
    expect(pendingQuestionAnswers.has('tc-stale')).toBe(false);
  });

  it('returns ok=true on agent:approve-tool when no pending entry exists', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });

    // No entry has been registered for "ghost". The handler should treat that
    // as a benign no-op so out-of-order renderer clicks do not crash the IPC.
    const result = await harness.invoke<{ ok: boolean }>('agent:approve-tool', FAKE_EVENT, 'ghost');
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Sub-agent inventory channel
// ---------------------------------------------------------------------------

describe('agent IPC: sub-agent channels', () => {
  it('returns the active sub-agent id list from agent:sub-agent-list', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });

    const result = await harness.invoke<{ ids: string[] }>('agent:sub-agent-list', FAKE_EVENT);
    expect(result).toEqual({ ids: ['sub-1', 'sub-2'] });
  });
});

// ---------------------------------------------------------------------------
// Runtime-stub contract tests now live in
// `test-utils/__tests__/runtime-stubs.test.ts` — they pin the fake-runtime
// fixture shape directly and do not need the agent.ts production graph
// loaded. Keeping them here would have inflated this file's stated scope
// (IPC handler coverage) with code that exercises only the fixture.
// ---------------------------------------------------------------------------

describe('extractLastUserText (mirror a GUI-driven turn to co-viewing clients)', () => {
  const { extractLastUserText } = __internal;

  it('returns the last user turn as plain text (string content)', () => {
    expect(
      extractLastUserText([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'how are you doing' },
      ]),
    ).toBe('how are you doing');
  });

  it('extracts + concatenates text parts from content-part array content', () => {
    expect(
      extractLastUserText([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what folder' },
            { type: 'image', image: 'x' },
          ],
        },
      ]),
    ).toBe('what folder [Image]');
  });

  it('returns the LAST user turn, not an earlier one', () => {
    expect(
      extractLastUserText([
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
      ]),
    ).toBe('second');
  });

  it('returns empty string when there is no user turn', () => {
    expect(extractLastUserText([{ role: 'assistant', content: 'hi' }])).toBe('');
    expect(extractLastUserText([])).toBe('');
  });
});

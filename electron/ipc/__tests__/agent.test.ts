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
import { z } from 'zod';

import { createIpcHarness } from '../../../test-utils/ipc-harness.js';
import type { ToolDefinition } from '../../tools/types.js';

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

// The dedicated approval window pulls ipcMain/screen from electron; stub it so
// this test's minimal electron mock doesn't need them.
vi.mock('../../approval-window.js', () => ({
  openApprovalWindow: vi.fn(),
  closeApprovalWindow: vi.fn(),
  closeAllApprovalWindows: vi.fn(),
  registerApprovalWindowIpc: vi.fn(),
  hasApprovalWindow: vi.fn(() => false),
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
  createWorkspaceToolDefinitions: vi.fn(async () => []),
  normalizeAgentCwd: vi.fn((cwd: string | undefined) => cwd ?? '/tmp'),
  streamAgentResponse: vi.fn(),
  WORKSPACE_MUTATING_TOOLS: new Set([
    'mastra_workspace_write_file',
    'mastra_workspace_edit_file',
    'mastra_workspace_delete',
    'mastra_workspace_execute_command',
  ]),
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

import { registerAgentHandlers, __internal, isSupersededRunEvent } from '../agent.js';
import { pendingToolApprovals } from '../tool-approval.js';
import { pendingQuestionAnswers } from '../../tools/ask-user.js';
import { closeApprovalWindow } from '../../approval-window.js';

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
    // Answering inline must also close the dedicated approval window (sync dismissal).
    expect(closeApprovalWindow).toHaveBeenCalledWith('tc-approve');
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
    expect(closeApprovalWindow).toHaveBeenCalledWith('tc-reject');
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
    expect(closeApprovalWindow).toHaveBeenCalledWith('tc-dismiss');
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

  it('STASHES answers on agent:answer-tool-question even when the toolCallId has no live pending approval (raced abort)', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });

    // No pendingToolApprovals entry: the turn's controller already aborted
    // (superseded / plan-restart) and settled+removed the approval a beat before
    // the user's fully-submitted answer landed. The OLD behavior dropped the
    // answer here, and the tool then emitted "No user response received" even
    // though the user answered. The answer must now be preserved so the gate /
    // re-invoked execute can recover it (bounded FIFO prevents a leak).
    const result = await harness.invoke<{ ok: boolean }>('agent:answer-tool-question', FAKE_EVENT, 'tc-raced', {
      q1: 'The answer I submitted',
    });

    expect(result).toEqual({ ok: true });
    expect(pendingQuestionAnswers.get('tc-raced')).toEqual({ q1: 'The answer I submitted' });
  });

  it('rejects a malformed answer frame from the untyped web boundary and stashes nothing (R132)', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });
    // A non-string toolCallId (e.g. a huge object used as the Map key) is rejected.
    const objId = await harness.invoke<{ ok: boolean; error?: string }>(
      'agent:answer-tool-question',
      FAKE_EVENT,
      { big: 'x'.repeat(10) } as unknown as string,
      { q: 'a' },
    );
    expect(objId.ok).toBe(false);
    expect(objId.error).toBe('invalid-tool-call-id');
    // Non-string answer values are rejected (not silently counted as 0 bytes downstream).
    const badVal = await harness.invoke<{ ok: boolean; error?: string }>(
      'agent:answer-tool-question',
      FAKE_EVENT,
      'tc-badval',
      { q: { nested: 'y' } } as unknown as Record<string, string>,
    );
    expect(badVal.ok).toBe(false);
    expect(badVal.error).toBe('invalid-answers');
    expect(pendingQuestionAnswers.has('tc-badval')).toBe(false);
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

describe('agent IPC: continuation authorization (single driver per turn)', () => {
  it('authorizes the first client per turn token and denies a second, resetting on a new token', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });
    const authorize = (clientId: string, turnToken: string) =>
      harness.invoke<{ authorized: boolean }>(
        'agent:authorize-continuation',
        FAKE_EVENT,
        'conv-auth',
        clientId,
        turnToken,
      );
    // Realistic stream tokens are `${Date.now()}-${rand}`; recency is compared by the ms prefix.
    const tok1 = '1000000000000-aaaa';
    const tok2 = '2000000000000-bbbb'; // strictly newer turn

    // First client wins this turn.
    expect((await authorize('clientA', tok1)).authorized).toBe(true);
    // A different client is DENIED for the same turn (no double-drive).
    expect((await authorize('clientB', tok1)).authorized).toBe(false);
    // The winner re-asking for the same turn is idempotently still authorized.
    expect((await authorize('clientA', tok1)).authorized).toBe(true);
    // A strictly NEWER turn supersedes — a different client can win it (e.g. the winner reloaded).
    expect((await authorize('clientB', tok2)).authorized).toBe(true);
    // Same (new) turn, other client → denied (single driver).
    expect((await authorize('clientA', tok2)).authorized).toBe(false);
    // A DELAYED request for the OLDER turn must NOT revoke the newer turn's winner.
    expect((await authorize('clientA', tok1)).authorized).toBe(false);
  });

  it('agent:finalize-gui-fallback returns confirmed:false when main holds no fallback for the conv', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });
    // No GUI fallback + no persistence accumulator for this conv → the caller must use its own
    // accumulator (confirmed:false), never a spurious confirmation off a stale disk head.
    const res = await harness.invoke<{ confirmed: boolean; headId: string | null }>(
      'agent:finalize-gui-fallback',
      FAKE_EVENT,
      'conv-no-fallback',
      'tok-x',
    );
    expect(res.confirmed).toBe(false);
    expect(res.headId).toBeNull();
  });
});

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

describe('observer workspace tool registry', () => {
  const tool = (name: string): ToolDefinition => ({
    name,
    description: name,
    inputSchema: z.any(),
    execute: vi.fn(async () => ({ ok: true })),
  });

  it('includes workspace tools that are intentionally outside the main registry', () => {
    const active = __internal.observerToolsForExecutionMode(
      [tool('web_search')],
      [tool('mastra_workspace_execute_command'), tool('mastra_workspace_list_files')],
      'auto',
    );

    expect(active.map((entry) => entry.name)).toEqual([
      'web_search',
      'mastra_workspace_execute_command',
      'mastra_workspace_list_files',
    ]);
  });

  it('keeps read-only workspace tools but removes shell execution in plan mode', () => {
    const active = __internal.observerToolsForExecutionMode(
      [tool('web_search'), tool('github')],
      [tool('mastra_workspace_execute_command'), tool('mastra_workspace_list_files')],
      'plan-first',
    );

    expect(active.map((entry) => entry.name)).toEqual(['web_search', 'mastra_workspace_list_files']);
  });
});

describe('cancel-generation ABA-safety (evicted-after-Stop must count as changed — R132)', () => {
  const { bumpExplicitCancelGeneration, captureCancelGeneration, cancelGenerationChanged } = __internal;

  it('a Stop after capture is detected as changed', () => {
    const captured = captureCancelGeneration('aba-conv-1'); // never Stopped → undefined
    expect(captured).toBeUndefined();
    bumpExplicitCancelGeneration('aba-conv-1'); // Stop
    expect(cancelGenerationChanged('aba-conv-1', captured)).toBe(true);
  });

  it('no Stop since capture is NOT changed', () => {
    bumpExplicitCancelGeneration('aba-conv-2');
    const captured = captureCancelGeneration('aba-conv-2'); // a positive sequence
    expect(captured).toBeGreaterThan(0);
    expect(cancelGenerationChanged('aba-conv-2', captured)).toBe(false);
  });

  it('an evicted-after-Stop entry re-reads as undefined and counts as CHANGED (no ABA to 0)', () => {
    bumpExplicitCancelGeneration('aba-conv-3'); // Stop → positive sequence
    const captured = captureCancelGeneration('aba-conv-3');
    expect(captured).toBeGreaterThan(0);
    // Simulate eviction under memory pressure: flood distinct ids past the 500 cap so the
    // oldest (aba-conv-3) is evicted. Its re-read is now undefined — which must NOT collide
    // with the captured positive sequence (the pre-R132 `?? 0` bug matched 0).
    for (let i = 0; i < 600; i++) bumpExplicitCancelGeneration(`flood-${i}`);
    expect(captureCancelGeneration('aba-conv-3')).toBeUndefined();
    expect(cancelGenerationChanged('aba-conv-3', captured)).toBe(true);
  });
});

describe('cancel-gen PUSH token (eviction-proof for run-starting deferred ops — R135)', () => {
  const { bumpExplicitCancelGeneration, registerCancelGenToken, releaseCancelGenToken } = __internal;

  it('a Stop flips a registered token even when the capture was undefined (never Stopped) AND the map entry is evicted', () => {
    // The R134 f-2 hole: capture undefined → Stop → evict → numeric re-read is undefined again.
    // The PUSH token catches it because the Stop flipped it directly.
    const token = registerCancelGenToken('push-conv-1'); // never Stopped at registration
    expect(token.cancelled).toBe(false);
    bumpExplicitCancelGeneration('push-conv-1'); // Stop → flips the token
    expect(token.cancelled).toBe(true);
    // Even after eviction of push-conv-1's map entry, the token stays cancelled.
    for (let i = 0; i < 600; i++) bumpExplicitCancelGeneration(`push-flood-${i}`);
    expect(token.cancelled).toBe(true);
    releaseCancelGenToken(token);
  });

  it('a token for a DIFFERENT conversation is not flipped by an unrelated Stop', () => {
    const token = registerCancelGenToken('push-conv-2');
    bumpExplicitCancelGeneration('push-conv-other');
    expect(token.cancelled).toBe(false);
    releaseCancelGenToken(token);
  });

  it('release removes the token so a later Stop no longer flips it', () => {
    const token = registerCancelGenToken('push-conv-3');
    releaseCancelGenToken(token);
    bumpExplicitCancelGeneration('push-conv-3');
    // The token object is detached from the registry; a Stop can't reach it.
    expect(token.cancelled).toBe(false);
  });
});

describe('reconcileExecutionMode (GUI submit vs MAIN-authoritative disk mode — R128/R129)', () => {
  const { reconcileExecutionMode } = __internal;

  it('trusts disk plan-first over a stale auto submit (never expose mutating tools)', () => {
    expect(reconcileExecutionMode('auto', 'plan-first', true)).toBe('plan-first');
    expect(reconcileExecutionMode(undefined, 'plan-first', true)).toBe('plan-first');
  });

  it('trusts disk auto over a stale plan-first submit (no latched plan-first — R129 f-3)', () => {
    // A stale plan-first renderer state must NOT pin the conversation plan-first forever
    // after a genuine plan→auto toggle already wrote disk 'auto'.
    expect(reconcileExecutionMode('plan-first', 'auto', true)).toBe('auto');
    expect(reconcileExecutionMode('plan-first', undefined, true)).toBe('auto');
  });

  it('falls back to the submit ONLY when there is no persisted record (recordless first turn)', () => {
    expect(reconcileExecutionMode('plan-first', undefined, false)).toBe('plan-first');
    expect(reconcileExecutionMode('auto', undefined, false)).toBe('auto');
    expect(reconcileExecutionMode(undefined, undefined, false)).toBe('auto');
  });
});

describe("isSupersededRunEvent (mid-turn inject: drop the aborted run's stale events)", () => {
  it('suppresses a token-stamped event whose token no longer matches the active run', () => {
    // The prior run (token A) was superseded by a new run (token B); A's trailing
    // deltas / stale `done` must be dropped so they can\'t concat or reset the UI.
    expect(isSupersededRunEvent('A', 'B')).toBe(true);
  });

  it("allows the current run's own events (token matches active)", () => {
    expect(isSupersededRunEvent('B', 'B')).toBe(false);
  });

  it('never suppresses an untagged event (automation/external/approval broadcast)', () => {
    expect(isSupersededRunEvent(undefined, 'B')).toBe(false);
  });

  it('does not treat events as stale when no run is active', () => {
    expect(isSupersededRunEvent('A', undefined)).toBe(false);
    expect(isSupersededRunEvent(undefined, undefined)).toBe(false);
  });
});

describe('resolveInjectedTextFromGatedPayload (mid-turn inject enforcement)', () => {
  const { resolveInjectedTextFromGatedPayload } = __internal;

  it('returns the surviving user turn text (string content)', () => {
    const res = resolveInjectedTextFromGatedPayload([{ role: 'user', content: 'redacted answer' }]);
    expect(res).toEqual({ allowed: true, text: 'redacted answer' });
  });

  it('extracts text from a single content-part user message (redacting hook rewrote parts)', () => {
    const res = resolveInjectedTextFromGatedPayload([
      { role: 'user', content: [{ type: 'text', text: '[redacted]' }] },
    ]);
    expect(res).toEqual({ allowed: true, text: '[redacted]' });
  });

  it('denies when a hook REMOVED the user turn (payload is not a single user message)', () => {
    const res = resolveInjectedTextFromGatedPayload([{ role: 'assistant', content: 'only assistant left' }]);
    expect(res).toEqual({ allowed: false, text: '' });
  });

  it('denies when a hook ADDED extra messages (can’t splice added context as one inject)', () => {
    // A modify hook returned a system safety message + the rewritten user turn.
    // We can’t represent that as a single user-text inject → fail closed.
    const res = resolveInjectedTextFromGatedPayload([
      { role: 'system', content: 'SAFETY: redacted per policy' },
      { role: 'user', content: [{ type: 'text', text: 'answer' }] },
    ]);
    expect(res).toEqual({ allowed: false, text: '' });
  });

  it('denies when a hook redacts the message to EMPTY text (string or parts)', () => {
    expect(resolveInjectedTextFromGatedPayload([{ role: 'user', content: '' }])).toEqual({ allowed: false, text: '' });
    expect(resolveInjectedTextFromGatedPayload([{ role: 'user', content: '   ' }])).toEqual({
      allowed: false,
      text: '',
    });
    expect(resolveInjectedTextFromGatedPayload([{ role: 'user', content: [{ type: 'text', text: '' }] }])).toEqual({
      allowed: false,
      text: '',
    });
  });

  it('denies on an empty payload', () => {
    expect(resolveInjectedTextFromGatedPayload([])).toEqual({ allowed: false, text: '' });
  });

  it('preserves multiline / spacing-sensitive text VERBATIM (no whitespace collapse)', () => {
    const code = 'def f():\n    x = 1\n\n    return  x   # two spaces';
    const res = resolveInjectedTextFromGatedPayload([{ role: 'user', content: [{ type: 'text', text: code }] }]);
    expect(res).toEqual({ allowed: true, text: code });
  });

  it('concatenates multiple text parts verbatim', () => {
    const res = resolveInjectedTextFromGatedPayload([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'line1\n' },
          { type: 'text', text: 'line2' },
        ],
      },
    ]);
    expect(res).toEqual({ allowed: true, text: 'line1\nline2' });
  });

  it('denies when the surviving turn has a non-text part (hook rewrote to media/file)', () => {
    const res = resolveInjectedTextFromGatedPayload([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', image: 'data:...' },
        ],
      },
    ]);
    expect(res).toEqual({ allowed: false, text: '' });
  });

  describe('with history context (historyLen > 0)', () => {
    it('extracts ONLY the injected turn (last message) after N history messages', () => {
      // The gate ran hooks over [history…, injectedUser]; extract the last turn.
      const res = resolveInjectedTextFromGatedPayload(
        [
          { role: 'user', content: 'first prompt' },
          { role: 'assistant', content: 'a reply' },
          { role: 'user', content: [{ type: 'text', text: 'the injected answer' }] },
        ],
        2,
      );
      expect(res).toEqual({ allowed: true, text: 'the injected answer' });
    });

    it('denies when a hook ADDED a message AFTER the injected turn (payload too long)', () => {
      const res = resolveInjectedTextFromGatedPayload(
        [
          { role: 'user', content: 'first prompt' },
          { role: 'user', content: [{ type: 'text', text: 'answer' }] },
          { role: 'system', content: 'SAFETY appended' },
        ],
        1,
      );
      expect(res).toEqual({ allowed: false, text: '' });
    });

    it('denies when a hook REMOVED the injected turn (payload too short)', () => {
      const res = resolveInjectedTextFromGatedPayload([{ role: 'user', content: 'first prompt' }], 1);
      expect(res).toEqual({ allowed: false, text: '' });
    });

    it('denies when the message at the injected index is not a user turn', () => {
      const res = resolveInjectedTextFromGatedPayload(
        [
          { role: 'user', content: 'first prompt' },
          { role: 'assistant', content: 'hook replaced the inject with an assistant turn' },
        ],
        1,
      );
      expect(res).toEqual({ allowed: false, text: '' });
    });
  });
});

describe('isSupersessionDescendant (raced-answer handoff lineage guard — R81/R115)', () => {
  const { recordSupersession, isSupersessionDescendant } = __internal;

  it('follows a recorded supersession chain (A→B→C) but rejects unrelated tokens', () => {
    recordSupersession('A', 'B');
    recordSupersession('B', 'C');
    // C genuinely superseded A through the chain.
    expect(isSupersessionDescendant('A', 'C')).toBe(true);
    expect(isSupersessionDescendant('A', 'B')).toBe(true);
    // D never entered A's chain — an unrelated later turn must NOT inherit A's answer.
    expect(isSupersessionDescendant('A', 'D')).toBe(false);
    // Reverse direction is not a descendant.
    expect(isSupersessionDescendant('C', 'A')).toBe(false);
  });

  it('returns false when there is no recorded edge (a successor that died before admission)', () => {
    // 'X' was issued as latest but its supersession edge was never recorded (config
    // threw before stream admission), so a predecessor teardown must NOT treat it as a
    // live replacement — the R115 guard falls through to durable recovery.
    expect(isSupersessionDescendant('pred-no-edge', 'X')).toBe(false);
  });

  it('does not infinite-loop on a supersession cycle (corrupt lineage)', () => {
    recordSupersession('cyc1', 'cyc2');
    recordSupersession('cyc2', 'cyc1');
    // Cycle-guarded: terminates and does not match an unrelated token.
    expect(isSupersessionDescendant('cyc1', 'nope')).toBe(false);
    // Still finds a real descendant within the cycle.
    expect(isSupersessionDescendant('cyc1', 'cyc2')).toBe(true);
  });
});

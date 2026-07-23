import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  Notification: class {
    static shown: Array<{ title: string; body?: string }> = [];
    constructor(private opts: { title: string; body?: string }) {}
    show() {
      (this.constructor as typeof this.constructor & { shown: unknown[] }).shown.push(this.opts);
    }
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../utils/window-send.js', () => ({ broadcastToAllWindows: () => 0 }));
vi.mock('../../web-server/web-clients.js', () => ({ broadcastToWebClients: () => {} }));
vi.mock('../../ipc/agent.js', () => ({ broadcastAgentStreamEvent: vi.fn() }));
vi.mock('../../agent/plugin-generate.js', () => ({
  generateForPlugin: vi.fn(async () => ({ text: 'AGENT SAYS HI', modelKey: 'test', toolCalls: [] })),
  // Conversation-mode runs stream; yield a text delta then done carrying modelKey.
  streamForPlugin: vi.fn(async function* () {
    yield { type: 'text-delta', text: 'AGENT SAYS HI' };
    yield { type: 'done', modelKey: 'test' };
  }),
}));

type MockStore = {
  conversations: Record<string, Record<string, unknown>>;
  activeConversationId: string | null;
  settings: Record<string, unknown>;
};
const mockStore: MockStore = { conversations: {}, activeConversationId: null, settings: {} };
const resetMockStore = (convs: MockStore['conversations'] = {}) => {
  mockStore.conversations = convs;
  mockStore.activeConversationId = null;
};
vi.mock('../../ipc/conversations.js', () => ({
  broadcastUpsert: vi.fn(),
  appendConversationMessages: vi.fn(
    (
      _home: string,
      id: string,
      msgs: Array<{ role: string; content: unknown }>,
      opts?: { skipIfBusy?: boolean; runStatus?: string },
    ) => {
      const conv = mockStore.conversations[id];
      if (!conv) return null;
      if (opts?.skipIfBusy && (conv.runStatus === 'running' || conv.runStatus === 'awaiting-approval')) return null;
      // Simulate append: grow the tree + advance headId so follow-up reads (the
      // assistant turn parents off the just-written user turn) see the new head.
      const tree = (conv.messageTree as unknown[]) ?? [];
      const appended = msgs.map((m, i) => ({ id: `mock-${id}-${tree.length + i}`, ...m }));
      conv.messageTree = [...tree, ...appended];
      conv.headId = appended[appended.length - 1]?.id ?? conv.headId ?? null;
      if (opts?.runStatus !== undefined) conv.runStatus = opts.runStatus;
      return conv;
    },
  ),
  ensureConversationTree: vi.fn((c: { messageTree?: unknown[]; headId?: string | null }) => ({
    tree: c.messageTree ?? [],
    headId: c.headId ?? null,
  })),
  getConversationBranch: vi.fn((tree: unknown[]) => tree),
}));
vi.mock('../../ipc/agent.js', () => ({ broadcastAgentStreamEvent: vi.fn() }));
vi.mock('../../ipc/conversation-store.js', () => ({
  readIndex: vi.fn(() => ({
    conversations: mockStore.conversations,
    activeConversationId: mockStore.activeConversationId,
    settings: mockStore.settings,
  })),
  readConversation: vi.fn((_home: string, id: string) => mockStore.conversations[id] ?? null),
  // createAutomationConversation writes the new shell conversation through this.
  writeConversation: vi.fn((_home: string, conv: { id: string }) => {
    mockStore.conversations[conv.id] = conv as Record<string, unknown>;
  }),
}));

import type { AutomationConversationTarget, AutomationRule } from '../../config/schema.js';
import { executeActions, interpolateString, resumeConversationWithMessage, type ActionDeps } from '../actions.js';
import { AutomationEventBus } from '../event-bus.js';
import { generateForPlugin, streamForPlugin } from '../../agent/plugin-generate.js';
import { appendConversationMessages } from '../../ipc/conversations.js';
import { writeConversation } from '../../ipc/conversation-store.js';
import { hasInjects, clearInjects, drainInjects, enqueueInject } from '../../agent/inject-queue.js';

function rule(actions: AutomationRule['actions']): AutomationRule {
  return {
    id: 'r1',
    name: 'test',
    enabled: true,
    trigger: { source: 'plugin.teams', event: 'message-received' },
    conditions: [],
    conditionMode: 'all',
    actions,
    debounceMs: 0,
  };
}

function deps(over: Partial<ActionDeps> = {}): ActionDeps {
  return {
    bus: new AutomationEventBus(),
    appHome: '/tmp/kai-test',
    getConfig: () => ({}) as never,
    getRegisteredTools: () => [],
    getWorkspaceTools: () => [],
    handlePluginAction: vi.fn(async () => ({ ok: true })),
    ...over,
  };
}

const evt = {
  key: 'plugin.teams:message-received',
  source: 'plugin.teams',
  event: 'message-received',
  payload: { from: { email: 'boss@corp' }, body: 'urgent: review' },
  ts: Date.now(),
  depth: 0,
};

describe('interpolateString', () => {
  it('replaces payload paths', () => {
    expect(
      interpolateString('from {{payload.from.email}}: {{payload.body}}', { payload: evt.payload, result: [] }),
    ).toBe('from boss@corp: urgent: review');
  });
  it('replaces result indices', () => {
    expect(interpolateString('{{result[0].text}}', { payload: {}, result: [{ text: 'x' }] })).toBe('x');
  });
  it('missing path → empty string', () => {
    expect(interpolateString('[{{payload.nope}}]', { payload: {}, result: [] })).toBe('[]');
  });
  it('exposes source and event from the trigger', () => {
    expect(
      interpolateString('{{source}}:{{event}}', {
        payload: {},
        result: [],
        source: 'plugin.msgraph',
        event: 'message-received',
      }),
    ).toBe('plugin.msgraph:message-received');
  });

  it('leaves an over-long template literal (avoids the quadratic regex scan)', () => {
    // 20 KiB of unmatched `{{` would be quadratic to scan; the cap returns it as-is.
    const huge = '{{'.repeat(10_000); // 20 000 chars > 16 KiB cap
    const started = Date.now();
    const out = interpolateString(huge, { payload: {}, result: [] });
    expect(Date.now() - started).toBeLessThan(500);
    expect(out).toBe(huge); // returned literal, not scanned
  });

  it('caps a single interpolated value so a huge payload field cannot inflate output', () => {
    const big = 'x'.repeat(50 * 1024); // 50 KiB value > 32 KiB cap
    const out = interpolateString('{{payload.v}}', { payload: { v: big }, result: [] });
    expect(out.length).toBe(32 * 1024);
  });
});

describe('executeActions source/event interpolation', () => {
  it('passes trigger source and event into tool input templates', async () => {
    const captured: unknown[] = [];
    const tool = {
      name: 'log-tool',
      description: 't',
      parameters: {} as never,
      execute: async (input: unknown) => {
        captured.push(input);
        return { ok: true };
      },
    };
    await executeActions(
      rule([{ type: 'tool', toolName: 'log-tool', input: { line: '{{source}} {{event}}' } }]),
      evt,
      deps({ getWorkspaceTools: () => [tool] as never }),
    );
    expect(captured[0]).toEqual({ line: 'plugin.teams message-received' });
  });
});

describe('executeActions', () => {
  it('plugin-action interpolates data and pushes result', async () => {
    const handle = vi.fn(async (p) => ({ echoed: p.data }));
    const rec = await executeActions(
      rule([
        {
          type: 'plugin-action',
          pluginName: 'teams',
          targetId: 'reply',
          action: 'send',
          data: { text: 'RE: {{payload.body}}' },
        },
      ]),
      evt,
      deps({ handlePluginAction: handle }),
    );
    expect(handle).toHaveBeenCalledWith({
      pluginName: 'teams',
      targetId: 'reply',
      action: 'send',
      data: { text: 'RE: urgent: review' },
    });
    expect(rec.results[0].ok).toBe(true);
    expect(rec.matched).toBe(true);
  });

  it('agent background then plugin-action can reference result', async () => {
    const handle = vi.fn(async (p) => p.data);
    const rec = await executeActions(
      rule([
        {
          type: 'agent',
          mode: 'background',
          prompt: 'reply to: {{payload.body}}',
          tools: false,
          conversationTarget: { type: 'per-invocation' },
          includeHistory: true,
          onBusyTarget: 'inject',
        },
        {
          type: 'plugin-action',
          pluginName: 'teams',
          targetId: 'reply',
          action: 'send',
          data: { text: '{{result[0].text}}' },
        },
      ]),
      evt,
      deps({ handlePluginAction: handle }),
    );
    expect(rec.results).toHaveLength(2);
    expect(rec.results[0].output).toMatchObject({ text: 'AGENT SAYS HI' });
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ data: { text: 'AGENT SAYS HI' } }));
  });

  it('plugin-action {error} response is treated as failure', async () => {
    const rec = await executeActions(
      rule([{ type: 'plugin-action', pluginName: 'gone', targetId: 't', action: 'a' }]),
      evt,
      deps({ handlePluginAction: async () => ({ error: 'Plugin is not active' }) }),
    );
    expect(rec.results[0].ok).toBe(false);
    expect(rec.results[0].error).toMatch(/not active/);
  });

  it('failing action records error but continues', async () => {
    const rec = await executeActions(
      rule([
        { type: 'tool', toolName: 'does-not-exist', input: {} },
        { type: 'notification', title: 'still runs' },
      ]),
      evt,
      deps(),
    );
    expect(rec.results[0].ok).toBe(false);
    expect(rec.results[0].error).toMatch(/not found/i);
    expect(rec.results[1].ok).toBe(true);
    expect(rec.error).toBeTruthy();
  });

  it('emit action increments depth', async () => {
    const bus = new AutomationEventBus();
    const seen: number[] = [];
    bus.subscribe((e) => seen.push(e.depth));
    await executeActions(rule([{ type: 'emit', source: 'x', event: 'y' }]), evt, deps({ bus }));
    expect(seen).toEqual([1]);
  });
});

describe('agent conversationTarget', () => {
  const agentAction = (target: AutomationConversationTarget, includeHistory = true) =>
    rule([
      {
        type: 'agent',
        mode: 'conversation',
        prompt: 'do the thing',
        tools: false,
        conversationTarget: target,
        includeHistory,
        onBusyTarget: 'inject',
      },
    ]);

  beforeEach(() => {
    resetMockStore();
    vi.mocked(writeConversation).mockClear();
    vi.mocked(appendConversationMessages).mockClear();
    vi.mocked(generateForPlugin).mockClear();
    vi.mocked(streamForPlugin).mockReset();
    vi.mocked(streamForPlugin).mockImplementation(async function* () {
      yield { type: 'text-delta', text: 'AGENT SAYS HI' } as never;
      yield { type: 'done', modelKey: 'test' } as never;
    });
  });

  it('per-invocation creates a shell (automationSingleton=false) then writes prompt + assistant', async () => {
    await executeActions(agentAction({ type: 'per-invocation' }), evt, deps());
    const conv = vi.mocked(writeConversation).mock.calls[0][1] as unknown as Record<string, unknown>;
    expect((conv.metadata as Record<string, unknown>).automationSingleton).toBe(false);
    // User prompt is written first (running), assistant second (idle).
    expect(appendConversationMessages).toHaveBeenNthCalledWith(
      1,
      '/tmp/kai-test',
      conv.id,
      [expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'do the thing' }] })],
      expect.objectContaining({ runStatus: 'running' }),
    );
    expect(appendConversationMessages).toHaveBeenNthCalledWith(
      2,
      '/tmp/kai-test',
      conv.id,
      [expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: 'AGENT SAYS HI' }] })],
      expect.objectContaining({ runStatus: 'idle' }),
    );
  });

  it('busy target (existing or singleton) diverts before generation, skipping history', async () => {
    resetMockStore({
      convA: {
        id: 'convA',
        messageTree: [{ id: 'x', parentId: null, role: 'user', content: 'secret', createdAt: 'x' }],
        headId: 'x',
        metadata: {},
        runStatus: 'running',
      },
    });
    await executeActions(agentAction({ type: 'existing', conversationId: 'convA' }, true), evt, deps());
    // History from the busy target must NOT be passed to the model
    expect(vi.mocked(streamForPlugin).mock.calls.at(-1)![0].messages).toEqual([
      { role: 'user', content: 'do the thing' },
    ]);
    const [, divertedId] = vi.mocked(appendConversationMessages).mock.calls.at(-1) as [string, string, unknown[]];
    expect(divertedId).not.toBe('convA');
  });

  it('busy existing target diverts to a fresh conversation (never writes to the busy one)', async () => {
    resetMockStore({
      convA: { id: 'convA', messageTree: [], headId: null, metadata: {}, runStatus: 'running' },
    });
    const rec = await executeActions(agentAction({ type: 'existing', conversationId: 'convA' }), evt, deps());
    const divertedId = (rec.results[0].output as { conversationId: string }).conversationId;
    expect(divertedId).not.toBe('convA');
    for (const call of vi.mocked(appendConversationMessages).mock.calls) {
      expect(call[1]).not.toBe('convA');
    }
  });

  it('busy existing target INJECTS mid-turn when a helper is bound (no divert, no streamForPlugin)', async () => {
    resetMockStore({
      convA: { id: 'convA', messageTree: [], headId: null, metadata: {}, runStatus: 'running' },
    });
    const injectUserTurnAndRestart = vi.fn(async () => ({ ok: true }));
    const rec = await executeActions(
      agentAction({ type: 'existing', conversationId: 'convA' }),
      evt,
      deps({ injectUserTurnAndRestart }),
    );
    // Injected into the busy conversation, NOT diverted to a new one.
    expect(injectUserTurnAndRestart).toHaveBeenCalledTimes(1);
    const injectCall = injectUserTurnAndRestart.mock.calls.at(-1) as unknown as [string, string, ...unknown[]];
    expect(injectCall[0]).toBe('convA');
    expect(injectCall[1]).toBe('do the thing');
    expect((rec.results[0].output as { injectedInto: string }).injectedInto).toBe('convA');
    // Must NOT have gone through the normal streamForPlugin / append path.
    expect(streamForPlugin).not.toHaveBeenCalled();
    expect(appendConversationMessages).not.toHaveBeenCalled();
  });

  it('records a FAILED action (not success) when mid-turn injection fails', async () => {
    resetMockStore({
      convA: { id: 'convA', messageTree: [], headId: null, metadata: {}, runStatus: 'running' },
    });
    const injectUserTurnAndRestart = vi.fn(async () => ({ ok: false, error: 'conversation-not-found' }));
    const rec = await executeActions(
      agentAction({ type: 'existing', conversationId: 'convA' }),
      evt,
      deps({ injectUserTurnAndRestart }),
    );
    // The action result must be marked failed (ok:false), carrying the error —
    // NOT recorded as a success (which would silently lose e.g. an alert answer).
    expect(rec.results[0].ok).toBe(false);
    expect(String(rec.results[0].error ?? '')).toMatch(/injection into convA failed|conversation-not-found/);
  });

  it('busy existing target with onBusyTarget:"divert" still diverts even when a helper is bound', async () => {
    resetMockStore({
      convA: { id: 'convA', messageTree: [], headId: null, metadata: {}, runStatus: 'running' },
    });
    const injectUserTurnAndRestart = vi.fn(async () => ({ ok: true }));
    const action = agentAction({ type: 'existing', conversationId: 'convA' });
    (action.actions[0] as { onBusyTarget?: string }).onBusyTarget = 'divert';
    const rec = await executeActions(action, evt, deps({ injectUserTurnAndRestart }));
    expect(injectUserTurnAndRestart).not.toHaveBeenCalled();
    const divertedId = (rec.results[0].output as { conversationId: string }).conversationId;
    expect(divertedId).not.toBe('convA');
  });

  it('idle existing target is unaffected by inject (normal append path)', async () => {
    resetMockStore({
      convA: { id: 'convA', messageTree: [], headId: null, metadata: {}, runStatus: 'idle' },
    });
    const injectUserTurnAndRestart = vi.fn(async () => ({ ok: true }));
    await executeActions(
      agentAction({ type: 'existing', conversationId: 'convA' }),
      evt,
      deps({ injectUserTurnAndRestart }),
    );
    expect(injectUserTurnAndRestart).not.toHaveBeenCalled();
    // Normal path writes the user turn to convA (exactly one append in this path).
    const [, appendedId] = vi.mocked(appendConversationMessages).mock.calls.at(-1) as [string, string, unknown[]];
    expect(appendedId).toBe('convA');
  });

  it('busy target held by an in-flight AUTOMATION run injects COOPERATIVELY (enqueue, no abort/restart)', async () => {
    // An in-flight automation run is always Mastra (steppable), so a second
    // automation targeting it must enqueue for prepareStep to splice mid-turn —
    // NOT abort+restart. Gate streamForPlugin so the first run stays in-flight
    // while the second fires.
    clearInjects('convCoop');
    resetMockStore({
      convCoop: { id: 'convCoop', messageTree: [], headId: null, metadata: {}, runStatus: 'idle' },
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(streamForPlugin).mockImplementationOnce(async function* () {
      yield { type: 'text-delta', text: 'partial…' } as never;
      await gate; // keep the first run in-flight
      yield { type: 'done', modelKey: 'test' } as never;
    });
    const injectUserTurnAndRestart = vi.fn(async () => ({ ok: true }));
    const d = deps({ injectUserTurnAndRestart });

    // First run — do NOT await; it blocks on the gate, staying in-flight.
    const first = executeActions(agentAction({ type: 'existing', conversationId: 'convCoop' }), evt, d);
    // Wait until the first run is actually streaming (has written its user turn).
    await vi.waitFor(() => {
      const wrote = vi.mocked(appendConversationMessages).mock.calls.some((c) => c[1] === 'convCoop');
      if (!wrote) throw new Error('first run not in-flight yet');
    });

    // Second automation targets the same, still-running conversation.
    await executeActions(agentAction({ type: 'existing', conversationId: 'convCoop' }), evt, d);

    // Cooperative: enqueued for prepareStep, NOT routed through abort+restart.
    expect(injectUserTurnAndRestart).not.toHaveBeenCalled();
    expect(hasInjects('convCoop')).toBe(true);
    expect(drainInjects('convCoop').map((q) => q.text)).toContain('do the thing');

    release();
    await first;
  });

  it('drain-at-end: a stranded inject (queued at turn end) triggers one continuation turn', async () => {
    // Simulate a mid-turn inject that arrived AFTER the final step boundary:
    // enqueue during the FIRST run's stream, so it's still queued when the turn
    // ends. The turn-end drain should fire exactly one continuation turn (a
    // second streamForPlugin) and drain the queue.
    clearInjects('convDrain');
    resetMockStore({
      convDrain: { id: 'convDrain', messageTree: [], headId: null, metadata: {}, runStatus: 'idle' },
    });
    let calls = 0;
    vi.mocked(streamForPlugin).mockImplementation(async function* () {
      calls += 1;
      if (calls === 1) {
        // First (main) turn: a follow-up lands after the last step boundary.
        enqueueInject('convDrain', 'stranded follow-up');
      }
      yield { type: 'text-delta', text: `reply ${calls}` } as never;
      yield { type: 'done', modelKey: 'test' } as never;
    });

    await executeActions(agentAction({ type: 'existing', conversationId: 'convDrain' }), evt, deps());

    // Exactly one continuation turn ran (2 total), and the queue was drained.
    expect(calls).toBe(2);
    expect(hasInjects('convDrain')).toBe(false);
    // The stranded inject must be PERSISTED as a user turn before the
    // continuation (otherwise the model never sees it and the UI message
    // vanishes). It's no longer written at enqueue time.
    const persistedStranded = vi
      .mocked(appendConversationMessages)
      .mock.calls.some(
        (call) =>
          call[1] === 'convDrain' &&
          (call[2] as Array<{ role: string; content: Array<{ text?: string }> }>).some(
            (message) => message.role === 'user' && message.content?.[0]?.text === 'stranded follow-up',
          ),
      );
    expect(persistedStranded).toBe(true);
    // Restore the shared default streaming impl for any later test.
    vi.mocked(streamForPlugin).mockImplementation(async function* () {
      yield { type: 'text-delta', text: 'AGENT SAYS HI' } as never;
      yield { type: 'done', modelKey: 'test' } as never;
    });
  });

  it('re-enqueues an inject when boundary persistence fails, so it still lands via drain-at-end', async () => {
    clearInjects('convBoundaryFail');
    resetMockStore({
      convBoundaryFail: { id: 'convBoundaryFail', messageTree: [], headId: null, metadata: {}, runStatus: 'idle' },
    });
    // First streamForPlugin run: emit some text, enqueue an inject, then invoke
    // the boundary callback via a second yielded step. Make the FIRST append that
    // the boundary attempts (partial assistant) throw once to simulate an
    // unserializable tool result; the entry must be re-enqueued and persisted by
    // the drain-at-end continuation instead of being lost.
    let calls = 0;
    vi.mocked(streamForPlugin).mockImplementation(function (opts: unknown) {
      const onInjected = (opts as { onInjected?: (e: Array<{ id: string; text: string; at: number }>) => void })
        .onInjected;
      return (async function* () {
        calls += 1;
        if (calls === 1) {
          yield { type: 'text-delta', text: 'partial before inject' } as never;
          onInjected?.([{ id: 'inj-x', text: 'boundary follow-up', at: Date.now() }]);
        }
        yield { type: 'done', modelKey: 'test' } as never;
      })();
    } as never);
    let throwOnce = true;
    vi.mocked(appendConversationMessages).mockImplementation(((
      _home: string,
      id: string,
      msgs: Array<{ role: string; content: unknown }>,
      o?: { runStatus?: string },
    ) => {
      const isPartialAssistant = msgs.length === 1 && msgs[0].role === 'assistant' && o?.runStatus === 'running';
      if (throwOnce && isPartialAssistant && id === 'convBoundaryFail') {
        throwOnce = false;
        throw new Error('unserializable tool result');
      }
      const conv = mockStore.conversations[id];
      if (!conv) return null;
      const tree = (conv.messageTree as unknown[]) ?? [];
      const appended = msgs.map((m, i) => ({ id: `mock-${id}-${tree.length + i}`, ...m }));
      conv.messageTree = [...tree, ...appended];
      conv.headId = appended[appended.length - 1]?.id ?? conv.headId ?? null;
      if (o?.runStatus !== undefined) conv.runStatus = o.runStatus;
      return conv;
    }) as never);

    await executeActions(agentAction({ type: 'existing', conversationId: 'convBoundaryFail' }), evt, deps()).catch(
      () => {},
    );

    expect(hasInjects('convBoundaryFail')).toBe(false);
    const persisted = vi
      .mocked(appendConversationMessages)
      .mock.calls.some(
        (call) =>
          call[1] === 'convBoundaryFail' &&
          (call[2] as Array<{ role: string; content: Array<{ text?: string }> }>).some(
            (m) => m.role === 'user' && m.content?.[0]?.text === 'boundary follow-up',
          ),
      );
    expect(persisted).toBe(true);

    // Restore shared mocks.
    vi.mocked(streamForPlugin).mockImplementation(async function* () {
      yield { type: 'text-delta', text: 'AGENT SAYS HI' } as never;
      yield { type: 'done', modelKey: 'test' } as never;
    });
    vi.mocked(appendConversationMessages).mockImplementation(((
      _home: string,
      id: string,
      msgs: Array<{ role: string; content: unknown }>,
      o?: { skipIfBusy?: boolean; runStatus?: string },
    ) => {
      const conv = mockStore.conversations[id];
      if (!conv) return null;
      if (o?.skipIfBusy && (conv.runStatus === 'running' || conv.runStatus === 'awaiting-approval')) return null;
      const tree = (conv.messageTree as unknown[]) ?? [];
      const appended = msgs.map((m, i) => ({ id: `mock-${id}-${tree.length + i}`, ...m }));
      conv.messageTree = [...tree, ...appended];
      conv.headId = appended[appended.length - 1]?.id ?? conv.headId ?? null;
      if (o?.runStatus !== undefined) conv.runStatus = o.runStatus;
      return conv;
    }) as never);
  });

  it('drops pre-injection text on a model fallback (result reflects the successful retry only)', async () => {
    clearInjects('convFb');
    resetMockStore({
      convFb: { id: 'convFb', messageTree: [], headId: null, metadata: {}, runStatus: 'idle' },
    });
    vi.mocked(streamForPlugin).mockImplementationOnce(async function* () {
      yield { type: 'text-delta', text: 'failed-prefix' } as never;
      yield { type: 'model-fallback', modelKey: 'fallback' } as never;
      yield { type: 'text-delta', text: 'good-answer' } as never;
      yield { type: 'done', modelKey: 'fallback' } as never;
    });

    const rec = await executeActions(agentAction({ type: 'existing', conversationId: 'convFb' }), evt, deps());
    expect(rec.results[0].output).toMatchObject({ text: 'good-answer' });

    vi.mocked(streamForPlugin).mockImplementation(async function* () {
      yield { type: 'text-delta', text: 'AGENT SAYS HI' } as never;
      yield { type: 'done', modelKey: 'test' } as never;
    });
  });

  it('persists a queued inject onto the branch even when the turn stream fails', async () => {
    clearInjects('convFail');
    resetMockStore({
      convFail: { id: 'convFail', messageTree: [], headId: null, metadata: {}, runStatus: 'idle' },
    });
    // Enqueue mid-stream, then throw before another prepareStep consumes it. The
    // finally block must still persist the queued user turn (not lose it or leave
    // it queued for an unrelated future turn).
    vi.mocked(streamForPlugin).mockImplementationOnce(async function* () {
      enqueueInject('convFail', 'inject before failure');
      yield { type: 'text-delta', text: 'partial' } as never;
      throw new Error('stream exploded');
    });

    await executeActions(agentAction({ type: 'existing', conversationId: 'convFail' }), evt, deps()).catch(() => {});

    expect(hasInjects('convFail')).toBe(false);
    const persisted = vi
      .mocked(appendConversationMessages)
      .mock.calls.some(
        (call) =>
          call[1] === 'convFail' &&
          (call[2] as Array<{ role: string; content: Array<{ text?: string }> }>).some(
            (message) => message.role === 'user' && message.content?.[0]?.text === 'inject before failure',
          ),
      );
    expect(persisted).toBe(true);
    vi.mocked(streamForPlugin).mockImplementation(async function* () {
      yield { type: 'text-delta', text: 'AGENT SAYS HI' } as never;
      yield { type: 'done', modelKey: 'test' } as never;
    });
  });

  it('alert resume (forceFreshTurn) runs a real turn on the existing conversation (never enqueues/strands)', async () => {
    // Regression for the reported bug: an answered alert appended to the thread
    // but no turn ran. resumeConversationWithMessage must RUN a turn (streamForPlugin)
    // and never leave the answer merely enqueued.
    clearInjects('convResume');
    resetMockStore({
      convResume: { id: 'convResume', messageTree: [], headId: null, metadata: {}, runStatus: 'idle' },
    });
    await resumeConversationWithMessage('convResume', '[Approved] proceed', deps());
    // A real turn ran into convResume, and nothing was left enqueued.
    expect(vi.mocked(streamForPlugin)).toHaveBeenCalled();
    expect(hasInjects('convResume')).toBe(false);
    // The answer was appended as a user turn on that conversation.
    expect(vi.mocked(appendConversationMessages).mock.calls.some((c) => c[1] === 'convResume')).toBe(true);
  });

  it('orders an alert answer before later automation events without disabling ordinary mid-turn injects', async () => {
    clearInjects('convOrdered');
    resetMockStore({
      convOrdered: { id: 'convOrdered', messageTree: [], headId: null, metadata: {}, runStatus: 'idle' },
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let streamCalls = 0;
    vi.mocked(streamForPlugin).mockImplementation(async function* () {
      streamCalls += 1;
      if (streamCalls === 1) await firstGate;
      yield { type: 'text-delta', text: `reply-${streamCalls}` } as never;
      yield { type: 'done', modelKey: 'test' } as never;
    });
    const d = deps({ injectUserTurnAndRestart: vi.fn(async () => ({ ok: true })) });

    const original = executeActions(agentAction({ type: 'existing', conversationId: 'convOrdered' }), evt, d);
    await vi.waitFor(() => {
      if (!vi.mocked(appendConversationMessages).mock.calls.some((call) => call[1] === 'convOrdered')) {
        throw new Error('original turn did not start');
      }
    });

    // The alert answer establishes the ordered barrier while the original run is
    // still active. A later Matt event must queue BEHIND it rather than injecting
    // into/overtaking the original turn.
    const answer = resumeConversationWithMessage('convOrdered', '[Answer] A little', d);
    await Promise.resolve();
    const later = executeActions(agentAction({ type: 'existing', conversationId: 'convOrdered' }), evt, d);
    expect(hasInjects('convOrdered')).toBe(false);

    releaseFirst();
    await Promise.all([original, answer, later]);

    expect(streamCalls).toBe(3);
    const userPrompts = vi
      .mocked(appendConversationMessages)
      .mock.calls.flatMap((call) => call[2] as Array<{ role: string; content: Array<{ text?: string }> }>)
      .filter((message) => message.role === 'user')
      .map((message) => message.content?.[0]?.text);
    expect(userPrompts).toEqual(['do the thing', '[Answer] A little', 'do the thing']);
    expect(hasInjects('convOrdered')).toBe(false);
  });

  it('alert resume force-clears a STUCK runStatus:"running" and still runs a real turn', async () => {
    // The reported bug: a live request_review turn that suspended left the
    // conversation runStatus:'running' forever; the resume then resolved it as
    // busy and ENQUEUED the answer (no turn ran, phantom sibling). With no
    // automation run actually in flight, the resume must force-clear the stale
    // status and run a real turn.
    clearInjects('convStuck');
    resetMockStore({
      convStuck: { id: 'convStuck', messageTree: [], headId: null, metadata: {}, runStatus: 'running' },
    });
    await resumeConversationWithMessage('convStuck', '[Approved] proceed', deps());
    expect(vi.mocked(streamForPlugin)).toHaveBeenCalled();
    expect(hasInjects('convStuck')).toBe(false);
    expect(vi.mocked(appendConversationMessages).mock.calls.some((c) => c[1] === 'convStuck')).toBe(true);
  });

  it('singleton first run creates with automationSingleton=true, second run appends to same id', async () => {
    await executeActions(agentAction({ type: 'singleton' }), evt, deps());
    const created = vi.mocked(writeConversation).mock.calls[0][1] as unknown as {
      id: string;
      metadata: Record<string, unknown>;
      messageTree?: unknown[];
      headId?: string | null;
      runStatus?: string;
    };
    expect(created.metadata.automationSingleton).toBe(true);

    // Reset the singleton to an idle, empty state for the second run.
    resetMockStore({ [created.id]: { ...created, messageTree: [], headId: null, runStatus: 'idle' } });
    vi.mocked(appendConversationMessages).mockClear();
    await executeActions(agentAction({ type: 'singleton' }), evt, deps());
    expect(appendConversationMessages).toHaveBeenNthCalledWith(
      1,
      '/tmp/kai-test',
      created.id,
      [expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'do the thing' }] })],
      expect.objectContaining({ runStatus: 'running' }),
    );
    expect(appendConversationMessages).toHaveBeenNthCalledWith(
      2,
      '/tmp/kai-test',
      created.id,
      [expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: 'AGENT SAYS HI' }] })],
      expect.objectContaining({ runStatus: 'idle' }),
    );
  });

  it('existing appends to the target; missing target falls back to create', async () => {
    resetMockStore({
      convA: { id: 'convA', messageTree: [], headId: null, metadata: {}, runStatus: 'idle' },
    });
    await executeActions(agentAction({ type: 'existing', conversationId: 'convA' }), evt, deps());
    expect(appendConversationMessages).toHaveBeenCalledWith(
      '/tmp/kai-test',
      'convA',
      expect.arrayContaining([expect.objectContaining({ role: 'assistant' })]),
      expect.objectContaining({ runStatus: 'idle' }),
    );

    vi.mocked(writeConversation).mockClear();
    resetMockStore();
    await executeActions(agentAction({ type: 'existing', conversationId: 'gone' }), evt, deps());
    expect(writeConversation).toHaveBeenCalled();
  });

  it('includeHistory=true prepends the target branch to the agent input', async () => {
    resetMockStore({
      convA: {
        id: 'convA',
        messageTree: [
          { id: 'm1', parentId: null, role: 'user', content: 'earlier q', createdAt: 'x' },
          { id: 'm2', parentId: 'm1', role: 'assistant', content: 'earlier a', createdAt: 'x' },
        ],
        headId: 'm2',
        metadata: {},
      },
    });
    await executeActions(agentAction({ type: 'existing', conversationId: 'convA' }, true), evt, deps());
    const call = vi.mocked(streamForPlugin).mock.calls.at(-1)![0];
    expect(call.messages).toEqual([
      { role: 'user', content: 'earlier q' },
      { role: 'assistant', content: 'earlier a' },
      { role: 'user', content: 'do the thing' },
    ]);
  });

  it('passes the resolved target conversationId into the stream', async () => {
    resetMockStore({
      convA: { id: 'convA', messageTree: [], headId: null, metadata: {}, runStatus: 'idle' },
    });
    await executeActions(agentAction({ type: 'existing', conversationId: 'convA' }), evt, deps());
    expect(vi.mocked(streamForPlugin).mock.calls.at(-1)![0].conversationId).toBe('convA');

    vi.mocked(streamForPlugin).mockClear();
    resetMockStore();
    // per-invocation now creates a real target up front (so the prompt can stream
    // live), so the stream always receives a concrete conversationId.
    await executeActions(agentAction({ type: 'per-invocation' }), evt, deps());
    expect(vi.mocked(streamForPlugin).mock.calls.at(-1)![0].conversationId).toBeTruthy();
  });

  it('includeHistory keeps tool-call parts (for context) but strips enrichment/other parts', async () => {
    resetMockStore({
      convA: {
        id: 'convA',
        messageTree: [
          {
            id: 'm1',
            parentId: null,
            role: 'assistant',
            content: [
              { type: 'text', text: 'kept' },
              { type: 'tool-call', toolCallId: 't1', toolName: 'x', args: {} },
              { type: 'enrichments', enrichments: {} },
            ],
            createdAt: 'x',
          },
          {
            id: 'm2',
            parentId: 'm1',
            role: 'assistant',
            content: [{ type: 'tool-call', toolCallId: 't2' }],
            createdAt: 'x',
          },
        ],
        headId: 'm2',
        metadata: {},
        runStatus: 'idle',
      },
    });
    await executeActions(agentAction({ type: 'existing', conversationId: 'convA' }, true), evt, deps());
    const call = vi.mocked(streamForPlugin).mock.calls.at(-1)![0];
    // tool-call parts are preserved so a resumed/automation turn SEES the calls it
    // made (stripping them made the model think it never asked → "fabricated").
    // The downstream plugin sanitizer pairs the call with its result; here we only
    // assert the history filter keeps tool-call + text and drops enrichments.
    expect(call.messages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'kept' },
          { type: 'tool-call', toolCallId: 't1', toolName: 'x', args: {} },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't2' }] },
      { role: 'user', content: 'do the thing' },
    ]);
  });

  it('includeHistory=false sends only the prompt', async () => {
    resetMockStore({
      convA: {
        id: 'convA',
        messageTree: [{ id: 'm1', parentId: null, role: 'user', content: 'earlier', createdAt: 'x' }],
        headId: 'm1',
        metadata: {},
      },
    });
    await executeActions(agentAction({ type: 'existing', conversationId: 'convA' }, false), evt, deps());
    const call = vi.mocked(streamForPlugin).mock.calls.at(-1)![0];
    expect(call.messages).toEqual([{ role: 'user', content: 'do the thing' }]);
  });
});

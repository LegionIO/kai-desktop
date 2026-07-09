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
  readConversationStore: vi.fn(() => mockStore),
  writeConversationStore: vi.fn(),
  broadcastConversationChange: vi.fn(),
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

import type { AutomationConversationTarget, AutomationRule } from '../../config/schema.js';
import { executeActions, interpolateString, type ActionDeps } from '../actions.js';
import { AutomationEventBus } from '../event-bus.js';
import { generateForPlugin, streamForPlugin } from '../../agent/plugin-generate.js';
import { appendConversationMessages, writeConversationStore } from '../../ipc/conversations.js';

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
      },
    ]);

  beforeEach(() => {
    resetMockStore();
    vi.mocked(writeConversationStore).mockClear();
    vi.mocked(appendConversationMessages).mockClear();
    vi.mocked(generateForPlugin).mockClear();
    vi.mocked(streamForPlugin).mockClear();
  });

  it('per-invocation creates a shell (automationSingleton=false) then writes prompt + assistant', async () => {
    await executeActions(agentAction({ type: 'per-invocation' }), evt, deps());
    const [, store] = vi.mocked(writeConversationStore).mock.calls[0] as [string, MockStore];
    const conv = Object.values(store.conversations)[0] as Record<string, unknown>;
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

  it('singleton first run creates with automationSingleton=true, second run appends to same id', async () => {
    await executeActions(agentAction({ type: 'singleton' }), evt, deps());
    const [, store1] = vi.mocked(writeConversationStore).mock.calls[0] as [string, MockStore];
    const created = Object.values(store1.conversations)[0] as {
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

    vi.mocked(writeConversationStore).mockClear();
    resetMockStore();
    await executeActions(agentAction({ type: 'existing', conversationId: 'gone' }), evt, deps());
    expect(writeConversationStore).toHaveBeenCalled();
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

  it('includeHistory filters out tool-call/enrichment parts and empty messages', async () => {
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
    expect(call.messages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'kept' }] },
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

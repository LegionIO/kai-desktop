import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  Notification: class {
    show() {}
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../utils/window-send.js', () => ({ broadcastToAllWindows: () => 0 }));
vi.mock('../../web-server/web-clients.js', () => ({ broadcastToWebClients: () => {} }));
vi.mock('../../agent/plugin-generate.js', () => ({
  generateForPlugin: vi.fn(async () => ({ text: '', modelKey: 'test', toolCalls: [] })),
}));
vi.mock('../../ipc/conversations.js', () => ({
  broadcastUpsert: () => {},
  appendConversationMessages: () => null,
  ensureConversationTree: (c: { messageTree?: unknown[]; headId?: string | null }) => ({
    tree: c.messageTree ?? [],
    headId: c.headId ?? null,
  }),
  getConversationBranch: (tree: unknown[]) => tree,
}));
vi.mock('../../ipc/conversation-store.js', () => ({
  readIndex: () => ({ conversations: {}, activeConversationId: null, settings: {} }),
  readConversation: () => null,
  writeConversation: () => {},
}));
vi.mock('../../ipc/agent.js', () => ({ broadcastAgentStreamEvent: () => {} }));

import type { AutomationRule, AutomationsConfig } from '../../config/schema.js';
import { AutomationEngine, type EngineDeps } from '../engine.js';
import { AutomationEventBus } from '../event-bus.js';

function makeEngine(rules: AutomationRule[], over: Partial<EngineDeps> = {}) {
  const bus = new AutomationEventBus();
  const cfg: AutomationsConfig = {
    enabled: true,
    rules,
    log: { maxEntries: 50 },
    approvalMode: 'prompt-user',
    surfaceAlertsAsModal: false,
  };
  const handlePluginAction = vi.fn(async () => 'ok');
  const deps: EngineDeps = {
    bus,
    appHome: '/tmp',
    getConfig: () => ({}) as never,
    getAutomationsConfig: () => cfg,
    getRegisteredTools: () => [],
    getWorkspaceTools: () => [],
    handlePluginAction,
    ...over,
  };
  const engine = new AutomationEngine(deps);
  engine.start();
  return { engine, bus, handlePluginAction, cfg };
}

function baseRule(over: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'r1',
    name: 'r1',
    enabled: true,
    trigger: { source: 'plugin.teams', event: 'msg' },
    conditions: [],
    conditionMode: 'all',
    actions: [{ type: 'plugin-action', pluginName: 'teams', targetId: 't', action: 'a' }],
    debounceMs: 0,
    ...over,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('AutomationEngine', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('fires matching rule', async () => {
    const { bus, handlePluginAction, engine } = makeEngine([baseRule()]);
    bus.emit('plugin.teams', 'msg', {});
    await flush();
    expect(handlePluginAction).toHaveBeenCalledTimes(1);
    expect(engine.getRunLog()).toHaveLength(1);
    expect(engine.getRunLog()[0].matched).toBe(true);
  });

  it('does not fire non-matching event', async () => {
    const { bus, handlePluginAction } = makeEngine([baseRule()]);
    bus.emit('plugin.teams', 'other', {});
    await flush();
    expect(handlePluginAction).not.toHaveBeenCalled();
  });

  it('skips when conditions fail', async () => {
    const { bus, engine, handlePluginAction } = makeEngine([
      baseRule({ conditions: [{ path: 'x', op: 'equals', value: '1', caseSensitive: false }] }),
    ]);
    bus.emit('plugin.teams', 'msg', { x: 2 });
    await flush();
    expect(handlePluginAction).not.toHaveBeenCalled();
    expect(engine.getRunLog()[0].skippedReason).toBe('conditions');
  });

  it('non-matching events do not consume debounce budget', async () => {
    const { bus, handlePluginAction } = makeEngine([
      baseRule({ debounceMs: 60_000, conditions: [{ path: 'x', op: 'equals', value: 'go', caseSensitive: false }] }),
    ]);
    bus.emit('plugin.teams', 'msg', { x: 'nope' });
    await flush();
    bus.emit('plugin.teams', 'msg', { x: 'go' });
    await flush();
    expect(handlePluginAction).toHaveBeenCalledTimes(1);
  });

  it('debounces', async () => {
    const { bus, handlePluginAction } = makeEngine([baseRule({ debounceMs: 1000 })]);
    bus.emit('plugin.teams', 'msg', {});
    bus.emit('plugin.teams', 'msg', {});
    await flush();
    expect(handlePluginAction).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1001);
    bus.emit('plugin.teams', 'msg', {});
    await flush();
    expect(handlePluginAction).toHaveBeenCalledTimes(2);
  });

  it('rate-limits per minute', async () => {
    const { bus, handlePluginAction } = makeEngine([baseRule({ rateLimitPerMinute: 2 })]);
    bus.emit('plugin.teams', 'msg', {});
    bus.emit('plugin.teams', 'msg', {});
    bus.emit('plugin.teams', 'msg', {});
    await flush();
    expect(handlePluginAction).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_001);
    bus.emit('plugin.teams', 'msg', {});
    await flush();
    expect(handlePluginAction).toHaveBeenCalledTimes(3);
  });

  it('drops emit chains beyond max depth', async () => {
    const { bus, handlePluginAction } = makeEngine([
      baseRule({
        actions: [
          { type: 'plugin-action', pluginName: 'teams', targetId: 't', action: 'a' },
          { type: 'emit', source: 'plugin.teams', event: 'msg' },
        ],
      }),
    ]);
    bus.emit('plugin.teams', 'msg', {});
    // Let all microtasks/recursions settle
    for (let i = 0; i < 20; i++) await flush();
    // depth 0..4 inclusive = 5 executions; depth 5 dropped
    expect(handlePluginAction.mock.calls.length).toBeLessThanOrEqual(5);
    expect(handlePluginAction.mock.calls.length).toBeGreaterThan(1);
  });

  it('respects global enabled=false', async () => {
    const { bus, handlePluginAction, cfg } = makeEngine([baseRule()]);
    cfg.enabled = false;
    bus.emit('plugin.teams', 'msg', {});
    await flush();
    expect(handlePluginAction).not.toHaveBeenCalled();
  });

  it('testRule bypasses throttle and returns record', async () => {
    const { engine } = makeEngine([baseRule({ debounceMs: 999999 })]);
    const r1 = await engine.testRule('r1', {});
    const r2 = await engine.testRule('r1', {});
    expect(r1.matched).toBe(true);
    expect(r2.matched).toBe(true);
  });
});

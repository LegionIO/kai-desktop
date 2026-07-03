import { describe, expect, it, vi } from 'vitest';

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
vi.mock('../../agent/plugin-generate.js', () => ({
  generateForPlugin: vi.fn(async () => ({ text: 'AGENT SAYS HI', modelKey: 'test', toolCalls: [] })),
}));
vi.mock('../../ipc/conversations.js', () => ({
  readConversationStore: () => ({ conversations: {}, activeConversationId: null, settings: {} }),
  writeConversationStore: vi.fn(),
  broadcastConversationChange: vi.fn(),
}));

import type { AutomationRule } from '../../config/schema.js';
import { executeActions, interpolateString, type ActionDeps } from '../actions.js';
import { AutomationEventBus } from '../event-bus.js';

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
        { type: 'agent', mode: 'background', prompt: 'reply to: {{payload.body}}', tools: false },
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

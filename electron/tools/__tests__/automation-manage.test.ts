import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks for the automations tool's collaborators ──────────────────────────

// In-memory config the tool reads/writes.
let mockConfig: {
  automations: { enabled: boolean; rules: unknown[]; log: { maxEntries: number }; approvalMode: string };
};

vi.mock('../../ipc/config.js', () => ({
  readEffectiveConfig: () => mockConfig,
  writeDesktopConfig: (_home: string, cfg: typeof mockConfig) => {
    mockConfig = cfg;
  },
}));

vi.mock('../../ipc/agent.js', () => ({
  getRegisteredTools: () => [],
  getWorkspaceToolDefinitions: () => [],
}));

vi.mock('../../automations/engine.js', () => ({
  getAutomationEngine: () => ({
    reload: vi.fn(),
    testRule: vi.fn(async () => ({ ok: true })),
  }),
}));

vi.mock('../../automations/event-bus.js', () => ({
  eventBus: { getCatalog: () => ({ sources: [] }) },
}));

vi.mock('../../automations/schema-check.js', () => ({
  validateRulePaths: () => [],
}));

// Controllable approval decision + spy on the broadcast.
let approvalDecision: boolean | 'dismiss' = true;
const broadcastSpy = vi.fn();
vi.mock('../../ipc/tool-approval.js', () => ({
  registerPendingApproval: vi.fn(async () => approvalDecision),
  broadcastStreamEventRaw: (e: unknown) => broadcastSpy(e),
}));

import { createAutomationManageTool } from '../automation-manage.js';

const CTX = { toolCallId: 'tc-1', conversationId: 'conv-1', abortSignal: new AbortController().signal };

function freshConfig(approvalMode: string, rules: unknown[] = []) {
  mockConfig = { automations: { enabled: true, rules, log: { maxEntries: 200 }, approvalMode } };
}

const hookTriggeredRule = {
  name: 'observe prompts',
  trigger: { source: 'hook', event: 'UserPromptSubmit' },
  actions: [{ type: 'notification', title: 'seen' }],
};

const shellRule = {
  name: 'dlp',
  trigger: { source: 'hook', event: 'PreToolUse' },
  actions: [{ type: 'runHookCommand', command: 'scan.sh', mode: 'block' }],
};

const benignRule = {
  name: 'notify on plugin event',
  trigger: { source: 'plugin.foo', event: 'thing' },
  actions: [{ type: 'notification', title: 'hi' }],
};

async function run(action: string, extra: Record<string, unknown> = {}) {
  const tool = createAutomationManageTool('/tmp');
  return (await tool.execute({ action, ...extra }, CTX as never)) as Record<string, unknown>;
}

beforeEach(() => {
  approvalDecision = true;
  broadcastSpy.mockClear();
});

describe('automations tool approval gate', () => {
  it('auto-allow: creates a hook-triggered rule with no prompt', async () => {
    freshConfig('auto-allow');
    const res = await run('create', { rule: hookTriggeredRule });
    expect(res.success).toBe(true);
    expect(broadcastSpy).not.toHaveBeenCalled();
    expect(mockConfig.automations.rules).toHaveLength(1);
  });

  it('block: refuses to create a hook-triggered rule, no prompt, nothing persisted', async () => {
    freshConfig('block');
    const res = await run('create', { rule: hookTriggeredRule });
    expect(res.error).toMatch(/block/i);
    expect(broadcastSpy).not.toHaveBeenCalled();
    expect(mockConfig.automations.rules).toHaveLength(0);
  });

  it('block: refuses to create a runHookCommand (shell) rule', async () => {
    freshConfig('block');
    const res = await run('create', { rule: shellRule });
    expect(res.error).toMatch(/block/i);
    expect(mockConfig.automations.rules).toHaveLength(0);
  });

  it('prompt-user + approve: prompts then persists', async () => {
    freshConfig('prompt-user');
    approvalDecision = true;
    const res = await run('create', { rule: shellRule });
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    expect((broadcastSpy.mock.calls[0][0] as { type: string }).type).toBe('tool-approval-required');
    expect(res.success).toBe(true);
    expect(mockConfig.automations.rules).toHaveLength(1);
  });

  it('prompt-user + reject: prompts and does not persist', async () => {
    freshConfig('prompt-user');
    approvalDecision = false;
    const res = await run('create', { rule: shellRule });
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    expect(res.error).toMatch(/denied/i);
    expect(mockConfig.automations.rules).toHaveLength(0);
  });

  it('never prompts for a benign (non-dangerous) rule under prompt-user', async () => {
    freshConfig('prompt-user');
    const res = await run('create', { rule: benignRule });
    expect(broadcastSpy).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
  });

  it('does not gate a benign rule creation even under block', async () => {
    freshConfig('block');
    const res = await run('create', { rule: benignRule });
    expect(res.success).toBe(true);
    expect(mockConfig.automations.rules).toHaveLength(1);
  });

  it('enable: gates enabling a dangerous rule', async () => {
    const existing = { ...shellRule, id: 'r1', enabled: false, conditions: [], conditionMode: 'all', debounceMs: 0 };
    freshConfig('block', [existing]);
    const res = await run('enable', { id: 'r1' });
    expect(res.error).toMatch(/block/i);
    // still disabled
    expect((mockConfig.automations.rules[0] as { enabled: boolean }).enabled).toBe(false);
  });

  it('disable: gates disabling a user shell (enforcement) rule', async () => {
    const existing = { ...shellRule, id: 'r1', enabled: true, conditions: [], conditionMode: 'all', debounceMs: 0 };
    freshConfig('block', [existing]);
    const res = await run('disable', { id: 'r1' });
    expect(res.error).toMatch(/block/i);
    expect((mockConfig.automations.rules[0] as { enabled: boolean }).enabled).toBe(true);
  });

  it('delete: gates deleting a user shell (enforcement) rule', async () => {
    const existing = { ...shellRule, id: 'r1', enabled: true, conditions: [], conditionMode: 'all', debounceMs: 0 };
    freshConfig('block', [existing]);
    const res = await run('delete', { id: 'r1' });
    expect(res.error).toMatch(/block/i);
    expect(mockConfig.automations.rules).toHaveLength(1);
  });

  it('delete: does NOT gate a hook-triggered observe rule (agent-created, no shell)', async () => {
    const existing = {
      ...hookTriggeredRule,
      id: 'r1',
      enabled: true,
      conditions: [],
      conditionMode: 'all',
      debounceMs: 0,
    };
    freshConfig('block', [existing]);
    const res = await run('delete', { id: 'r1' });
    expect(res.success).toBe(true);
    expect(mockConfig.automations.rules).toHaveLength(0);
  });

  it('test: gates running a dangerous rule under block', async () => {
    const existing = { ...shellRule, id: 'r1', enabled: true, conditions: [], conditionMode: 'all', debounceMs: 0 };
    freshConfig('block', [existing]);
    const res = await run('test', { id: 'r1' });
    expect(res.error).toMatch(/block/i);
  });

  it('prompt-user with no live owner (internal caller): fails closed, never awaits', async () => {
    freshConfig('prompt-user');
    approvalDecision = true; // would approve IF it awaited — it must not
    const tool = createAutomationManageTool('/tmp');
    // Synthetic context like an automation `tool` action: toolCallId only.
    const res = (await tool.execute({ action: 'create', rule: shellRule }, {
      toolCallId: 'auto-xyz',
    } as never)) as Record<string, unknown>;
    expect(broadcastSpy).not.toHaveBeenCalled();
    expect(res.error).toMatch(/no live chat|Settings/i);
    expect(mockConfig.automations.rules).toHaveLength(0);
  });
});

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

// Controllable conversation index for existing-target validation.
let mockConversations: Record<string, { id: string; title: string | null }> = {};
vi.mock('../../ipc/conversation-store.js', () => ({
  readIndex: () => ({ conversations: mockConversations }),
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

// A NON-hook-triggered rule whose action executes a registered tool. This is a
// capability grant (the tool can be sh/file/exec), so it must be gated even
// though it neither triggers on hook events nor uses runHookCommand.
const toolActionRule = {
  name: 'run a tool on a plugin event',
  trigger: { source: 'plugin.foo', event: 'thing' },
  actions: [{ type: 'tool', toolName: 'sh', input: { command: 'echo {{payload.text}}' } }],
};

// An agent action WITH tools runs an autonomous agent (no interactive approval)
// that can call exec/file tools → capability grant, must be gated. tools:false
// is text-only → benign.
const agentToolsRule = {
  name: 'autonomous agent on a plugin event',
  trigger: { source: 'plugin.foo', event: 'thing' },
  actions: [{ type: 'agent', mode: 'background', prompt: 'do {{payload.task}}', tools: true }],
};
const agentNoToolsRule = {
  name: 'text-only agent on a plugin event',
  trigger: { source: 'plugin.foo', event: 'thing' },
  actions: [{ type: 'agent', mode: 'background', prompt: 'summarize {{payload.text}}', tools: false }],
};

async function run(action: string, extra: Record<string, unknown> = {}) {
  const tool = createAutomationManageTool('/tmp');
  return (await tool.execute({ action, ...extra }, CTX as never)) as Record<string, unknown>;
}

beforeEach(() => {
  approvalDecision = true;
  broadcastSpy.mockClear();
  mockConversations = {};
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

  it('block: refuses to create a DISABLED dangerous rule (no dormant-rule bypass)', async () => {
    freshConfig('block');
    const res = await run('create', { rule: { ...shellRule, enabled: false } });
    expect(res.error).toMatch(/block/i);
    expect(mockConfig.automations.rules).toHaveLength(0);
  });

  it('block: refuses to create a tool-action rule (executes a registered tool = capability grant)', async () => {
    freshConfig('block');
    const res = await run('create', { rule: toolActionRule });
    expect(res.error).toMatch(/block/i);
    expect(res.error).toMatch(/tool/i);
    expect(mockConfig.automations.rules).toHaveLength(0);
  });

  it('prompt-user: gates a tool-action rule and surfaces the tool name in the approval', async () => {
    freshConfig('prompt-user');
    approvalDecision = true;
    const res = await run('create', { rule: toolActionRule });
    expect(res.success).toBe(true);
    const evt = broadcastSpy.mock.calls[0][0] as { type: string; args: { toolActions?: string[]; reason?: string } };
    expect(evt.type).toBe('tool-approval-required');
    expect(evt.args.toolActions).toEqual(['sh']);
    expect(evt.args.reason).toMatch(/sh/);
  });

  it('block: refuses to `test` a tool-action rule (test executes the real action)', async () => {
    freshConfig('block', [{ id: 'r-tool', enabled: true, conditions: [], conditionMode: 'all', ...toolActionRule }]);
    const res = await run('test', { id: 'r-tool' });
    expect(res.error).toMatch(/block/i);
  });

  it('block: refuses to create an agent-action rule WITH tools (autonomous exec)', async () => {
    freshConfig('block');
    const res = await run('create', { rule: agentToolsRule });
    expect(res.error).toMatch(/block/i);
    expect(mockConfig.automations.rules).toHaveLength(0);
  });

  it('prompt-user: gates an agent-with-tools rule and explains the agent runs tools', async () => {
    freshConfig('prompt-user');
    approvalDecision = true;
    const res = await run('create', { rule: agentToolsRule });
    expect(res.success).toBe(true);
    const evt = broadcastSpy.mock.calls[0][0] as { type: string; args: { reason?: string } };
    expect(evt.type).toBe('tool-approval-required');
    expect(evt.args.reason).toMatch(/autonomous agent turn with tools/i);
  });

  it('does NOT gate a text-only agent action (tools:false is not a capability grant)', async () => {
    freshConfig('block');
    const res = await run('create', { rule: agentNoToolsRule });
    expect(res.success).toBe(true); // benign → not blocked even under block mode
    expect(broadcastSpy).not.toHaveBeenCalled();
    expect(mockConfig.automations.rules).toHaveLength(1);
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

describe('automations tool: existing-target validation', () => {
  const existingRule = (conversationId: string) => ({
    name: 'append to a chat',
    trigger: { source: 'plugin.foo', event: 'thing' },
    actions: [
      {
        type: 'agent',
        mode: 'conversation',
        prompt: 'go',
        tools: false,
        conversationTarget: { type: 'existing', conversationId },
      },
    ],
  });

  it('accepts a conversationTarget whose id is a real conversation', async () => {
    freshConfig('auto-allow');
    mockConversations = { 'conv-real': { id: 'conv-real', title: 'My Chat' } };
    const res = await run('create', { rule: existingRule('conv-real') });
    expect(res.success).toBe(true);
    const saved = mockConfig.automations.rules[0] as {
      actions: Array<{ conversationTarget: { conversationId: string } }>;
    };
    expect(saved.actions[0].conversationTarget.conversationId).toBe('conv-real');
  });

  it('rejects a conversationId that is not a known id and matches no title', async () => {
    freshConfig('auto-allow');
    mockConversations = { 'conv-real': { id: 'conv-real', title: 'My Chat' } };
    const res = await run('create', { rule: existingRule('does-not-exist') });
    expect(res.success).toBeUndefined();
    expect(res.error).toMatch(/not a known conversation id/i);
    expect(mockConfig.automations.rules).toHaveLength(0);
  });

  it('repairs a title passed in place of an id (unique match) to the real id', async () => {
    freshConfig('auto-allow');
    mockConversations = { 'conv-abc': { id: 'conv-abc', title: 'Weekly Report' } };
    const res = await run('create', { rule: existingRule('Weekly Report') });
    expect(res.success).toBe(true);
    const saved = mockConfig.automations.rules[0] as {
      actions: Array<{ conversationTarget: { conversationId: string } }>;
    };
    expect(saved.actions[0].conversationTarget.conversationId).toBe('conv-abc');
  });

  it('rejects an ambiguous title that matches multiple chats', async () => {
    freshConfig('auto-allow');
    mockConversations = {
      a: { id: 'a', title: 'Same' },
      b: { id: 'b', title: 'Same' },
    };
    const res = await run('create', { rule: existingRule('Same') });
    expect(res.error).toMatch(/matches 2 chats by title/i);
    expect(mockConfig.automations.rules).toHaveLength(0);
  });

  it('defaults an omitted conversationId to the current chat (not rejected)', async () => {
    freshConfig('auto-allow');
    mockConversations = { 'conv-1': { id: 'conv-1', title: 'Current' } };
    const rule = {
      name: 'append here',
      trigger: { source: 'plugin.foo', event: 'thing' },
      actions: [
        { type: 'agent', mode: 'conversation', prompt: 'go', tools: false, conversationTarget: { type: 'existing' } },
      ],
    };
    const res = await run('create', { rule });
    expect(res.success).toBe(true);
    const saved = mockConfig.automations.rules[0] as {
      actions: Array<{ conversationTarget: { conversationId: string } }>;
    };
    expect(saved.actions[0].conversationTarget.conversationId).toBe('conv-1'); // CTX.conversationId
  });
});

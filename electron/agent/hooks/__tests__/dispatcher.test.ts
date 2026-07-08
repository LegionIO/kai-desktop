import { beforeEach, describe, expect, it, vi } from 'vitest';

// runShellHook spawns a child process; we don't want that in a unit test. Since
// it's module-internal, we instead assert throttle behavior via observable
// dispatch outcomes with a hook rule whose command is a fast no-op. To keep the
// test hermetic we stub child_process.spawn.
const spawnCalls: string[] = [];
vi.mock('node:child_process', () => ({
  spawn: (command: string) => {
    spawnCalls.push(command);
    // Minimal fake child that "exits 0" immediately so block/modify resolve allow.
    const handlers: Record<string, (arg?: unknown) => void> = {};
    const child = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      stdin: { on: () => {}, write: () => {}, end: () => {} },
      on: (evt: string, cb: (arg?: unknown) => void) => {
        handlers[evt] = cb;
        if (evt === 'close') setTimeout(() => cb(0), 0);
      },
      kill: () => {},
      pid: 1234,
    };
    return child;
  },
}));

import { HookDispatcher } from '../dispatcher.js';
import type { AppConfig, AutomationRule } from '../../../config/schema.js';

function ruleWithRate(rateLimitPerMinute: number): AutomationRule {
  return {
    id: 'r-rate',
    name: 'rate-limited hook',
    enabled: true,
    trigger: { source: 'hook', event: 'PreToolUse' },
    conditions: [],
    conditionMode: 'all',
    actions: [{ type: 'runHookCommand', command: 'true', mode: 'observe', matcher: '*' }],
    debounceMs: 0,
    rateLimitPerMinute,
  } as AutomationRule;
}

function makeConfig(rule: AutomationRule): AppConfig {
  return {
    automations: { enabled: true, rules: [rule], log: { maxEntries: 50 }, approvalMode: 'prompt-user' },
    hooks: { enabled: true, timeoutMs: 5000 },
  } as unknown as AppConfig;
}

describe('HookDispatcher rule throttling', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  it('honors rateLimitPerMinute for user shell hooks', async () => {
    const d = new HookDispatcher();
    d.configure({ getConfig: () => makeConfig(ruleWithRate(2)) });

    // 4 matching PreToolUse dispatches; rate limit is 2/min → only 2 spawns.
    for (let i = 0; i < 4; i++) {
      await d.dispatch('PreToolUse', { conversationId: 'c', toolName: 'shell', args: {} });
    }
    // observe hooks are fire-and-forget; allow microtasks to flush.
    await new Promise((r) => setTimeout(r, 5));
    expect(spawnCalls.length).toBe(2);
  });

  it('a multi-action rule runs ALL its actions per matching dispatch (shared throttle budget)', async () => {
    const rule: AutomationRule = {
      id: 'r-multi',
      name: 'two-command hook',
      enabled: true,
      trigger: { source: 'hook', event: 'PreToolUse' },
      conditions: [],
      conditionMode: 'all',
      actions: [
        { type: 'runHookCommand', command: 'cmd-a', mode: 'observe', matcher: '*' },
        { type: 'runHookCommand', command: 'cmd-b', mode: 'observe', matcher: '*' },
      ],
      debounceMs: 0,
      rateLimitPerMinute: 1, // 1 rule-fire per minute
    } as AutomationRule;

    const d = new HookDispatcher();
    d.configure({ getConfig: () => makeConfig(rule) });

    // 2 dispatches. Rate limit is 1/min at the RULE level, so only the first
    // dispatch fires — but it must run BOTH of the rule's actions (not have the
    // first action consume the budget and starve the second).
    await d.dispatch('PreToolUse', { conversationId: 'c', toolName: 'shell', args: {} });
    await d.dispatch('PreToolUse', { conversationId: 'c', toolName: 'shell', args: {} });
    await new Promise((r) => setTimeout(r, 5));

    expect(spawnCalls.filter((c) => c === 'cmd-a').length).toBe(1);
    expect(spawnCalls.filter((c) => c === 'cmd-b').length).toBe(1);
    expect(spawnCalls.length).toBe(2);
  });
});

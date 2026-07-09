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

  it('suppressObserve skips observe handlers (enforcement-only dispatch)', async () => {
    const rule: AutomationRule = {
      id: 'r-observe',
      name: 'observe hook',
      enabled: true,
      trigger: { source: 'hook', event: 'UserPromptSubmit' },
      conditions: [],
      conditionMode: 'all',
      actions: [{ type: 'runHookCommand', command: 'observe-cmd', mode: 'observe' }],
      debounceMs: 0,
    } as AutomationRule;

    const d = new HookDispatcher();
    d.configure({ getConfig: () => makeConfig(rule) });

    await d.dispatch('UserPromptSubmit', { conversationId: 'c', messages: [] }, { suppressObserve: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(spawnCalls.length).toBe(0);

    // Without suppressObserve the same observe hook DOES fire.
    await d.dispatch('UserPromptSubmit', { conversationId: 'c', messages: [] });
    await new Promise((r) => setTimeout(r, 5));
    expect(spawnCalls.length).toBe(1);
  });

  it('modify hook returning a malformed replacement fails CLOSED', async () => {
    const cfg = {
      hooks: { enabled: true, timeoutMs: 5000 },
      automations: { enabled: false, rules: [] },
    } as unknown as AppConfig;
    const d = new HookDispatcher();
    d.configure({ getConfig: () => cfg });

    // A modify hook that returns a payload missing the required `messages` field
    // for UserPromptSubmit must NOT be accepted (would leave the caller using the
    // original raw prompt). The dispatch must be denied.
    d.register('UserPromptSubmit', () => ({ payload: {} }), { source: 'plugin', mode: 'modify' });
    const bad = await d.dispatch('UserPromptSubmit', {
      conversationId: 'c',
      messages: [{ role: 'user', content: 'secret' }],
    });
    expect(bad.denied).toBe(true);
  });

  it('modify hook returning a valid replacement is applied', async () => {
    const cfg = {
      hooks: { enabled: true, timeoutMs: 5000 },
      automations: { enabled: false, rules: [] },
    } as unknown as AppConfig;
    const d = new HookDispatcher();
    d.configure({ getConfig: () => cfg });

    d.register('UserPromptSubmit', () => ({ payload: { messages: [{ role: 'user', content: 'redacted' }] } }), {
      source: 'plugin',
      mode: 'modify',
    });
    const ok = await d.dispatch('UserPromptSubmit', {
      conversationId: 'c',
      messages: [{ role: 'user', content: 'secret' }],
    });
    expect(ok.denied).toBe(false);
    expect((ok.payload as { messages: { content: string }[] }).messages[0].content).toBe('redacted');
  });

  it('suppressObserve dispatch does NOT consume a shell rule throttle budget', async () => {
    // A rate-limited (1/min) UserPromptSubmit shell hook. An enforcement-only
    // (suppressObserve) auxiliary dispatch must not consume the budget, so a
    // later real dispatch still fires the hook.
    const rule: AutomationRule = {
      id: 'r-aux',
      name: 'rate-limited prompt hook',
      enabled: true,
      trigger: { source: 'hook', event: 'UserPromptSubmit' },
      conditions: [],
      conditionMode: 'all',
      actions: [{ type: 'runHookCommand', command: 'ups-cmd', mode: 'observe', matcher: '*' }],
      debounceMs: 0,
      rateLimitPerMinute: 1,
    } as AutomationRule;

    const d = new HookDispatcher();
    d.configure({ getConfig: () => makeConfig(rule) });

    // Auxiliary (suppressObserve) dispatch: enforcement-only, must not fire the
    // observe hook nor consume the budget.
    await d.dispatch('UserPromptSubmit', { conversationId: 'c', messages: [] }, { suppressObserve: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(spawnCalls.length).toBe(0);

    // The real dispatch still has its full 1/min budget → the hook fires.
    await d.dispatch('UserPromptSubmit', { conversationId: 'c', messages: [] });
    await new Promise((r) => setTimeout(r, 5));
    expect(spawnCalls.length).toBe(1);
  });
});

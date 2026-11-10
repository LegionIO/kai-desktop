import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridgeSystemFixture, installClanksFixture, installHooks } from '../../../test-utils/plugin-bridge.js';
import { dispatchBridgeEvent } from '../lifecycle.js';
import type { ToolDefinition } from '../../tools/types.js';

describe.each([
  { launcher: 'executable', nodeLauncher: false },
  { launcher: 'node script', nodeLauncher: true },
])('Clanks MCP and lifecycle wire compatibility ($launcher)', ({ nodeLauncher }) => {
  let f: ReturnType<typeof bridgeSystemFixture>, fixture: ReturnType<typeof installClanksFixture>;
  beforeEach(async () => {
    f = bridgeSystemFixture();
    fixture = installClanksFixture(f.install('codex', 'clanks'), nodeLauncher);
    await f.system.initialize();
    await f.system.mutate({ action: 'imports', enabled: true });
  });
  afterEach(async () => f.close());
  async function approve(hooks = false) {
    const p = f.system.imports.inventory()[0];
    await f.system.mutate({
      action: 'approve',
      pluginId: p.id,
      packagePath: p.packagePath,
      allowOverlap: false,
      revisions: Object.fromEntries(
        p.components.filter((c) => c.kind === 'mcp' || (hooks && c.kind === 'hooks')).map((c) => [c.id, c.revision]),
      ),
    });
  }
  function tool(name: string): ToolDefinition {
    return f.tools().find((t) => t.originalName === name)!;
  }
  it('uses polling mode without hook consent, with isolated registration and inbox handles', async () => {
    expect(fixture.mcp.starts()).toEqual([]);
    await approve();
    const registrations = await Promise.all(
      ['chat-a', 'chat-b', 'subagent-c'].map(async (conversationId) => {
        const context = { conversationId, cwd: f.root, toolCallId: conversationId };
        const value = (await tool('peer_register').execute(
          { native_session_id: 'foreign-session', agent_id: 'parent-agent' },
          context,
        )) as { structuredContent: { input: Record<string, unknown>; handle: string; session: string } };
        expect(value.structuredContent.input.native_session_id).toBe(
          `kai:${f.system.store.get().instanceId}:${conversationId}`,
        );
        expect(value.structuredContent.input.agent_id).toBeUndefined();
        await tool('peer_inbox').execute({ handle: value.structuredContent.handle }, context);
        return value.structuredContent;
      }),
    );
    expect(new Set(registrations.map((entry) => entry.handle)).size).toBe(3);
    expect(fixture.mcp.starts().every((start) => !start.args.includes('--hooks'))).toBe(true);
    expect(fixture.hooks.events()).toEqual([]);
    await expect(
      tool('peer_inbox').execute(
        { handle: registrations[0].handle },
        { conversationId: 'chat-b', cwd: f.root, toolCallId: 'wrong-handle' },
      ),
    ).rejects.toThrow('own Clanks handle');
  });
  it('shares identity, working directory and hook registration with the session MCP', async () => {
    await approve(true);
    const signal = new AbortController().signal;
    const prompt = await dispatchBridgeEvent('UserPromptSubmit', {
      conversationId: 'child',
      parentConversationId: 'parent',
      abortSignal: signal,
      cwd: f.root,
      purpose: 'sub-agent',
      messages: [{ role: 'user', content: 'Do the actual task.' }],
    });
    expect(prompt.denied).toBe(false);
    const last = prompt.payload.messages.at(-1)!;
    expect(last.content).toContain('Do the actual task.');
    const handle = /local handle is (peer_[a-f0-9]+)\./.exec(String(last.content))![1];
    const result = (await tool('peer_inbox').execute(
      { handle },
      { conversationId: 'child', cwd: f.root, toolCallId: 'inbox' },
    )) as { structuredContent: { session: string; cwd: string } };
    expect(
      fixture.hooks
        .events()
        .every(
          (event) =>
            event.session_id === result.structuredContent.session && event.cwd === result.structuredContent.cwd,
        ),
    ).toBe(true);
    expect(fixture.hooks.events().some((event) => event.hook_event_name === 'SubagentStart')).toBe(true);
    expect(fixture.mcp.starts().every((start) => start.args.includes('--hooks'))).toBe(true);
    await f.system.hooks.end('child');
    expect(f.system.hooks.sessions.has('child')).toBe(false);
    expect(fixture.hooks.events().some((event) => event.hook_event_name === 'SessionEnd')).toBe(true);
  });
  it('does not let a cancelled predecessor close its replacement session', async () => {
    await approve(true);
    const first = new AbortController(),
      second = new AbortController();
    const old = f.system.hooks.session('chat', f.root, 'mastra', undefined, first.signal);
    first.abort();
    const current = f.system.hooks.session('chat', f.root, 'codex', undefined, second.signal);
    await f.system.hooks.start(current);
    await tool('echo').execute({}, { conversationId: 'chat', cwd: f.root, toolCallId: 'before' });
    const starts = fixture.mcp.starts().length;
    await f.system.hooks.interrupt(old);
    await tool('echo').execute({}, { conversationId: 'chat', cwd: f.root, toolCallId: 'after' });
    expect(current.controller.signal.aborted).toBe(false);
    expect(fixture.mcp.starts()).toHaveLength(starts);
    await f.system.hooks.end('chat');
  });
  it('retains hook delivery for Claude packages without an Interrupt event', async () => {
    installHooks(
      f.system.imports.inventory()[0].packagePath,
      ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'],
      true,
    );
    await f.system.imports.refresh();
    await approve(true);
    await tool('peer_register').execute({}, { conversationId: 'claude-chat', cwd: f.root, toolCallId: 'register' });
    expect(fixture.mcp.starts().every((start) => start.args.includes('--hooks'))).toBe(true);
  });
  it('falls back to polling when a declared Interrupt event is not approved', async () => {
    const p = f.system.imports.inventory()[0];
    await f.system.mutate({
      action: 'approve',
      pluginId: p.id,
      packagePath: p.packagePath,
      allowOverlap: false,
      revisions: Object.fromEntries(p.components.filter((c) => c.name !== 'Interrupt').map((c) => [c.id, c.revision])),
    });
    await tool('peer_register').execute({}, { conversationId: 'partial-hooks', cwd: f.root, toolCallId: 'register' });
    expect(fixture.mcp.starts().every((start) => !start.args.includes('--hooks'))).toBe(true);
  });
  it('uses polling for exported tools even when Kai chat hooks are approved', async () => {
    await approve(true);
    await tool('peer_register').execute(
      {},
      {
        bridgeSessionId: 'connector:client:session',
        connectorClientId: 'client',
        cwd: f.root,
        toolCallId: 'exported-register',
      },
    );
    const connector = fixture.mcp.starts().find((start) => start.session.endsWith(':connector:client:session'));
    expect(connector?.args).not.toContain('--hooks');
    expect(fixture.hooks.events()).toEqual([]);
  });
});

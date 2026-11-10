import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { bridgeFixture, installHooks, writeBridgeFile } from '../../../test-utils/plugin-bridge.js';
import { PluginBridgeManager } from '../manager.js';
import { ImportedHooks, translateHookReply } from '../hooks.js';
import { bridgeStream, dispatchBridgeEvent, setBridgeLifecycle } from '../lifecycle.js';
import type { StreamEvent, StreamOptions } from '../../agent/runtime/types.js';
import { hookDispatcher } from '../../agent/hooks/dispatcher.js';
import { codexIsolationConfig } from '../runtime-isolation.js';

describe('imported lifecycle boundaries', () => {
  let f: ReturnType<typeof bridgeFixture>, manager: PluginBridgeManager, hooks: ImportedHooks;
  beforeEach(() => {
    f = bridgeFixture();
    manager = new PluginBridgeManager(
      f.appHome,
      f.store,
      () => f.config,
      () => [],
      () => {},
    );
    hooks = new ImportedHooks(manager);
    setBridgeLifecycle(hooks);
  });
  afterEach(async () => {
    setBridgeLifecycle(undefined);
    await hooks.close();
    await manager.stop();
    f.cleanup();
    vi.unstubAllEnvs();
  });
  async function ready(events?: string[]) {
    const root = f.install('claude');
    const fixture = installHooks(root, events);
    f.enableImports();
    await manager.refresh();
    const plugin = manager.inventory()[0];
    await manager.approve(plugin.id, Object.fromEntries(plugin.components.map((c) => [c.id, c.revision])), false);
    return { root, ...fixture };
  }
  it('translates context and denials, never honoring an allow as an approval', () => {
    expect(
      translateHookReply(
        { hookSpecificOutput: { permissionDecision: 'allow', additionalContext: 'data' } },
        'PreToolUse',
      ),
    ).toEqual({ context: 'data', deny: undefined });
    expect(translateHookReply({ hookSpecificOutput: { permissionDecision: 'deny' } }, 'PreToolUse').deny).toBeTruthy();
    expect(translateHookReply({}, 'UserPromptSubmit', 2).deny).toBeTruthy();
    expect(translateHookReply({ decision: 'block', reason: 'one more' }, 'Stop').continuation).toBe('one more');
    expect(translateHookReply({ reason: 'Exit-code continuation' }, 'Stop', 2).continuation).toBe(
      'Exit-code continuation',
    );
  });
  it('uses the same identity and cwd in prompt, tool and subagent events', async () => {
    const fixture = await ready();
    const controller = new AbortController();
    const prompt = await dispatchBridgeEvent('UserPromptSubmit', {
      conversationId: 'child',
      parentConversationId: 'parent',
      cwd: f.root,
      abortSignal: controller.signal,
      messages: [{ role: 'user', content: 'hello' }],
      purpose: 'sub-agent',
    });
    expect(prompt.denied).toBe(false);
    expect(prompt.modified).toBe(true);
    const pre = await dispatchBridgeEvent('PreToolUse', {
      conversationId: 'child',
      toolCallId: 'call',
      toolName: 'denied',
      args: {},
    });
    expect(pre.denied).toBe(true);
    const events = fixture.events();
    expect(events.map((e) => e.hook_event_name)).toEqual([
      'SessionStart',
      'SubagentStart',
      'UserPromptSubmit',
      'PreToolUse',
    ]);
    expect(new Set(events.map((e) => e.session_id))).toEqual(new Set([`kai:${f.store.get().instanceId}:child`]));
    expect(events.every((e) => e.cwd === f.root)).toBe(true);
  });
  it('preserves MCP content while adding post-tool context before native enforcement', async () => {
    await ready(['PostToolUse']);
    const result = await dispatchBridgeEvent('PostToolUse', {
      conversationId: 'chat',
      toolCallId: 'one',
      toolName: 'echo',
      args: {},
      result: { content: [{ type: 'image', data: 'eA==', mimeType: 'image/png' }], structuredContent: { data: 1 } },
    });
    expect(result.payload.result.structuredContent).toEqual({ data: 1 });
    expect(result.payload.result.content).toHaveLength(2);
    const off = hookDispatcher.register('PreToolUse', () => ({ decision: 'deny', reason: 'native wins' }), {
      mode: 'block',
      source: 'plugin',
    });
    try {
      expect(
        (
          await hookDispatcher.dispatch('PreToolUse', {
            conversationId: 'chat',
            toolName: 'echo',
            toolCallId: 'one',
            args: {},
          })
        ).reason,
      ).toBe('native wins');
    } finally {
      off();
    }
  });
  it.each(['string', 'parts'])(
    'keeps the human prompt in the last user message with %s content and reapplies native policy',
    async (shape) => {
      await ready(['SessionStart', 'UserPromptSubmit']);
      const content =
        shape === 'string'
          ? 'The actual user request.'
          : [
              { type: 'text', text: 'The actual user request.' },
              { type: 'image', image: 'fixture-image' },
            ];
      const native = vi.fn(async (messages: unknown[]) => ({ messages }));
      setBridgeLifecycle(hooks, native);
      const input = {
        conversationId: 'chat',
        messages: [{ role: 'user', content }],
        systemPrompt: 'Native policy',
        cwd: f.root,
      };
      const result = await dispatchBridgeEvent('UserPromptSubmit', input);
      expect(result.denied).toBe(false);
      expect(result.payload.messages).toHaveLength(1);
      const prompt = result.payload.messages.at(-1)!;
      expect(JSON.stringify(prompt.content)).toContain('The actual user request.');
      expect(JSON.stringify(prompt.content)).toContain('fixture context UserPromptSubmit');
      if (shape === 'parts') expect(prompt.content).toContainEqual({ type: 'image', image: 'fixture-image' });
      expect(native).toHaveBeenCalledOnce();
      expect(input.messages[0].content).toEqual(content);
    },
  );
  it('preserves the SDK prompt when SessionStart is first reached at the runtime boundary', async () => {
    await ready(['SessionStart']);
    const calls: StreamOptions[] = [];
    async function* stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
      calls.push(options);
      yield { conversationId: 'chat', type: 'done' };
    }
    for await (const _event of bridgeStream(stream, 'codex', {
      conversationId: 'chat',
      messages: [{ role: 'user', content: 'Keep this task.' }],
      config: f.config,
      tools: [],
      appHome: f.appHome,
    })) {
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].messages).toHaveLength(1);
    expect(calls[0].messages[0]).toMatchObject({ role: 'user', content: expect.stringContaining('Keep this task.') });
    expect(calls[0].messages[0]).toMatchObject({ content: expect.stringContaining('fixture context SessionStart') });
  });
  it('does not submit hook context when native pre-send policy rejects it', async () => {
    await ready(['UserPromptSubmit']);
    setBridgeLifecycle(hooks, async (messages) => ({ messages, abort: true }));
    const result = await dispatchBridgeEvent('UserPromptSubmit', {
      conversationId: 'chat',
      messages: [{ role: 'user', content: 'A request.' }],
    });
    expect(result.denied).toBe(true);
    expect(result.modified).toBe(false);
  });
  it('includes completed tool calls and results in the single stop continuation', async () => {
    await ready(['Stop']);
    const calls: StreamOptions[] = [];
    async function* stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
      calls.push(options);
      if (calls.length === 1) {
        yield {
          conversationId: 'chat',
          type: 'tool-call',
          toolCallId: 'read',
          toolName: 'read_file',
          args: { path: 'fixture' },
        };
        yield {
          conversationId: 'chat',
          type: 'tool-result',
          toolCallId: 'read',
          toolName: 'read_file',
          result: { text: 'fixture result' },
        };
      }
      yield { conversationId: 'chat', type: 'done' };
    }
    for await (const _event of bridgeStream(stream, 'claude-agent', {
      conversationId: 'chat',
      messages: [{ role: 'user', content: 'A task.' }],
      config: f.config,
      tools: [],
      appHome: f.appHome,
    })) {
    }
    expect(calls).toHaveLength(2);
    expect(calls[1].messages).toContainEqual({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'read', toolName: 'read_file', args: { path: 'fixture' } }],
    });
    expect(calls[1].messages).toContainEqual({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'read', toolName: 'read_file', result: { text: 'fixture result' } }],
    });
  });
  it('permits only one bounded Stop continuation and runs native prompt policy again', async () => {
    const fixture = await ready(['SessionStart', 'Stop']);
    const calls: StreamOptions[] = [];
    async function* stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
      calls.push(options);
      yield { conversationId: 'chat', type: 'text-delta', text: 'turn' };
      yield { conversationId: 'chat', type: 'done' };
    }
    const options: StreamOptions = {
      conversationId: 'chat',
      messages: [{ role: 'user', content: 'task' }],
      config: f.config,
      tools: [],
      appHome: f.appHome,
      cwd: f.root,
    };
    const events = [];
    for await (const event of bridgeStream(stream, 'mastra', options)) events.push(event);
    expect(calls).toHaveLength(2);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(
      fixture
        .events()
        .filter((e) => e.hook_event_name === 'Stop')
        .map((e) => e.stop_hook_active),
    ).toEqual([false, true]);
    expect(JSON.stringify(calls[1].messages)).toContain('Continue once');
  });
  it('cannot bypass a native prompt denial through Stop continuation', async () => {
    await ready(['Stop']);
    const stream = vi.fn(async function* (): AsyncGenerator<StreamEvent> {
      yield { conversationId: 'chat', type: 'done' };
    });
    const off = hookDispatcher.register('UserPromptSubmit', () => ({ decision: 'deny', reason: 'blocked' }), {
      mode: 'block',
      source: 'plugin',
    });
    try {
      for await (const _event of bridgeStream(stream, 'mastra', {
        conversationId: 'chat',
        messages: [],
        config: f.config,
        tools: [],
        appHome: f.appHome,
      })) {
      }
      expect(stream).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });
  it('retains a stop continuation when a later command and plugin only provide context', async () => {
    const { root } = await ready(['Stop']);
    writeBridgeFile(join(root, 'hooks/hooks.json'), {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: `'${process.execPath}' '${root}/hook.mjs'` },
              {
                type: 'command',
                command: `'${process.execPath}' -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:"Other stop context"}}))'`,
              },
            ],
          },
        ],
      },
    });
    const other = f.install('codex', 'other');
    installHooks(other, ['Stop']);
    writeBridgeFile(join(other, 'hook.mjs'), 'process.stdout.write("{}")');
    await manager.refresh();
    for (const plugin of manager.inventory())
      await manager.approve(
        plugin.id,
        Object.fromEntries(plugin.components.map((c) => [c.id, c.revision])),
        false,
        plugin.packagePath,
      );
    const reply = await hooks.event(hooks.session('chat', f.root), 'Stop', {});
    expect(reply.continuation).toBe('Continue once for the fixture.');
    expect(reply.context).toBe('Other stop context');
  });
  it('honors cancellation before SessionStart and cleans up watchers and sessions', async () => {
    const fixture = await ready();
    const abort = new AbortController();
    abort.abort();
    let ran = false;
    async function* stream(): AsyncGenerator<StreamEvent> {
      ran = true;
      yield { conversationId: 'chat', type: 'done' };
    }
    await expect(
      (async () => {
        for await (const _event of bridgeStream(stream, 'mastra', {
          conversationId: 'chat',
          messages: [],
          config: f.config,
          tools: [],
          appHome: f.appHome,
          abortSignal: abort.signal,
        })) {
        }
      })(),
    ).rejects.toThrow();
    expect(ran).toBe(false);
    expect(fixture.events().some((e) => e.hook_event_name === 'SessionStart')).toBe(false);
    await hooks.end('chat');
    expect(hooks.sessions.size).toBe(0);
  });
  it('caps asynchronous watcher accumulation and cancels running processes on disable', async () => {
    const { root } = await ready(['UserPromptSubmit']);
    writeBridgeFile(join(root, 'hooks', 'hooks.json'), {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: `'${process.execPath}' -e 'setTimeout(()=>{},50000)'`,
                async: true,
                timeout: 55,
              },
            ],
          },
        ],
      },
    });
    await manager.refresh();
    const p = manager.inventory()[0];
    await manager.approve(p.id, Object.fromEntries(p.components.map((c) => [c.id, c.revision])), false);
    const session = hooks.session('watch', f.root);
    await hooks.event(session, 'UserPromptSubmit', {});
    await hooks.event(session, 'UserPromptSubmit', {});
    expect(session.watchers.size).toBe(1);
    f.config.pluginBridge.enabled = false;
    await manager.stop();
    expect([...session.watchers.values()].every((c) => c.signal.aborted)).toBe(true);
  });
  it('isolates inherited Codex plugins and MCP without changing auth homes or files', () => {
    vi.stubEnv('CODEX_HOME', f.homes.codex);
    writeBridgeFile(
      join(f.homes.codex, 'config.toml'),
      '[mcp_servers.inherited]\ncommand="tool"\n[plugins."sample@fixture"]\nenabled=true\n',
    );
    const project = join(f.root, 'project');
    writeBridgeFile(join(project, '.codex/config.toml'), '[mcp_servers."kai-mcp"]\ncommand="kai"\n');
    const isolated = codexIsolationConfig(project);
    expect(isolated.features).toMatchObject({ plugins: false, remote_plugin: false, hooks: false, codex_hooks: false });
    expect(isolated.plugins).toMatchObject({ _default: { enabled: false }, 'sample@fixture': { enabled: false } });
    expect(isolated.mcp_servers).toMatchObject({ inherited: { enabled: false }, 'kai-mcp': { enabled: false } });
    expect(process.env.CODEX_HOME).toBe(f.homes.codex);
  });
  it('does not invent a disabled MCP transport when no connector is installed', () => {
    vi.stubEnv('CODEX_HOME', f.homes.codex);
    writeBridgeFile(join(f.homes.codex, 'config.toml'), 'model="fixture"\n');
    expect(codexIsolationConfig(f.root).mcp_servers).not.toHaveProperty('kai-mcp');
  });
});

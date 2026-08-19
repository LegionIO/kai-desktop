import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AppConfig } from '../../config/schema.js';
import type { ToolDefinition } from '../../tools/types.js';
import { hookDispatcher } from '../../agent/hooks/dispatcher.js';

const sockets = vi.hoisted(
  () =>
    [] as Array<EventEmitter & { close: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; readyState: number }>,
);
const realtimeWindows = vi.hoisted(
  () =>
    [] as Array<{
      webContents: { id: number; send: ReturnType<typeof vi.fn> };
    }>,
);
const broadcastToWebClients = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getLocale: () => 'en-US' },
  BrowserWindow: { getAllWindows: () => realtimeWindows },
}));
vi.mock('../../web-server/web-clients.js', () => ({
  broadcastToWebClients,
}));
vi.mock('../../computer-use/service.js', () => ({ getExistingComputerUseManager: () => null }));
vi.mock('../../agent/model-catalog.js', () => ({ resolveModelForThread: vi.fn() }));
vi.mock('../../agent/compaction.js', () => ({ compactToolResult: vi.fn(), estimateToolTokens: vi.fn() }));
vi.mock('ws', () => ({
  default: class MockWebSocket extends EventEmitter {
    readyState = 0;
    close = vi.fn();
    send = vi.fn();

    constructor() {
      super();
      sockets.push(this);
    }
  },
}));

const { RealtimeSession, realtimeServerEventPreview } = await import('../realtime-session.js');
const { compactToolResult, estimateToolTokens } = await import('../../agent/compaction.js');

function config(): AppConfig {
  return {
    realtime: {
      provider: 'custom',
      model: 'realtime-test',
      instructions: '',
      custom: { baseUrl: 'wss://realtime.example.test/socket' },
    },
    computerUse: { toolSurface: 'both' },
  } as AppConfig;
}

beforeEach(() => {
  realtimeWindows.length = 0;
  broadcastToWebClients.mockReset();
});

describe('RealtimeSession startup settlement', () => {
  beforeEach(() => {
    sockets.length = 0;
  });

  it('rejects a pending start immediately when close does not emit a socket event', async () => {
    const session = new RealtimeSession(config, []);
    const starting = session.start('chat-1');
    const rejected = expect(starting).rejects.toThrow(/closed before startup completed/);

    session.close();

    await rejected;
    expect(sockets).toHaveLength(1);
    expect(sockets[0].close).toHaveBeenCalledWith(1000, 'Client closing');
  });

  it('rejects a pending start on fatal server teardown without waiting for socket close', async () => {
    const session = new RealtimeSession(config, []);
    const starting = session.start('chat-2');
    const rejected = expect(starting).rejects.toThrow(/provider rejected session/);

    sockets[0].emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'error', error: { code: 'fatal', message: 'provider rejected session' } })),
    );

    await rejected;
    expect(sockets[0].close).toHaveBeenCalledWith(1011, 'Fatal error');
  });

  it('suppresses unchanged session updates and requests the greeting only once', async () => {
    const tool: ToolDefinition = {
      name: 'stable_tool',
      description: 'test tool',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    };
    const session = new RealtimeSession(config, [tool]);
    const starting = session.start('chat-greeting');
    sockets[0].readyState = 1;
    sockets[0].emit('open');
    await starting;

    session.updateTools([tool]);
    const sessionUpdates = sockets[0].send.mock.calls
      .map(([payload]) => JSON.parse(payload as string) as { type?: string })
      .filter((event) => event.type === 'session.update');
    expect(sessionUpdates).toHaveLength(1);

    const acknowledgment = Buffer.from(JSON.stringify({ type: 'session.updated' }));
    sockets[0].emit('message', acknowledgment);
    sockets[0].emit('message', acknowledgment);
    const sentEvents = sockets[0].send.mock.calls.map(
      ([payload]) => JSON.parse(payload as string) as { type?: string },
    );
    expect(sentEvents.filter((event) => event.type === 'conversation.item.create')).toHaveLength(1);
    expect(sentEvents.filter((event) => event.type === 'response.create')).toHaveLength(1);
  });

  it('resets connection-specific update, greeting, and terminal guards when restarted', async () => {
    const onTerminal = vi.fn();
    const session = new RealtimeSession(config, [], onTerminal);
    const firstStart = session.start('chat-restart');
    sockets[0].readyState = 1;
    sockets[0].emit('open');
    await firstStart;
    sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
    session.close();

    expect(onTerminal).toHaveBeenCalledOnce();

    const secondStart = session.start('chat-restart');
    sockets[1].readyState = 1;
    sockets[1].emit('open');
    await secondStart;

    const secondSocketEvents = () =>
      sockets[1].send.mock.calls.map(([payload]) => JSON.parse(payload as string) as { type?: string });
    expect(secondSocketEvents().filter((event) => event.type === 'session.update')).toHaveLength(1);

    sockets[1].emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
    expect(secondSocketEvents().filter((event) => event.type === 'conversation.item.create')).toHaveLength(1);
    expect(secondSocketEvents().filter((event) => event.type === 'response.create')).toHaveLength(1);

    session.close();
    expect(onTerminal).toHaveBeenCalledTimes(2);
  });

  it('ignores messages and close events from a superseded socket', async () => {
    const onTerminal = vi.fn();
    const session = new RealtimeSession(config, [], onTerminal);
    const firstStart = session.start('chat-restart');
    sockets[0].readyState = 1;
    sockets[0].emit('open');
    await firstStart;
    session.close();

    const secondStart = session.start('chat-restart');
    sockets[1].readyState = 1;
    sockets[1].emit('open');
    await secondStart;
    const secondSocketEvents = () =>
      sockets[1].send.mock.calls.map(([payload]) => JSON.parse(payload as string) as { type?: string });

    sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
    sockets[0].emit('close', 1000, Buffer.from('late close'));

    expect(session.status).toBe('connected');
    expect(secondSocketEvents().filter((event) => event.type === 'conversation.item.create')).toHaveLength(0);
    expect(onTerminal).toHaveBeenCalledOnce();

    sockets[1].emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
    expect(secondSocketEvents().filter((event) => event.type === 'conversation.item.create')).toHaveLength(1);

    session.close();
    expect(onTerminal).toHaveBeenCalledTimes(2);
  });
});

describe('RealtimeSession tool validation', () => {
  it('does not publish a late compaction completion into a replacement call', async () => {
    let releaseCompaction!: (value: { content: string; wasCompacted: boolean; extractionDurationMs: number }) => void;
    const compactionGate = new Promise<{
      content: string;
      wasCompacted: boolean;
      extractionDurationMs: number;
    }>((resolve) => {
      releaseCompaction = resolve;
    });
    vi.mocked(estimateToolTokens).mockReturnValue(100);
    vi.mocked(compactToolResult).mockImplementation(async () => await compactionGate);

    const tool: ToolDefinition = {
      name: 'large_tool',
      description: 'test compacted tool',
      inputSchema: z.object({}),
      execute: async () => ({ text: 'large result' }),
    };
    const getConfig = (): AppConfig =>
      ({
        ...config(),
        compaction: { tool: { enabled: true, triggerTokens: 1 } },
      }) as AppConfig;
    const session = new RealtimeSession(getConfig, [tool]);
    const broadcastStreamEvent = vi.fn();
    const access = session as unknown as {
      conversationId: string;
      executeTool: (callId: string, toolName: string, argsJson: string) => Promise<void>;
      broadcastStreamEvent: typeof broadcastStreamEvent;
    };
    access.conversationId = 'chat-original';
    access.broadcastStreamEvent = broadcastStreamEvent;

    const running = access.executeTool('compacted-call', 'large_tool', '{}');
    await vi.waitFor(() => expect(compactToolResult).toHaveBeenCalledOnce());
    expect(broadcastStreamEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool-compaction',
        conversationId: 'chat-original',
        data: expect.objectContaining({ phase: 'start' }),
      }),
    );

    session.close();
    const replacementStart = session.start('chat-replacement');
    const replacementRejected = expect(replacementStart).rejects.toThrow(/closed before startup completed/);
    releaseCompaction({ content: 'compacted result', wasCompacted: true, extractionDurationMs: 5 });
    await running;

    const completionEvents = broadcastStreamEvent.mock.calls
      .map(([event]) => event as { type?: string; conversationId?: string; data?: { phase?: string } })
      .filter((event) => event.type === 'tool-compaction' && event.data?.phase === 'complete');
    expect(completionEvents).toEqual([]);

    session.close();
    await replacementRejected;
  });

  it('aborts an in-flight tool when the provider closes the socket', async () => {
    sockets.length = 0;
    let observedAbortSignal: AbortSignal | undefined;
    const execute = vi.fn(
      async (_args: unknown, context: { abortSignal?: AbortSignal }) =>
        await new Promise<void>((_resolve, reject) => {
          observedAbortSignal = context.abortSignal;
          if (context.abortSignal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          context.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const tool: ToolDefinition = {
      name: 'browser_action',
      description: 'test Browser tool',
      source: 'browser',
      inputSchema: z.object({}),
      execute,
    };
    const session = new RealtimeSession(config, [tool]);
    const starting = session.start('chat-remote-close');
    sockets[0].readyState = 1;
    sockets[0].emit('open');
    await starting;

    const access = session as unknown as {
      executeTool: (callId: string, toolName: string, argsJson: string) => Promise<void>;
    };
    const running = access.executeTool('remote-close-call', 'browser_action', '{}');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    sockets[0].emit('close', 1006, Buffer.from('provider hangup'));

    await running;
    expect(observedAbortSignal?.aborted).toBe(true);
  });

  it('settles a removed tool while an asynchronous PreToolUse hook is pending', async () => {
    let releaseHook!: () => void;
    let hookStarted!: () => void;
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const started = new Promise<void>((resolve) => {
      hookStarted = resolve;
    });
    const execute = vi.fn(async () => ({ ok: true }));
    const tool: ToolDefinition = {
      name: 'browser_action',
      description: 'test Browser tool',
      source: 'browser',
      inputSchema: z.object({}),
      execute,
    };
    const unregister = hookDispatcher.register(
      'PreToolUse',
      async () => {
        hookStarted();
        await hookGate;
      },
      { mode: 'observe', matcher: 'browser_action' },
    );
    try {
      const session = new RealtimeSession(config, [tool]);
      const finishToolCall = vi.fn();
      const access = session as unknown as {
        pendingToolCalls: Map<string, unknown>;
        executeTool: (callId: string, toolName: string, argsJson: string) => Promise<void>;
        finishToolCall: typeof finishToolCall;
      };
      access.finishToolCall = finishToolCall;
      access.pendingToolCalls.set('revoked-call', {
        callId: 'revoked-call',
        name: 'browser_action',
        argumentsJson: '{}',
        startedAt: new Date().toISOString(),
        argumentsSuppressed: true,
      });

      const running = access.executeTool('revoked-call', 'browser_action', '{}');
      await started;
      session.updateTools([]);
      releaseHook();
      await running;

      expect(execute).not.toHaveBeenCalled();
      expect(finishToolCall).toHaveBeenCalledWith(
        'revoked-call',
        'browser_action',
        { error: 'Tool access was revoked before completion.' },
        true,
        expect.any(String),
        undefined,
        false,
      );
      expect(access.pendingToolCalls.has('revoked-call')).toBe(false);
    } finally {
      releaseHook();
      unregister();
    }
  });

  it('updates the provider tool surface and batches revoked outputs before resuming once', () => {
    const tool: ToolDefinition = {
      name: 'browser_action',
      description: 'test Browser tool',
      source: 'browser',
      inputSchema: z.object({}),
      execute: vi.fn(async () => ({ ok: true })),
    };
    const session = new RealtimeSession(config, [tool]);
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const send = vi.fn();
    const access = session as unknown as {
      ws: { readyState: number; send: ReturnType<typeof vi.fn> };
      activeToolCalls: Map<string, unknown>;
    };
    access.ws = { readyState: 1, send };
    access.activeToolCalls.set('revoked-call-1', {
      toolName: tool.name,
      tool,
      abort: firstAbort,
      startedAt: '2026-08-16T00:00:00.000Z',
    });
    access.activeToolCalls.set('revoked-call-2', {
      toolName: tool.name,
      tool,
      abort: secondAbort,
      startedAt: '2026-08-16T00:00:01.000Z',
    });

    session.updateTools([]);

    expect(firstAbort.signal.aborted).toBe(true);
    expect(secondAbort.signal.aborted).toBe(true);
    expect(send.mock.calls.map(([payload]) => (JSON.parse(payload as string) as { type: string }).type)).toEqual([
      'session.update',
      'conversation.item.create',
      'conversation.item.create',
      'response.create',
    ]);
  });

  it('does not execute or emit a tool result after hangup while a hook is pending', async () => {
    let releaseHook!: () => void;
    let hookStarted!: () => void;
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const started = new Promise<void>((resolve) => {
      hookStarted = resolve;
    });
    const execute = vi.fn(async () => ({ ok: true }));
    const unregister = hookDispatcher.register(
      'PreToolUse',
      async () => {
        hookStarted();
        await hookGate;
      },
      { mode: 'observe', matcher: 'browser_inspect' },
    );
    try {
      const session = new RealtimeSession(config, [
        {
          name: 'browser_inspect',
          description: 'test Browser tool',
          source: 'browser',
          inputSchema: z.object({}),
          execute,
        },
      ]);
      const finishToolCall = vi.fn();
      const access = session as unknown as {
        executeTool: (callId: string, toolName: string, argsJson: string) => Promise<void>;
        finishToolCall: typeof finishToolCall;
      };
      access.finishToolCall = finishToolCall;

      const running = access.executeTool('closed-call', 'browser_inspect', '{}');
      await started;
      session.close();
      releaseHook();
      await running;

      expect(execute).not.toHaveBeenCalled();
      expect(finishToolCall).not.toHaveBeenCalled();
    } finally {
      releaseHook();
      unregister();
    }
  });

  it('applies each tool Zod schema before execution', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const tool: ToolDefinition = {
      name: 'bounded_tool',
      description: 'test tool',
      inputSchema: z.object({ mode: z.enum(['safe']), count: z.number().int().max(3).default(2) }),
      execute,
    };
    const session = new RealtimeSession(config, [tool]);
    const finishToolCall = vi.fn();
    const access = session as unknown as {
      executeTool: (callId: string, toolName: string, argsJson: string) => Promise<void>;
      finishToolCall: typeof finishToolCall;
    };
    access.finishToolCall = finishToolCall;

    await access.executeTool('invalid-call', 'bounded_tool', JSON.stringify({ mode: 'unsafe', count: 99 }));
    expect(execute).not.toHaveBeenCalled();
    expect(finishToolCall).toHaveBeenCalledWith(
      'invalid-call',
      'bounded_tool',
      expect.objectContaining({ error: expect.any(String) }),
      true,
      expect.any(String),
      undefined,
    );

    finishToolCall.mockClear();
    await access.executeTool('valid-call', 'bounded_tool', JSON.stringify({ mode: 'safe' }));
    expect(execute).toHaveBeenCalledWith(
      { mode: 'safe', count: 2 },
      expect.objectContaining({ toolCallId: 'valid-call' }),
    );
  });

  it('aborts the original call and emits one protocol error for a duplicate active call id', async () => {
    let observedSignal: AbortSignal | undefined;
    const execute = vi.fn(
      async (_args: unknown, context: { abortSignal?: AbortSignal }) =>
        await new Promise<void>((_resolve, reject) => {
          observedSignal = context.abortSignal;
          context.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const tool: ToolDefinition = {
      name: 'browser_action',
      description: 'gated Browser tool',
      source: 'browser',
      inputSchema: z.object({}),
      execute,
    };
    const session = new RealtimeSession(config, [tool]);
    const finishToolCall = vi.fn();
    const access = session as unknown as {
      executeTool: (callId: string, toolName: string, argsJson: string) => Promise<void>;
      finishToolCall: typeof finishToolCall;
    };
    access.finishToolCall = finishToolCall;

    const original = access.executeTool('duplicate-call', 'browser_action', '{}');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await access.executeTool('duplicate-call', 'browser_action', '{}');
    await original;

    expect(observedSignal?.aborted).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(finishToolCall).toHaveBeenCalledOnce();
    expect(finishToolCall).toHaveBeenCalledWith(
      'duplicate-call',
      'browser_action',
      { error: 'Realtime protocol error: duplicate active tool call id.' },
      true,
      expect.any(String),
    );
  });

  it('enforces PreToolUse and PostToolUse around Realtime Browser execution', async () => {
    const execute = vi.fn(async () => ({ raw: true }));
    const tool: ToolDefinition = {
      name: 'browser_action',
      description: 'test Browser tool',
      source: 'browser',
      inputSchema: z.object({ kind: z.literal('type'), text: z.string() }),
      execute,
    };
    const unregisterPre = hookDispatcher.register(
      'PreToolUse',
      () => ({ payload: { args: { kind: 'type', text: 'policy replacement' } } }),
      { mode: 'modify', matcher: 'browser_action' },
    );
    const unregisterPost = hookDispatcher.register(
      'PostToolUse',
      () => ({ payload: { result: { sanitized: true } } }),
      { mode: 'modify', matcher: 'browser_action' },
    );
    try {
      const session = new RealtimeSession(config, [tool]);
      const finishToolCall = vi.fn();
      const access = session as unknown as {
        conversationId: string;
        executeTool: (callId: string, toolName: string, argsJson: string) => Promise<void>;
        finishToolCall: typeof finishToolCall;
      };
      access.conversationId = 'chat-hooks';
      access.finishToolCall = finishToolCall;

      await access.executeTool(
        'browser-call',
        'browser_action',
        JSON.stringify({ kind: 'type', text: 'raw browser secret' }),
      );

      expect(execute).toHaveBeenCalledWith(
        { kind: 'type', text: 'policy replacement' },
        expect.objectContaining({ toolCallId: 'browser-call', conversationId: 'chat-hooks' }),
      );
      expect(finishToolCall).toHaveBeenCalledWith(
        'browser-call',
        'browser_action',
        { sanitized: true },
        false,
        expect.any(String),
        undefined,
      );
    } finally {
      unregisterPost();
      unregisterPre();
    }
  });

  it('keeps denied Realtime Browser arguments out of PostToolUse', async () => {
    const secret = 'denied-realtime-browser-secret';
    const execute = vi.fn(async () => ({ raw: true }));
    let postPayload: unknown;
    const unregisterPre = hookDispatcher.register(
      'PreToolUse',
      () => ({ decision: 'deny', reason: 'blocked by policy' }),
      { mode: 'block', matcher: 'browser_evaluate' },
    );
    const unregisterPost = hookDispatcher.register(
      'PostToolUse',
      (payload) => {
        postPayload = payload;
        return { payload: { result: { isError: true, error: 'sanitized denial' } } };
      },
      { mode: 'modify', matcher: 'browser_evaluate' },
    );
    try {
      const session = new RealtimeSession(config, [
        {
          name: 'browser_evaluate',
          description: 'test Browser tool',
          source: 'browser',
          inputSchema: z.object({ script: z.string() }),
          execute,
        },
      ]);
      const finishToolCall = vi.fn();
      const broadcastStreamEvent = vi.fn();
      const broadcastRealtimeEvent = vi.fn();
      const access = session as unknown as {
        conversationId: string;
        pendingToolCalls: Map<string, unknown>;
        executeTool: (callId: string, toolName: string, argsJson: string) => Promise<void>;
        finishToolCall: typeof finishToolCall;
        broadcastStreamEvent: typeof broadcastStreamEvent;
        broadcastRealtimeEvent: typeof broadcastRealtimeEvent;
      };
      access.conversationId = 'chat-denied';
      access.finishToolCall = finishToolCall;
      access.broadcastStreamEvent = broadcastStreamEvent;
      access.broadcastRealtimeEvent = broadcastRealtimeEvent;
      access.pendingToolCalls.set('denied-call', {
        callId: 'denied-call',
        name: 'browser_evaluate',
        argumentsJson: JSON.stringify({ script: secret }),
        startedAt: '2026-01-01T00:00:00.000Z',
        argumentsSuppressed: true,
      });

      await access.executeTool('denied-call', 'browser_evaluate', JSON.stringify({ script: secret }));

      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify(postPayload)).not.toContain(secret);
      expect(postPayload).toMatchObject({ args: { redacted: true, reason: 'blocked by policy' } });
      expect(broadcastStreamEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCallId: 'denied-call',
          args: { redacted: true, reason: 'blocked by policy' },
        }),
      );
      expect(JSON.stringify(broadcastStreamEvent.mock.calls)).not.toContain(secret);
      expect(finishToolCall).toHaveBeenCalledWith(
        'denied-call',
        'browser_evaluate',
        { isError: true, error: 'sanitized denial' },
        false,
        expect.any(String),
        undefined,
      );
    } finally {
      unregisterPost();
      unregisterPre();
    }
  });
});

describe('RealtimeSession server-event logging', () => {
  it('redacts unknown event payloads by default', () => {
    const secret = 'future-provider-secret';
    expect(realtimeServerEventPreview('provider.future.event', { secret })).toBe('(event payload redacted)');
    expect(realtimeServerEventPreview('provider.future.event', { secret })).not.toContain(secret);
  });

  it('redacts Browser tool secrets from argument delta and completion previews', () => {
    const secret = 'typed-browser-secret';

    for (const [eventType, event] of [
      ['response.function_call_arguments.delta', { delta: `{"value":"${secret}"}` }],
      ['response.function_call_arguments.done', { arguments: `{"value":"${secret}"}` }],
    ] as const) {
      const preview = realtimeServerEventPreview(eventType, { type: eventType, ...event });
      expect(preview).toBe('(function-call arguments redacted)');
      expect(preview).not.toContain(secret);
    }
  });

  it('redacts function-call output-item previews that contain completed arguments', () => {
    const secret = 'completed-browser-secret';

    for (const eventType of ['response.output_item.added', 'response.output_item.done', 'conversation.item.created']) {
      const preview = realtimeServerEventPreview(eventType, {
        type: eventType,
        item: { type: 'function_call', name: 'browser_action', arguments: `{"value":"${secret}"}` },
      });
      expect(preview).toBe('(function-call arguments redacted)');
      expect(preview).not.toContain(secret);
    }
  });

  it('redacts echoed function-call results from conversation item previews', () => {
    const secret = 'authenticated-page-recovery-data';
    const preview = realtimeServerEventPreview('conversation.item.created', {
      type: 'conversation.item.created',
      item: {
        type: 'function_call_output',
        call_id: 'browser-call',
        output: JSON.stringify({ text: secret }),
      },
    });

    expect(preview).toBe('(function-call output redacted)');
    expect(preview).not.toContain(secret);
  });

  it('redacts aggregate response.done output containing completed arguments', () => {
    const secret = 'aggregate-browser-password';
    const preview = realtimeServerEventPreview('response.done', {
      type: 'response.done',
      response: {
        status: 'completed',
        output: [
          {
            type: 'function_call',
            name: 'browser_action',
            arguments: JSON.stringify({ kind: 'type', text: secret }),
          },
        ],
      },
    });

    expect(preview).toBe('(response aggregate redacted)');
    expect(preview).not.toContain(secret);
  });
});

/**
 * IPC handler tests for `electron/ipc/agent.ts`.
 *
 * Covers the lightweight approval / sub-agent channels exposed by
 * `registerAgentHandlers`. These do not need the full streaming pipeline,
 * so we can register them through `createIpcHarness` after mocking the
 * heavy production dependencies (Mastra, web-server, plugins, etc.).
 *
 * The `stubMastra` fixture self-tests live in
 * `test-utils/__tests__/runtime-stubs.test.ts` — they pin the fake-runtime
 * shape but do not exercise any agent.ts code path.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow } from 'electron';
import { z } from 'zod';

import { createIpcHarness } from '../../../test-utils/ipc-harness.js';
import type { ToolDefinition, ToolExecutionContext } from '../../tools/types.js';
import { hookDispatcher } from '../../agent/hooks/dispatcher.js';

// ---------------------------------------------------------------------------
// Mocks for the heavy production graph that `electron/ipc/agent.ts` pulls in.
//
// We are testing the simple approval / sub-agent handlers, not the streaming
// pipeline, so every dependency below is mocked with a minimal shape that
// keeps the import side-effects predictable.
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

const getExistingBrowserManager = vi.hoisted(() => vi.fn());
const appendConversationMessages = vi.hoisted(() => vi.fn());
const isRealtimeConversationTurnActive = vi.hoisted(() => vi.fn(() => false));
const isRealtimeConversationBrowserAuthorized = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../browser/service.js', () => ({
  getExistingBrowserManager,
}));
vi.mock('../realtime.js', () => ({
  isRealtimeConversationTurnActive,
  isRealtimeConversationBrowserAuthorized,
}));

// The dedicated approval window pulls ipcMain/screen from electron; stub it so
// this test's minimal electron mock doesn't need them.
vi.mock('../../approval-window.js', () => ({
  openApprovalWindow: vi.fn(),
  closeApprovalWindow: vi.fn(),
  closeAllApprovalWindows: vi.fn(),
  registerApprovalWindowIpc: vi.fn(),
  hasApprovalWindow: vi.fn(() => false),
}));

vi.mock('../../web-server/web-clients.js', () => ({
  broadcastToWebClients: vi.fn(),
  webClients: new Set(),
}));

vi.mock('../../web-server/web-server.js', () => ({
  createLoginToken: vi.fn(() => 'token'),
}));

vi.mock('../../agent/model-catalog.js', () => ({
  resolveModelCatalog: vi.fn(() => ({ entries: [], defaultEntry: null })),
  resolveStreamConfig: vi.fn(() => null),
  resolveModelForThread: vi.fn(() => null),
}));

vi.mock('../../agent/mastra-agent.js', () => ({
  createWorkspaceToolDefinitions: vi.fn(async () => []),
  normalizeAgentCwd: vi.fn((cwd: string | undefined) => cwd ?? '/tmp'),
  streamAgentResponse: vi.fn(),
  WORKSPACE_MUTATING_TOOLS: new Set([
    'mastra_workspace_write_file',
    'mastra_workspace_edit_file',
    'mastra_workspace_delete',
    'mastra_workspace_execute_command',
  ]),
}));

vi.mock('../../agent/title-generation.js', () => ({
  generateTitle: vi.fn(async () => 'Test Title'),
}));

vi.mock('../../agent/runtime-switch.js', () => ({
  detectRuntimeSwitch: vi.fn(() => null),
  generateSwitchContext: vi.fn(async () => ''),
  wrapSwitchContext: vi.fn((ctx: string) => ctx),
}));

vi.mock('../../agent/compaction.js', () => ({
  shouldCompact: vi.fn(() => ({ shouldCompact: false })),
  compactConversationPrefix: vi.fn(async () => ({ compactedMessages: null })),
  compactToolResult: vi.fn(async (content: string) => ({ content, wasCompacted: false })),
  estimateToolTokens: vi.fn(() => 0),
  messageContentSignature: vi.fn((message: unknown) => JSON.stringify(message)),
}));

vi.mock('../../agent/tool-observer.js', () => ({
  ToolObserverManager: vi.fn(),
  resolveToolObserverConfig: vi.fn(() => ({})),
  summarizeLatestUserRequest: vi.fn(() => ''),
  summarizeThreadContext: vi.fn(() => ''),
}));

vi.mock('../../agent/runtime/index.js', () => ({
  resolveRuntimeForStream: vi.fn(async () => ({
    runtime: { id: 'mastra', name: 'Mastra', capabilities: {} },
    resolution: { runtimeId: 'mastra' },
  })),
  getAvailableRuntimes: vi.fn(async () => [{ id: 'mastra', name: 'Mastra', available: true }]),
  getActiveRuntimeId: vi.fn(async () => 'mastra'),
}));

vi.mock('../../tools/sub-agent.js', () => ({
  sendSubAgentFollowUp: vi.fn(() => true),
  sendSubAgentFollowUpByToolCall: vi.fn(() => true),
  stopSubAgent: vi.fn(() => true),
  getActiveSubAgentIds: vi.fn(() => ['sub-1', 'sub-2']),
}));

vi.mock('../../tools/naming.js', () => ({
  ensureSafeToolDefinitions: vi.fn((tools: unknown[]) => tools),
  dedupeToolNames: vi.fn((tools: ToolDefinition[]) => {
    const seen = new Set<string>();
    return tools.map((tool, index) => {
      if (!seen.has(tool.name)) {
        seen.add(tool.name);
        return tool;
      }
      const name = `${tool.name}_deduped_${index}`;
      seen.add(name);
      return {
        ...tool,
        name,
        originalName: tool.originalName ?? tool.name,
        aliases: [...new Set([...(tool.aliases ?? []), tool.name])],
      };
    });
  }),
  findToolByName: vi.fn(
    (tools: ToolDefinition[], name: string) =>
      tools.find((tool) => tool.name === name) ?? tools.find((tool) => tool.aliases?.includes(name)),
  ),
}));

vi.mock('../usage.js', () => ({
  recordUsageEvent: vi.fn(),
}));

vi.mock('../config.js', () => ({
  readEffectiveConfig: vi.fn(() => ({
    models: { defaultModelKey: 'placeholder', providers: {}, catalog: [] },
    profiles: [],
    defaultProfileKey: undefined,
    titleGeneration: { enabled: true },
  })),
}));

vi.mock('../conversations.js', () => ({
  broadcastUpsert: vi.fn(),
  appendConversationMessages,
  ensureConversationTree: vi.fn((c: { messageTree?: unknown[]; headId?: string | null }) => ({
    tree: c.messageTree ?? [],
    headId: c.headId ?? null,
  })),
  getConversationBranch: vi.fn((tree: unknown[]) => tree),
}));
vi.mock('../conversation-store.js', () => ({
  readConversation: vi.fn(() => null),
  writeConversation: vi.fn(),
  isWriteTombstoned: vi.fn(() => false),
  isRecentlyDeleted: vi.fn(() => false),
  conversationExistenceState: vi.fn(() => 'absent'),
}));

// ---------------------------------------------------------------------------
// Imports under test — must come after the mocks above so `vi.mock` rewrites
// the resolution before the production module loads.
// ---------------------------------------------------------------------------

import {
  registerAgentHandlers,
  registerTools,
  registerToolsPreservingBrowserState,
  updateBrowserTools,
  getRegisteredTools,
  hasActiveStreams,
  broadcastAgentStreamEvent,
  mayPersistConversationForBrowserAuthority,
  __internal,
  isSupersededRunEvent,
} from '../agent.js';
import {
  pendingToolApprovals,
  registerPendingApproval,
  setPrimaryApprovalWindowResolver,
  setToolApprovalOwnerResolver,
  approvalKey,
} from '../tool-approval.js';
import { pendingQuestionAnswers } from '../../tools/ask-user.js';
import { closeApprovalWindow } from '../../approval-window.js';
import { readConversation, writeConversation } from '../conversation-store.js';
import { broadcastUpsert } from '../conversations.js';

describe('startup tool registration', () => {
  const tool = (name: string, source: ToolDefinition['source']): ToolDefinition => ({
    name,
    source,
    description: name,
    inputSchema: z.any(),
    execute: vi.fn(async () => ({ ok: true })),
  });

  afterEach(() => registerTools([]));

  it('warns only when enforcing hooks coexist with unwrapped runtime built-ins', () => {
    expect(__internal.shouldWarnAboutUnwrappedRuntimeTools({ builtInTools: true }, true)).toBe(true);
    expect(__internal.shouldWarnAboutUnwrappedRuntimeTools({ builtInTools: false }, true)).toBe(false);
    expect(__internal.shouldWarnAboutUnwrappedRuntimeTools({ builtInTools: true }, false)).toBe(false);
  });

  it('fails closed for enforcing-hook tool events whose execution ids cannot be correlated', () => {
    const bridged = {
      conversationId: 'chat-1',
      type: 'tool-call',
      toolCallId: 'stream-id',
      toolName: 'host_tool',
      args: { secret: 'raw' },
    } as const;
    __internal.protectUnresolvedToolCallArgs(bridged as never, true, true, false);
    expect(bridged).toEqual({
      conversationId: 'chat-1',
      type: 'tool-call',
      toolCallId: 'stream-id',
      toolName: 'host_tool',
      args: {
        redacted: true,
        reason: 'Arguments hidden because enforcing tool hooks cannot be correlated with this runtime event.',
      },
      argsPending: false,
    });

    const correctable = {
      conversationId: 'chat-1',
      type: 'tool-call',
      toolCallId: 'shared-id',
      toolName: 'host_tool',
      args: { secret: 'raw' },
    } as const;
    __internal.protectUnresolvedToolCallArgs(correctable as never, true, true, true);
    expect(correctable.args).toEqual({ pending: true });
    expect((correctable as { argsPending?: boolean }).argsPending).toBe(true);

    const providerNative = {
      conversationId: 'chat-1',
      type: 'tool-call',
      toolCallId: 'native-id',
      toolName: 'provider_tool',
      args: { visible: true },
    } as const;
    __internal.protectUnresolvedToolCallArgs(providerNative as never, true, false, false);
    expect(providerNative.args).toEqual({ visible: true });
  });

  it('permanently clears the Browser capability bit on live text streams', () => {
    const streams = [
      { nativeBrowserInitiator: true, nativeBrowserTools: true },
      { nativeBrowserInitiator: false, nativeBrowserTools: false },
    ];

    __internal.markTextBrowserCapabilitiesRevoked(streams);

    expect(streams).toEqual([
      { nativeBrowserInitiator: true, nativeBrowserTools: false },
      { nativeBrowserInitiator: false, nativeBrowserTools: false },
    ]);
  });

  it('dismisses only Browser approvals when revoking a live text stream', () => {
    const browserResolve = vi.fn();
    const genericResolve = vi.fn();
    const otherRunResolve = vi.fn();
    const streams = new Map([['chat-1', { token: 'run-1', nativeBrowserInitiator: true, nativeBrowserTools: true }]]);
    const approvals = [
      {
        authority: 'native-browser' as const,
        streamOwner: { conversationId: 'chat-1', streamToken: 'run-1' },
        resolve: browserResolve,
      },
      {
        authority: 'any-renderer' as const,
        streamOwner: { conversationId: 'chat-1', streamToken: 'run-1' },
        resolve: genericResolve,
      },
      {
        authority: 'native-browser' as const,
        streamOwner: { conversationId: 'chat-1', streamToken: 'run-2' },
        resolve: otherRunResolve,
      },
    ];
    setToolApprovalOwnerResolver((conversationId, browserOwnerId, authority) => {
      const stream = streams.get(conversationId);
      const authorized =
        authority === 'native-browser'
          ? stream?.nativeBrowserTools
          : stream?.nativeBrowserInitiator || stream?.nativeBrowserTools;
      return authorized && stream?.token === browserOwnerId
        ? { conversationId, streamToken: browserOwnerId }
        : undefined;
    });

    __internal.revokeTextBrowserCapabilities(streams, approvals);

    expect(streams.get('chat-1')?.nativeBrowserTools).toBe(false);
    expect(browserResolve).toHaveBeenCalledWith('dismiss');
    expect(genericResolve).not.toHaveBeenCalled();
    expect(otherRunResolve).not.toHaveBeenCalled();
    expect(() =>
      registerPendingApproval('late-text-browser-approval', undefined, 'native-browser', {
        conversationId: 'chat-1',
        browserOwnerId: 'run-1',
      }),
    ).toThrow(/no longer authorized/);
    expect(pendingToolApprovals.has(approvalKey('chat-1', 'late-text-browser-approval'))).toBe(false);
    const genericAfterRevocation = registerPendingApproval('late-text-generic-approval', undefined, 'any-renderer', {
      conversationId: 'chat-1',
      browserOwnerId: 'run-1',
    });
    expect(pendingToolApprovals.get(approvalKey('chat-1', 'late-text-generic-approval'))?.streamOwner).toMatchObject({
      conversationId: 'chat-1',
      streamToken: 'run-1',
    });
    pendingToolApprovals.get(approvalKey('chat-1', 'late-text-generic-approval'))!.resolve(false);
    void genericAfterRevocation;
    setToolApprovalOwnerResolver(null);
  });

  it('preserves Browser enablement changes made while the startup registry is building', () => {
    registerTools([tool('existing', 'builtin')]);
    updateBrowserTools([]);
    registerToolsPreservingBrowserState([tool('startup', 'builtin'), tool('stale_browser', 'browser')]);
    expect(getRegisteredTools().map(({ name }) => name)).toEqual(['startup']);

    updateBrowserTools([tool('live_browser', 'browser')]);
    registerToolsPreservingBrowserState([tool('rebuilt', 'builtin')]);
    expect(getRegisteredTools().map(({ name }) => name)).toEqual(['rebuilt', 'live_browser']);
  });

  it('keeps native Browser tool names authoritative across hot-swap collisions', () => {
    const pluginCollision = { ...tool('browser_tabs', 'plugin'), sourceId: 'collision-plugin' };
    registerTools([pluginCollision, tool('ordinary', 'builtin')]);

    updateBrowserTools([tool('browser_tabs', 'browser')]);

    const registered = getRegisteredTools();
    expect(registered.at(-1)).toMatchObject({ name: 'browser_tabs', source: 'browser' });
    expect(registered.find((candidate) => candidate.source === 'plugin')).toMatchObject({
      name: expect.not.stringMatching(/^browser_tabs$/),
      aliases: expect.arrayContaining(['browser_tabs']),
    });
    expect(new Set(registered.map((candidate) => candidate.name)).size).toBe(registered.length);
  });
});

describe('Browser tool hook exposure', () => {
  const tabId = '11111111-1111-4111-8111-111111111111';
  const credentialId = '22222222-2222-4222-8222-222222222222';

  it('redacts malformed primitive Browser arguments instead of echoing partial secrets', () => {
    expect(__internal.redactBrowserToolArgsForExposure('browser_evaluate', 'partial-secret-script')).toEqual({
      redacted: true,
      reason: 'Invalid Browser tool arguments.',
    });
  });

  it.each(['browser_action', 'kai/browser_action', 'mcp__kai__browser_action'])(
    'redacts typed secrets before %s arguments leave the executor',
    (toolName) => {
      const args = { kind: 'type', selector: '#password', value: 'one-time-code' };

      expect(__internal.redactBrowserToolArgsForExposure(toolName, args)).toEqual({
        kind: 'type',
        selector: '[redacted browser selector: 9 characters]',
        value: '[redacted typed text: 13 characters]',
      });
      expect(args.value).toBe('one-time-code');
    },
  );

  it('uses per-tool and per-action allowlists for every Browser tool', () => {
    expect(
      __internal.redactBrowserToolArgsForExposure('browser_tabs', {
        action: 'close',
        tabId,
        url: 'https://example.com/?secret=tabs-secret',
        background: true,
      }),
    ).toEqual({ action: 'close', tabId });
    expect(
      __internal.redactBrowserToolArgsForExposure('browser_inspect', {
        tabId,
        selector: 'inspect-secret',
      }),
    ).toEqual({ tabId });
    expect(
      __internal.redactBrowserToolArgsForExposure('browser_action', {
        kind: 'click',
        x: 10,
        y: 20,
        value: 'click-secret',
        keys: ['key-secret'],
      }),
    ).toEqual({ kind: 'click', x: 10, y: 20 });
    expect(
      __internal.redactBrowserToolArgsForExposure('browser_screenshot', {
        tabId,
        mode: 'element',
        selector: '[data-account="screenshot-secret"]',
        saveToFile: true,
        script: 'screenshot-script-secret',
      }),
    ).toEqual({
      tabId,
      mode: 'element',
      selector: '[redacted browser screenshot selector: 34 characters]',
      saveToFile: true,
    });
    expect(
      __internal.redactBrowserToolArgsForExposure('browser_evaluate', {
        tabId,
        script: 'evaluate-secret',
        selector: 'evaluate-selector-secret',
      }),
    ).toEqual({ tabId, script: '[redacted browser script: 15 characters]' });
    expect(
      __internal.redactBrowserToolArgsForExposure('browser_autofill', {
        tabId,
        credentialId,
        password: 'autofill-secret',
      }),
    ).toEqual({ tabId, credentialId });
  });

  it('fails closed for malformed Browser discriminators, ids, and nested key payloads', () => {
    const secret = 'never-expose-this-otp';
    const invalid = { redacted: true, reason: 'Invalid Browser tool arguments.' };
    const exposed = [
      __internal.redactBrowserToolArgsForExposure('browser_tabs', { action: secret }),
      __internal.redactBrowserToolArgsForExposure('browser_inspect', { tabId: secret }),
      __internal.redactBrowserToolArgsForExposure('browser_screenshot', { mode: secret }),
      __internal.redactBrowserToolArgsForExposure('browser_autofill', { credentialId: secret }),
      __internal.redactBrowserToolArgsForExposure('browser_action', { kind: secret }),
      __internal.redactBrowserToolArgsForExposure('browser_action', {
        kind: 'press',
        keys: [{ secret }],
      }),
    ];

    expect(exposed).toEqual(Array.from({ length: exposed.length }, () => invalid));
    expect(JSON.stringify(exposed)).not.toContain(secret);
  });

  it.each(['browser_action', 'kai/browser_action', 'mcp__kai__browser_action'])(
    'redacts selector and semantic target strings before %s arguments leave the executor',
    (toolName) => {
      expect(
        __internal.redactBrowserToolArgsForExposure(toolName, {
          kind: 'click',
          selector: '[data-account="secret-user"]',
          name: 'Recovery code 123456',
          text: 'private workspace',
          x: 10,
          y: 20,
        }),
      ).toEqual({
        kind: 'click',
        selector: '[redacted browser selector: 28 characters]',
        name: '[redacted browser target name: 20 characters]',
        text: '[redacted browser target text: 17 characters]',
        x: 10,
        y: 20,
      });
    },
  );

  it.each(['browser_evaluate', 'kai/browser_evaluate', 'mcp__kai__browser_evaluate'])(
    'redacts injected scripts before %s arguments leave the executor',
    (toolName) => {
      const args = { tabId, script: `document.querySelector('#token').value = 'secret'` };

      expect(__internal.redactBrowserToolArgsForExposure(toolName, args)).toEqual({
        tabId,
        script: `[redacted browser script: ${args.script.length} characters]`,
      });
      expect(args.script).toContain("'secret'");
    },
  );

  it.each(['browser_tabs', 'kai/browser_tabs', 'mcp__kai__browser_tabs'])(
    'redacts secret-bearing open URLs before %s arguments leave the executor',
    (toolName) => {
      const args = {
        action: 'open',
        url: 'https://alice:url-password@example.com/oauth/callback?code=query-secret#fragment-secret',
      };

      expect(__internal.redactBrowserToolArgsForExposure(toolName, args)).toEqual({
        action: 'open',
        url: '[redacted browser URL: https://example.com]',
      });
      expect(args.url).toContain('query-secret');
    },
  );

  it.each([
    '[redacted browser URL: https://example.com]forged-secret',
    '[redacted browser address or search: 7 characters]forged-secret',
    '[redacted browser URL: https://user@example.com]',
  ])('does not trust forged redaction markers in Browser locations: %s', (url) => {
    expect(__internal.redactBrowserToolArgsForExposure('browser_tabs', { action: 'open', url })).toEqual({
      action: 'open',
      url: `[redacted browser address or search: ${url.length} characters]`,
    });
  });

  it('preserves only exact canonical Browser location redaction markers', () => {
    for (const url of [
      '[redacted browser URL: https://example.com]',
      '[redacted browser address or search: 42 characters]',
    ]) {
      expect(__internal.redactBrowserToolArgsForExposure('browser_tabs', { action: 'open', url })).toEqual({
        action: 'open',
        url,
      });
    }
  });

  it.each(['browser_action', 'kai/browser_action', 'mcp__kai__browser_action'])(
    'redacts navigation URLs and printable press keys before %s arguments leave the executor',
    (toolName) => {
      expect(
        __internal.redactBrowserToolArgsForExposure(toolName, {
          kind: 'navigate',
          url: 'https://example.com/reset?token=secret-token',
        }),
      ).toEqual({ kind: 'navigate', url: '[redacted browser URL: https://example.com]' });
      expect(
        __internal.redactBrowserToolArgsForExposure(toolName, {
          kind: 'press',
          keys: ['Control', 's', 'e', 'c', 'r', 'e', 't', 'Enter'],
        }),
      ).toEqual({
        kind: 'press',
        keys: [
          'Control',
          '[redacted key input: 1 characters]',
          '[redacted key input: 1 characters]',
          '[redacted key input: 1 characters]',
          '[redacted key input: 1 characters]',
          '[redacted key input: 1 characters]',
          '[redacted key input: 1 characters]',
          'Enter',
        ],
      });
    },
  );
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Production handlers are registered with the signature
// `(event, ...args) => ...`. The harness passes args verbatim, so tests must
// supply an event placeholder as the first argument when invoking.
const FAKE_EVENT = Object.freeze({}) as unknown;

beforeEach(() => {
  pendingToolApprovals.clear();
  pendingQuestionAnswers.clear();
  getExistingBrowserManager.mockReset().mockReturnValue(null);
  appendConversationMessages.mockReset();
  isRealtimeConversationTurnActive.mockReset().mockReturnValue(false);
  isRealtimeConversationBrowserAuthorized.mockReset().mockReturnValue(false);
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
  setPrimaryApprovalWindowResolver(null);
});

afterEach(() => {
  pendingToolApprovals.clear();
  pendingQuestionAnswers.clear();
  setPrimaryApprovalWindowResolver(null);
});

// ---------------------------------------------------------------------------
// Approval-channel coverage
// ---------------------------------------------------------------------------

describe('agent IPC: tool approval channels', () => {
  it('routes Browser-owned generic approvals only to the primary renderer', () => {
    const primarySend = vi.fn();
    const unrelatedSend = vi.fn();
    const primary = {
      isDestroyed: () => false,
      webContents: { id: 11, isDestroyed: () => false, send: primarySend },
    };
    const unrelated = {
      isDestroyed: () => false,
      webContents: { id: 22, isDestroyed: () => false, send: unrelatedSend },
    };
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([primary, unrelated] as never);
    setPrimaryApprovalWindowResolver(() => primary as never);
    pendingToolApprovals.set('owned-question', {
      resolve: vi.fn(),
      authority: 'any-renderer',
      streamOwner: { conversationId: 'chat-1', streamToken: 'run-1' },
    });

    broadcastAgentStreamEvent({
      type: 'tool-approval-required',
      conversationId: 'chat-1',
      toolCallId: 'owned-question',
      toolName: 'ask_user',
      args: { questions: [{ question: 'Private browser context?' }] },
    } as never);

    expect(primarySend).toHaveBeenCalledOnce();
    expect(unrelatedSend).not.toHaveBeenCalled();
  });

  it('resolves the pending approval promise with true on agent:approve-tool', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });

    const decisions: Array<boolean | 'dismiss'> = [];
    const pending = new Promise<boolean | 'dismiss'>((resolve) => {
      pendingToolApprovals.set('tc-approve', { resolve, authority: 'any-renderer' });
    }).then((value) => {
      decisions.push(value);
      return value;
    });

    const result = await harness.invoke<{ ok: boolean }>('agent:approve-tool', FAKE_EVENT, 'tc-approve');
    expect(result).toEqual({ ok: true });

    await pending;
    expect(decisions).toEqual([true]);
    expect(pendingToolApprovals.has('tc-approve')).toBe(false);
    // Answering inline must also close the dedicated approval window (sync dismissal).
    expect(closeApprovalWindow).toHaveBeenCalledWith('tc-approve', undefined);
  });

  it('resolves the pending approval promise with false on agent:reject-tool', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });

    const decisions: Array<boolean | 'dismiss'> = [];
    const pending = new Promise<boolean | 'dismiss'>((resolve) => {
      pendingToolApprovals.set('tc-reject', { resolve, authority: 'any-renderer' });
    }).then((value) => {
      decisions.push(value);
      return value;
    });

    const result = await harness.invoke<{ ok: boolean }>('agent:reject-tool', FAKE_EVENT, 'tc-reject');
    expect(result).toEqual({ ok: true });

    await pending;
    expect(decisions).toEqual([false]);
    expect(pendingToolApprovals.has('tc-reject')).toBe(false);
    expect(closeApprovalWindow).toHaveBeenCalledWith('tc-reject', undefined);
  });

  it('resolves with the sentinel "dismiss" string on agent:dismiss-tool', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });

    const decisions: Array<boolean | 'dismiss'> = [];
    const pending = new Promise<boolean | 'dismiss'>((resolve) => {
      pendingToolApprovals.set('tc-dismiss', { resolve, authority: 'any-renderer' });
    }).then((value) => {
      decisions.push(value);
      return value;
    });

    await harness.invoke('agent:dismiss-tool', FAKE_EVENT, 'tc-dismiss');
    await pending;
    expect(decisions).toEqual(['dismiss']);
    expect(closeApprovalWindow).toHaveBeenCalledWith('tc-dismiss', undefined);
  });

  it('stores answers and approves the call on agent:answer-tool-question', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });

    const decisions: Array<boolean | 'dismiss'> = [];
    new Promise<boolean | 'dismiss'>((resolve) => {
      pendingToolApprovals.set('tc-ask', { resolve, authority: 'any-renderer' });
    }).then((value) => {
      decisions.push(value);
    });

    const answers = { q1: 'Yes please' };
    await harness.invoke('agent:answer-tool-question', FAKE_EVENT, 'tc-ask', answers);

    expect(pendingQuestionAnswers.get('tc-ask')).toEqual(answers);
    // Drain microtasks so the resolved promise's `.then` runs.
    await Promise.resolve();
    expect(decisions).toEqual([true]);
  });

  it('STASHES answers on agent:answer-tool-question even when the toolCallId has no live pending approval (raced abort)', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });

    // No pendingToolApprovals entry: the turn's controller already aborted
    // (superseded / plan-restart) and settled+removed the approval a beat before
    // the user's fully-submitted answer landed. The OLD behavior dropped the
    // answer here, and the tool then emitted "No user response received" even
    // though the user answered. The answer must now be preserved so the gate /
    // re-invoked execute can recover it (bounded FIFO prevents a leak).
    const result = await harness.invoke<{ ok: boolean }>('agent:answer-tool-question', FAKE_EVENT, 'tc-raced', {
      q1: 'The answer I submitted',
    });

    expect(result).toEqual({ ok: true });
    expect(pendingQuestionAnswers.get('tc-raced')).toEqual({ q1: 'The answer I submitted' });
  });

  it('rejects a malformed answer frame from the untyped web boundary and stashes nothing (R132)', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });
    // A non-string toolCallId (e.g. a huge object used as the Map key) is rejected.
    const objId = await harness.invoke<{ ok: boolean; error?: string }>(
      'agent:answer-tool-question',
      FAKE_EVENT,
      { big: 'x'.repeat(10) } as unknown as string,
      { q: 'a' },
    );
    expect(objId.ok).toBe(false);
    expect(objId.error).toBe('invalid-tool-call-id');
    // Non-string answer values are rejected (not silently counted as 0 bytes downstream).
    const badVal = await harness.invoke<{ ok: boolean; error?: string }>(
      'agent:answer-tool-question',
      FAKE_EVENT,
      'tc-badval',
      { q: { nested: 'y' } } as unknown as Record<string, string>,
    );
    expect(badVal.ok).toBe(false);
    expect(badVal.error).toBe('invalid-answers');
    expect(pendingQuestionAnswers.has('tc-badval')).toBe(false);

    // A non-plain object (Map/ArrayBuffer/class instance) whose Object.values() is empty must be
    // rejected — else byte-accounting measures it as {} while structured-clone retains its
    // payload in MAIN (R137 f-7).
    const mapFrame = await harness.invoke<{ ok: boolean; error?: string }>(
      'agent:answer-tool-question',
      FAKE_EVENT,
      'tc-map',
      new Map([['q', 'a']]) as unknown as Record<string, string>,
    );
    expect(mapFrame.ok).toBe(false);
    expect(mapFrame.error).toBe('invalid-answers');
    expect(pendingQuestionAnswers.has('tc-map')).toBe(false);
  });

  it('returns ok=true on agent:approve-tool when no pending entry exists', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });

    // No entry has been registered for "ghost". The handler should treat that
    // as a benign no-op so out-of-order renderer clicks do not crash the IPC.
    const result = await harness.invoke<{ ok: boolean }>('agent:approve-tool', FAKE_EVENT, 'ghost');
    expect(result).toEqual({ ok: true });
  });

  it('allows only the primary renderer to resolve a native Browser approval', async () => {
    const primaryFrame = {};
    const primarySender = { mainFrame: primaryFrame };
    const getPrimaryWindow = () => ({ isDestroyed: () => false, webContents: primarySender }) as never;
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(
          ipc as Parameters<typeof registerAgentHandlers>[0],
          '/tmp/app-home',
          undefined,
          getPrimaryWindow,
        );
      },
    });
    const decisions: boolean[] = [];
    const pending = new Promise<boolean | 'dismiss'>((resolve) => {
      pendingToolApprovals.set('browser-approval', { resolve, authority: 'native-browser' });
    }).then((decision) => {
      if (typeof decision === 'boolean') decisions.push(decision);
    });

    const remote = await harness.invoke<{ ok: boolean; error?: string }>(
      'agent:approve-tool',
      { sender: null, __kaiWebBridge: true },
      'browser-approval',
    );
    expect(remote).toEqual({ ok: false, error: 'native-browser-authority-required' });
    expect(pendingToolApprovals.has('browser-approval')).toBe(true);
    expect(closeApprovalWindow).not.toHaveBeenCalledWith('browser-approval');

    const local = await harness.invoke<{ ok: boolean }>(
      'agent:approve-tool',
      { sender: primarySender, senderFrame: primaryFrame },
      'browser-approval',
    );
    expect(local).toEqual({ ok: true });
    await pending;
    expect(decisions).toEqual([true]);
  });

  it('allows only the exact dedicated approval pop-out to resolve a native Browser approval', async () => {
    const primaryFrame = {};
    const primarySender = { id: 1, mainFrame: primaryFrame };
    const getPrimaryWindow = () => ({ isDestroyed: () => false, webContents: primarySender }) as never;
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(
          ipc as Parameters<typeof registerAgentHandlers>[0],
          '/tmp/app-home',
          undefined,
          getPrimaryWindow,
        );
      },
    });
    const decisions: boolean[] = [];
    const pending = new Promise<boolean | 'dismiss'>((resolve) => {
      pendingToolApprovals.set('window-approval', {
        resolve,
        authority: 'native-browser',
        approvalWindowWebContentsId: 77,
      });
    }).then((decision) => {
      if (typeof decision === 'boolean') decisions.push(decision);
    });

    const foreignFrame = {};
    const foreign = await harness.invoke<{ ok: boolean; error?: string }>(
      'agent:approve-tool',
      { sender: { id: 76, mainFrame: foreignFrame }, senderFrame: foreignFrame },
      'window-approval',
    );
    expect(foreign).toEqual({ ok: false, error: 'native-browser-authority-required' });
    expect(pendingToolApprovals.has('window-approval')).toBe(true);

    const popOutFrame = {};
    const popOut = await harness.invoke<{ ok: boolean; error?: string }>(
      'agent:approve-tool',
      { sender: { id: 77, mainFrame: popOutFrame }, senderFrame: popOutFrame },
      'window-approval',
    );
    expect(popOut).toEqual({ ok: true });
    await pending;
    expect(decisions).toEqual([true]);
  });

  it('returns exact Browser approval input only to the primary renderer or exact pop-out', async () => {
    const primaryFrame = {};
    const primarySender = { id: 1, mainFrame: primaryFrame };
    const getPrimaryWindow = () => ({ isDestroyed: () => false, webContents: primarySender }) as never;
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(
          ipc as Parameters<typeof registerAgentHandlers>[0],
          '/tmp/app-home',
          undefined,
          getPrimaryWindow,
        );
      },
    });
    pendingToolApprovals.set('private-browser-approval', {
      resolve: vi.fn(),
      authority: 'native-browser',
      approvalWindowWebContentsId: 77,
      privateDetails: { browserInput: { script: 'document.title' } },
    });

    await expect(
      harness.invoke(
        'agent:get-tool-approval-private-details',
        { sender: null, __kaiWebBridge: true },
        'private-browser-approval',
      ),
    ).resolves.toBeNull();
    const foreignFrame = {};
    await expect(
      harness.invoke(
        'agent:get-tool-approval-private-details',
        { sender: { id: 76, mainFrame: foreignFrame }, senderFrame: foreignFrame },
        'private-browser-approval',
      ),
    ).resolves.toBeNull();
    await expect(
      harness.invoke(
        'agent:get-tool-approval-private-details',
        { sender: primarySender, senderFrame: primaryFrame },
        'private-browser-approval',
      ),
    ).resolves.toEqual({ browserInput: { script: 'document.title' } });
    const popOutFrame = {};
    await expect(
      harness.invoke(
        'agent:get-tool-approval-private-details',
        { sender: { id: 77, mainFrame: popOutFrame }, senderFrame: popOutFrame },
        'private-browser-approval',
      ),
    ).resolves.toEqual({ browserInput: { script: 'document.title' } });
  });
});

// ---------------------------------------------------------------------------
// Sub-agent inventory channel
// ---------------------------------------------------------------------------

describe('agent IPC: continuation authorization (single driver per turn)', () => {
  it('authorizes the first client per turn token and denies a second, resetting on a new token', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });
    const authorize = (clientId: string, turnToken: string) =>
      harness.invoke<{ authorized: boolean }>(
        'agent:authorize-continuation',
        FAKE_EVENT,
        'conv-auth',
        clientId,
        turnToken,
      );
    // Realistic stream tokens are `${Date.now()}-${rand}`; recency is compared by the ms prefix.
    const tok1 = '1000000000000-aaaa';
    const tok2 = '2000000000000-bbbb'; // strictly newer turn

    // First client wins this turn.
    expect((await authorize('clientA', tok1)).authorized).toBe(true);
    // A different client is DENIED for the same turn (no double-drive).
    expect((await authorize('clientB', tok1)).authorized).toBe(false);
    // The winner re-asking for the same turn is idempotently still authorized.
    expect((await authorize('clientA', tok1)).authorized).toBe(true);
    // A strictly NEWER turn supersedes — a different client can win it (e.g. the winner reloaded).
    expect((await authorize('clientB', tok2)).authorized).toBe(true);
    // Same (new) turn, other client → denied (single driver).
    expect((await authorize('clientA', tok2)).authorized).toBe(false);
    // A DELAYED request for the OLDER turn must NOT revoke the newer turn's winner.
    expect((await authorize('clientA', tok1)).authorized).toBe(false);
  });

  it('agent:finalize-gui-fallback returns confirmed:false when main holds no fallback for the conv', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });
    // No GUI fallback + no persistence accumulator for this conv → the caller must use its own
    // accumulator (confirmed:false), never a spurious confirmation off a stale disk head.
    const res = await harness.invoke<{ confirmed: boolean; headId: string | null }>(
      'agent:finalize-gui-fallback',
      FAKE_EVENT,
      'conv-no-fallback',
      'tok-x',
    );
    expect(res.confirmed).toBe(false);
    expect(res.headId).toBeNull();
  });
});

describe('agent IPC: sub-agent channels', () => {
  it('returns the active sub-agent id list from agent:sub-agent-list', async () => {
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });

    const result = await harness.invoke<{ ids: string[] }>('agent:sub-agent-list', FAKE_EVENT);
    expect(result).toEqual({ ids: ['sub-1', 'sub-2'] });
  });
});

// ---------------------------------------------------------------------------
// Runtime-stub contract tests now live in
// `test-utils/__tests__/runtime-stubs.test.ts` — they pin the fake-runtime
// fixture shape directly and do not need the agent.ts production graph
// loaded. Keeping them here would have inflated this file's stated scope
// (IPC handler coverage) with code that exercises only the fixture.
// ---------------------------------------------------------------------------

describe('extractLastUserText (mirror a GUI-driven turn to co-viewing clients)', () => {
  const { extractLastUserText } = __internal;

  it('returns the last user turn as plain text (string content)', () => {
    expect(
      extractLastUserText([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'how are you doing' },
      ]),
    ).toBe('how are you doing');
  });

  it('extracts + concatenates text parts from content-part array content', () => {
    expect(
      extractLastUserText([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what folder' },
            { type: 'image', image: 'x' },
          ],
        },
      ]),
    ).toBe('what folder [Image]');
  });

  it('returns the LAST user turn, not an earlier one', () => {
    expect(
      extractLastUserText([
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
      ]),
    ).toBe('second');
  });

  it('returns empty string when there is no user turn', () => {
    expect(extractLastUserText([{ role: 'assistant', content: 'hi' }])).toBe('');
    expect(extractLastUserText([])).toBe('');
  });
});

describe('native browser tool caller authorization', () => {
  const browserManager = (beginAssistantRun = vi.fn()) => ({
    getHostRendererAuthorityGeneration: vi.fn(() => 7),
    isHostRendererAuthorityCurrent: vi.fn((generation: number) => generation === 7),
    hasPendingAssistantContinuation: vi.fn(() => false),
    hasPendingAssistantContinuationForConversation: vi.fn(() => false),
    prepareAssistantContinuation: vi.fn(() => false),
    beginAssistantContinuation: vi.fn(async () => undefined),
    cancelAssistantContinuations: vi.fn(async () => undefined),
    waitForAssistantTabCleanup: vi.fn(async () => undefined),
    beginAssistantRun,
    cleanupAssistantTabs: vi.fn(async () => undefined),
  });

  it('accepts only the primary live Electron renderer', () => {
    const primarySender = { send: vi.fn(), mainFrame: {} };
    const secondarySender = { send: vi.fn() };
    const getPrimaryWindow = () =>
      ({
        isDestroyed: () => false,
        webContents: primarySender,
      }) as never;

    expect(
      __internal.isPrimaryBrowserToolCaller(
        { sender: primarySender, senderFrame: primarySender.mainFrame },
        getPrimaryWindow,
      ),
    ).toBe(true);
    expect(__internal.isPrimaryBrowserToolCaller({ sender: primarySender, senderFrame: {} }, getPrimaryWindow)).toBe(
      false,
    );
    expect(__internal.isPrimaryBrowserToolCaller({ sender: secondarySender }, getPrimaryWindow)).toBe(false);
    expect(
      __internal.isPrimaryBrowserToolCaller(
        { sender: primarySender, senderFrame: primarySender.mainFrame, __kaiWebBridge: true },
        getPrimaryWindow,
      ),
    ).toBe(false);
    expect(
      __internal.isPrimaryBrowserToolCaller(
        { sender: primarySender },
        () => ({ isDestroyed: () => true, webContents: primarySender }) as never,
      ),
    ).toBe(false);
  });

  it('allows only the primary renderer to mutate a Browser-authorized live stream', () => {
    const primarySender = { send: vi.fn(), mainFrame: {} };
    const getPrimaryWindow = () => ({ isDestroyed: () => false, webContents: primarySender }) as never;
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    const webEvent = { sender: null, __kaiWebBridge: true };

    expect(
      __internal.mayMutateBrowserAuthorizedStream(
        primaryEvent,
        { nativeBrowserInitiator: true, nativeBrowserTools: true },
        getPrimaryWindow,
      ),
    ).toBe(true);
    expect(
      __internal.mayMutateBrowserAuthorizedStream(
        webEvent,
        { nativeBrowserInitiator: true, nativeBrowserTools: true },
        getPrimaryWindow,
      ),
    ).toBe(false);
    expect(
      __internal.mayMutateBrowserAuthorizedStream(
        webEvent,
        { nativeBrowserInitiator: true, nativeBrowserTools: false },
        getPrimaryWindow,
      ),
    ).toBe(false);
    expect(
      __internal.mayMutateBrowserAuthorizedStream(
        webEvent,
        { nativeBrowserInitiator: false, nativeBrowserTools: false },
        getPrimaryWindow,
      ),
    ).toBe(true);
  });

  it('reserves retained Browser continuations from renderer persistence', () => {
    const manager = browserManager();
    manager.hasPendingAssistantContinuationForConversation.mockReturnValue(true);
    getExistingBrowserManager.mockReturnValue(manager);
    const primarySender = { send: vi.fn(), mainFrame: {} };
    const getPrimaryWindow = () => ({ isDestroyed: () => false, webContents: primarySender }) as never;
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    const webEvent = { sender: null, __kaiWebBridge: true };

    expect(mayPersistConversationForBrowserAuthority(webEvent, 'conversation-1', getPrimaryWindow)).toBe(false);
    expect(mayPersistConversationForBrowserAuthority(primaryEvent, 'conversation-1', getPrimaryWindow)).toBe(true);

    manager.isHostRendererAuthorityCurrent.mockReturnValue(false);
    expect(mayPersistConversationForBrowserAuthority(primaryEvent, 'conversation-1', getPrimaryWindow)).toBe(false);
  });

  it('rejects background automation injection into Browser-authorized live streams', () => {
    expect(
      __internal.mayInjectAutomationIntoActiveStream({
        nativeBrowserInitiator: true,
        nativeBrowserTools: true,
      }),
    ).toBe(false);
    expect(
      __internal.mayInjectAutomationIntoActiveStream({
        nativeBrowserInitiator: true,
        nativeBrowserTools: false,
      }),
    ).toBe(false);
    expect(
      __internal.mayInjectAutomationIntoActiveStream({
        nativeBrowserInitiator: false,
        nativeBrowserTools: true,
      }),
    ).toBe(false);
    expect(
      __internal.mayInjectAutomationIntoActiveStream({
        nativeBrowserInitiator: false,
        nativeBrowserTools: false,
      }),
    ).toBe(true);
    expect(__internal.mayInjectAutomationIntoActiveStream(undefined)).toBe(true);
  });

  it('requires the exact dedicated-window main frame and rejects stale owned approvals', () => {
    const primarySender = { id: 1, send: vi.fn(), mainFrame: {} };
    const getPrimaryWindow = () => ({ isDestroyed: () => false, webContents: primarySender }) as never;
    const popOutFrame = {};
    const popOutEvent = { sender: { id: 44, mainFrame: popOutFrame }, senderFrame: popOutFrame };
    const subframeEvent = { sender: { id: 44, mainFrame: popOutFrame }, senderFrame: {} };
    const nativePending = { authority: 'native-browser' as const, approvalWindowWebContentsId: 44 };

    expect(__internal.mayResolveToolApproval(popOutEvent, nativePending, getPrimaryWindow)).toBe(true);
    expect(__internal.mayResolveToolApproval(subframeEvent, nativePending, getPrimaryWindow)).toBe(false);
    expect(
      __internal.toolApprovalResolutionError(
        popOutEvent,
        {
          authority: 'any-renderer',
          streamOwner: { conversationId: 'gone', streamToken: 'old-run' },
          approvalWindowWebContentsId: 44,
        },
        getPrimaryWindow,
      ),
    ).toBe('stale-browser-stream');

    expect(
      __internal.isPendingApprovalStreamCurrent(
        {
          streamOwner: { conversationId: 'chat-1', streamToken: 'run-1' },
        },
        new Map([
          [
            'chat-1',
            {
              abort: vi.fn(),
              token: 'run-1',
              nativeBrowserInitiator: true,
              nativeBrowserTools: false,
            },
          ],
        ]),
      ),
    ).toBe(true);

    const realtimeCurrent = vi.fn(() => true);
    const realtimeOwner = {
      streamOwner: {
        conversationId: 'chat-realtime',
        streamToken: 'realtime-run',
        isCurrent: realtimeCurrent,
      },
    };
    expect(__internal.isPendingApprovalStreamCurrent(realtimeOwner, new Map())).toBe(true);
    realtimeCurrent.mockReturnValue(false);
    expect(__internal.isPendingApprovalStreamCurrent(realtimeOwner, new Map())).toBe(false);
    realtimeCurrent.mockImplementation(() => {
      throw new Error('owner lookup failed');
    });
    expect(__internal.isPendingApprovalStreamCurrent(realtimeOwner, new Map())).toBe(false);
  });

  it('withholds native browser tools from an inference-provider plugin without explicit session permission', () => {
    const builtin = {
      name: 'builtin',
      description: 'builtin',
      inputSchema: z.any(),
      execute: vi.fn(async () => null),
    } satisfies ToolDefinition;
    const browser = { ...builtin, name: 'browser_tabs', source: 'browser' as const };
    const provider = { name: 'Plugin AI', isAvailable: () => true, stream: vi.fn() } as never;
    const pluginManager = {
      inferenceProviderHasPermission: vi.fn(() => false),
    };

    const filtered = __internal.toolsForPluginInferenceProvider(
      [builtin, browser],
      'auto',
      true,
      pluginManager as never,
      provider,
    );

    expect(filtered.map((tool) => tool.name)).toEqual(['builtin']);
    expect(pluginManager.inferenceProviderHasPermission).toHaveBeenCalledWith(
      provider,
      'browser:authenticated-session',
    );
  });

  it('exposes browser tools only when both the primary caller and owning plugin are authorized', () => {
    const browser = {
      name: 'browser_tabs',
      description: 'browser',
      inputSchema: z.any(),
      source: 'browser' as const,
      execute: vi.fn(async () => null),
    } satisfies ToolDefinition;
    const provider = { name: 'Plugin AI', isAvailable: () => true, stream: vi.fn() } as never;
    const pluginManager = {
      inferenceProviderHasPermission: vi.fn(() => true),
    } as never;

    expect(__internal.toolsForPluginInferenceProvider([browser], 'auto', true, pluginManager, provider)).toEqual([
      browser,
    ]);
    expect(__internal.toolsForPluginInferenceProvider([browser], 'auto', false, pluginManager, provider)).toEqual([]);
  });

  it('does not register Browser ownership when the effective text tool set has no Browser tool', async () => {
    const manager = browserManager();
    getExistingBrowserManager.mockReturnValue(manager);
    const primarySender = { mainFrame: {}, send: vi.fn() };
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    const safeTool = {
      name: 'safe_tool',
      description: 'safe',
      inputSchema: z.any(),
      source: 'builtin' as const,
      execute: vi.fn(async () => ({ ok: true })),
    } satisfies ToolDefinition;
    registerTools([safeTool]);
    try {
      const harness = await createIpcHarness({
        registerHandlers: (ipc) => {
          registerAgentHandlers(
            ipc as Parameters<typeof registerAgentHandlers>[0],
            '/tmp/app-home',
            undefined,
            () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
          );
        },
      });

      await expect(
        harness.invoke('agent:stream', primaryEvent, 'conv-no-browser-tools', [
          { id: 'user-1', role: 'user', content: 'hello' },
        ]),
      ).resolves.toEqual({ conversationId: 'conv-no-browser-tools' });
      expect(manager.cancelAssistantContinuations).toHaveBeenCalledWith('conv-no-browser-tools');
      expect(manager.beginAssistantRun).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(hasActiveStreams()).toBe(false));

      registerTools([
        safeTool,
        {
          ...safeTool,
          name: 'browser_tabs',
          source: 'browser',
        },
      ]);
      await expect(
        harness.invoke(
          'agent:stream',
          primaryEvent,
          'conv-plan-mode',
          [{ id: 'user-2', role: 'user', content: 'plan this' }],
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          'plan-first',
        ),
      ).resolves.toEqual({ conversationId: 'conv-plan-mode' });
      expect(manager.beginAssistantRun).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(hasActiveStreams()).toBe(false));
    } finally {
      registerTools([]);
    }
  });

  it('rolls back the published text stream when Browser admission rejects', async () => {
    const admissionError = new Error("Another assistant modality is already using this conversation's Browser tabs.");
    const manager = browserManager(
      vi.fn(() => {
        throw admissionError;
      }),
    );
    getExistingBrowserManager.mockReturnValue(manager);
    const primarySender = { mainFrame: {}, send: vi.fn() };
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    const nativeBrowserTool = {
      name: 'browser_tabs',
      description: 'browser',
      inputSchema: z.any(),
      source: 'browser' as const,
      execute: vi.fn(async () => ({ ok: true })),
    } satisfies ToolDefinition;
    registerTools([nativeBrowserTool]);
    try {
      const harness = await createIpcHarness({
        registerHandlers: (ipc) => {
          registerAgentHandlers(
            ipc as Parameters<typeof registerAgentHandlers>[0],
            '/tmp/app-home',
            undefined,
            () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
          );
        },
      });

      await expect(
        harness.invoke('agent:stream', primaryEvent, 'conv-browser-conflict', [
          { id: 'user-1', role: 'user', content: 'hello' },
        ]),
      ).rejects.toThrow(/another assistant modality/i);
      expect(manager.beginAssistantRun).toHaveBeenCalledOnce();
      expect(manager.cleanupAssistantTabs).toHaveBeenCalledWith('conv-browser-conflict', expect.any(String));
      expect(hasActiveStreams()).toBe(false);
      await expect(harness.invoke('agent:in-flight', primaryEvent, 'conv-browser-conflict')).resolves.toEqual({
        inFlight: false,
        serverPersisted: false,
      });
    } finally {
      registerTools([]);
    }
  });

  it('does not strand Browser ownership when stream diagnostics receive non-JSON content', async () => {
    const manager = browserManager();
    getExistingBrowserManager.mockReturnValue(manager);
    const primarySender = { mainFrame: {}, send: vi.fn() };
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    registerTools([
      {
        name: 'browser_tabs',
        description: 'browser',
        inputSchema: z.any(),
        source: 'browser',
        execute: vi.fn(async () => ({ ok: true })),
      },
    ]);
    try {
      const harness = await createIpcHarness({
        registerHandlers: (ipc) => {
          registerAgentHandlers(
            ipc as Parameters<typeof registerAgentHandlers>[0],
            '/tmp/app-home',
            undefined,
            () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
          );
        },
      });

      await expect(
        harness.invoke('agent:stream', primaryEvent, 'conv-non-json-diagnostics', [
          { role: 'user', content: [{ type: 'text', text: 'hello', diagnosticValue: 1n }] },
        ]),
      ).resolves.toEqual({ conversationId: 'conv-non-json-diagnostics' });
      expect(manager.beginAssistantRun).toHaveBeenCalledOnce();
      await vi.waitFor(() => {
        expect(manager.cleanupAssistantTabs).toHaveBeenCalledWith('conv-non-json-diagnostics', expect.any(String));
        expect(hasActiveStreams()).toBe(false);
      });
    } finally {
      registerTools([]);
    }
  });

  it('waits for a terminating Realtime Browser owner before admitting a text turn', async () => {
    let releaseCleanup!: () => void;
    const cleanup = new Promise<undefined>((resolve) => {
      releaseCleanup = () => resolve(undefined);
    });
    const manager = browserManager();
    manager.waitForAssistantTabCleanup.mockImplementation(() => cleanup);
    getExistingBrowserManager.mockReturnValue(manager);
    const primarySender = { mainFrame: {}, send: vi.fn() };
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    registerTools([
      {
        name: 'browser_tabs',
        description: 'browser',
        inputSchema: z.object({}),
        source: 'browser',
        execute: vi.fn(async () => ({ ok: true })),
      },
    ]);
    try {
      const harness = await createIpcHarness({
        registerHandlers: (ipc) => {
          registerAgentHandlers(
            ipc as Parameters<typeof registerAgentHandlers>[0],
            '/tmp/app-home',
            undefined,
            () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
          );
        },
      });

      const launch = harness.invoke('agent:stream', primaryEvent, 'conv-realtime-cleanup', [
        { id: 'user-1', role: 'user', content: 'continue in text' },
      ]);
      await vi.waitFor(() => expect(manager.waitForAssistantTabCleanup).toHaveBeenCalledWith('conv-realtime-cleanup'));
      expect(manager.beginAssistantRun).not.toHaveBeenCalled();

      releaseCleanup();
      await expect(launch).resolves.toEqual({ conversationId: 'conv-realtime-cleanup' });
      expect(manager.beginAssistantRun).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(hasActiveStreams()).toBe(false));
    } finally {
      releaseCleanup();
      registerTools([]);
    }
  });

  it('validates plugin-provider tool inputs before execution and preserves parsed Browser arguments', async () => {
    const browserExecute = vi.fn(async () => ({ ok: true }));
    const builtinExecute = vi.fn(async () => ({ ok: true }));
    const tools: ToolDefinition[] = [
      {
        name: 'browser_evaluate',
        description: 'browser',
        inputSchema: z.object({
          script: z.string().max(8),
          tabId: z.string().default('active-tab'),
        }),
        source: 'browser',
        execute: browserExecute,
      },
      {
        name: 'builtin',
        description: 'builtin',
        inputSchema: z.object({ count: z.number().int().max(2) }),
        execute: builtinExecute,
      },
    ];
    const hostAbort = new AbortController();
    let current = true;
    const [browser, builtin] = __internal.bindBrowserToolsToRun(
      tools,
      'conversation-1',
      'browser-owner-1',
      hostAbort.signal,
      {
        cwd: '/trusted/project',
        isHeadless: false,
        parentProfileKey: 'trusted-profile',
        parentModelKey: 'trusted-model',
      },
      () => current,
    );
    const pluginContext = {
      toolCallId: 'colliding-approval-id',
      conversationId: 'spoofed-conversation',
      browserOwnerId: 'spoofed-owner',
      cwd: '/private/spoofed',
      abortSignal: new AbortController().signal,
      onProgress: vi.fn(),
      isHeadless: true,
      parentProfileKey: 'spoofed-profile',
      parentModelKey: 'spoofed-model',
    };

    await expect(browser.execute({ script: 'x'.repeat(9) }, pluginContext)).rejects.toThrow(
      'Invalid arguments for tool "browser_evaluate".',
    );
    await expect(builtin.execute({ count: 3 }, pluginContext)).rejects.toThrow('Invalid arguments for tool "builtin".');
    expect(browserExecute).not.toHaveBeenCalled();
    expect(builtinExecute).not.toHaveBeenCalled();

    await expect(browser.execute({ script: 'ok' }, pluginContext)).resolves.toEqual({ ok: true });
    expect(browserExecute).toHaveBeenCalledWith(
      { script: 'ok', tabId: 'active-tab' },
      {
        toolCallId: expect.stringMatching(/^plugin-browser-/),
        conversationId: 'conversation-1',
        browserOwnerId: 'browser-owner-1',
        abortSignal: hostAbort.signal,
        cwd: '/trusted/project',
        isHeadless: false,
        parentProfileKey: 'trusted-profile',
        parentModelKey: 'trusted-model',
      },
    );

    await expect(builtin.execute({ count: 2 }, pluginContext)).resolves.toEqual({ ok: true });
    expect(builtinExecute).toHaveBeenCalledWith(
      { count: 2 },
      {
        toolCallId: expect.stringMatching(/^plugin-tool-/),
        conversationId: 'conversation-1',
        browserOwnerId: 'browser-owner-1',
        abortSignal: hostAbort.signal,
        cwd: '/trusted/project',
        isHeadless: false,
        parentProfileKey: 'trusted-profile',
        parentModelKey: 'trusted-model',
      },
    );

    current = false;
    await expect(builtin.execute({ count: 1 }, pluginContext)).rejects.toThrow(
      'This plugin tool capability is no longer active.',
    );
    current = true;
    hostAbort.abort();
    await expect(browser.execute({ script: 'ok' }, pluginContext)).rejects.toThrow(
      'This plugin tool capability is no longer active.',
    );
    expect(builtinExecute).toHaveBeenCalledTimes(1);
    expect(browserExecute).toHaveBeenCalledTimes(1);
  });

  it('revokes retained Browser closures when authenticated-session permission is removed', async () => {
    const browserExecute = vi.fn(async () => ({ browser: true }));
    const builtinExecute = vi.fn(async () => ({ builtin: true }));
    let browserAuthorized = true;
    const [browser, builtin] = __internal.bindBrowserToolsToRun(
      [
        {
          name: 'browser_tabs',
          description: 'browser',
          source: 'browser',
          inputSchema: z.object({}),
          execute: browserExecute,
        },
        {
          name: 'safe_tool',
          description: 'safe',
          inputSchema: z.object({}),
          execute: builtinExecute,
        },
      ],
      'conversation-permission-revoked',
      'browser-owner-permission-revoked',
      new AbortController().signal,
      { cwd: '/trusted', isHeadless: false, parentProfileKey: null, parentModelKey: null },
      (tool) => tool.source !== 'browser' || browserAuthorized,
    );

    browserAuthorized = false;
    await expect(browser.execute({}, {} as ToolExecutionContext)).rejects.toThrow(/no longer active/);
    await expect(builtin.execute({}, {} as ToolExecutionContext)).resolves.toEqual({ builtin: true });
    expect(browserExecute).not.toHaveBeenCalled();
    expect(builtinExecute).toHaveBeenCalledOnce();
  });

  it('redacts credential-bearing Browser URLs from observer execution failures', () => {
    const result = __internal.observerToolErrorForExposure(
      'browser_action',
      new Error('ERR_FAILED https://alice:secret@example.com/path?token=observer-secret'),
    );

    expect(result).toEqual({
      isError: true,
      error: 'ERR_FAILED [redacted browser URL: https://example.com]',
    });
    expect(JSON.stringify(result)).not.toMatch(/alice|observer-secret/);
  });

  it('enforces PreToolUse and PostToolUse for plugin-provider Browser tools', async () => {
    const execute = vi.fn(async () => ({ raw: true }));
    const unregisterPre = hookDispatcher.register(
      'PreToolUse',
      () => ({ payload: { args: { script: 'safe', tabId: 'modified-tab' } } }),
      { mode: 'modify', matcher: 'browser_evaluate' },
    );
    const unregisterPost = hookDispatcher.register(
      'PostToolUse',
      () => ({ payload: { result: { sanitized: true } } }),
      { mode: 'modify', matcher: 'browser_evaluate' },
    );
    try {
      const [bound] = __internal.bindBrowserToolsToRun(
        [
          {
            name: 'browser_evaluate',
            description: 'browser',
            source: 'browser',
            inputSchema: z.object({ script: z.string(), tabId: z.string() }),
            execute,
          },
        ],
        'conversation-hooks',
        'browser-owner-hooks',
        new AbortController().signal,
        { cwd: '/trusted', isHeadless: false, parentProfileKey: null, parentModelKey: null },
        () => true,
      );

      await expect(
        bound.execute({ script: 'raw-secret-script', tabId: 'original-tab' }, {
          toolCallId: 'spoofed',
        } as ToolExecutionContext),
      ).resolves.toEqual({ sanitized: true });
      expect(execute).toHaveBeenCalledWith(
        { script: 'safe', tabId: 'modified-tab' },
        expect.objectContaining({
          toolCallId: expect.stringMatching(/^plugin-browser-tool-/),
          conversationId: 'conversation-hooks',
          browserOwnerId: 'browser-owner-hooks',
        }),
      );
    } finally {
      unregisterPost();
      unregisterPre();
    }
  });

  it('rechecks plugin tool authority after an asynchronous PreToolUse hook', async () => {
    let releaseHook!: () => void;
    let hookStarted!: () => void;
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const started = new Promise<void>((resolve) => {
      hookStarted = resolve;
    });
    const execute = vi.fn(async () => ({ ok: true }));
    let current = true;
    const unregister = hookDispatcher.register(
      'PreToolUse',
      async () => {
        hookStarted();
        await hookGate;
      },
      { mode: 'observe', matcher: 'browser_action' },
    );
    try {
      const [bound] = __internal.bindBrowserToolsToRun(
        [
          {
            name: 'browser_action',
            description: 'browser',
            source: 'browser',
            inputSchema: z.object({}),
            execute,
          },
        ],
        'conversation-pre-revoked',
        'browser-owner-pre-revoked',
        new AbortController().signal,
        { cwd: '/trusted', isHeadless: false, parentProfileKey: null, parentModelKey: null },
        () => current,
      );

      const result = bound.execute({}, {} as ToolExecutionContext);
      await started;
      current = false;
      releaseHook();

      await expect(result).rejects.toThrow('This plugin tool capability is no longer active.');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      releaseHook();
      unregister();
    }
  });

  it('does not deliver a plugin tool result after authority is revoked in PostToolUse', async () => {
    let releaseHook!: () => void;
    let hookStarted!: () => void;
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const started = new Promise<void>((resolve) => {
      hookStarted = resolve;
    });
    const execute = vi.fn(async () => ({ raw: true }));
    let current = true;
    const unregister = hookDispatcher.register(
      'PostToolUse',
      async () => {
        hookStarted();
        await hookGate;
      },
      { mode: 'observe', matcher: 'browser_action' },
    );
    try {
      const [bound] = __internal.bindBrowserToolsToRun(
        [
          {
            name: 'browser_action',
            description: 'browser',
            source: 'browser',
            inputSchema: z.object({}),
            execute,
          },
        ],
        'conversation-post-revoked',
        'browser-owner-post-revoked',
        new AbortController().signal,
        { cwd: '/trusted', isHeadless: false, parentProfileKey: null, parentModelKey: null },
        () => current,
      );

      const result = bound.execute({}, {} as ToolExecutionContext);
      await started;
      current = false;
      releaseHook();

      await expect(result).rejects.toThrow('This plugin tool capability is no longer active.');
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      releaseHook();
      unregister();
    }
  });

  it('throws only the redacted Browser error when plugin PostToolUse leaves it unchanged', async () => {
    const secretUrl = 'https://alice:password@example.com/account?token=plugin-secret';
    const [bound] = __internal.bindBrowserToolsToRun(
      [
        {
          name: 'browser_action',
          description: 'browser',
          source: 'browser',
          inputSchema: z.object({ kind: z.string() }),
          execute: vi.fn(async () => {
            throw new Error(`ERR_FAILED while loading ${secretUrl}`);
          }),
        },
      ],
      'conversation-redacted-error',
      'browser-owner-redacted-error',
      new AbortController().signal,
      { cwd: '/trusted', isHeadless: false, parentProfileKey: null, parentModelKey: null },
      () => true,
    );

    const failure = bound.execute({ kind: 'reload' }, {} as ToolExecutionContext);
    await expect(failure).rejects.toThrow('ERR_FAILED while loading [redacted browser URL: https://example.com]');
    await expect(failure).rejects.not.toThrow(/plugin-secret|alice:password/);
  });

  it('does not expose denied plugin Browser arguments to PostToolUse', async () => {
    const secret = 'browser-denied-secret';
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
      const [bound] = __internal.bindBrowserToolsToRun(
        [
          {
            name: 'browser_evaluate',
            description: 'browser',
            source: 'browser',
            inputSchema: z.object({ script: z.string() }),
            execute,
          },
        ],
        'conversation-denied',
        'browser-owner-denied',
        new AbortController().signal,
        { cwd: '/trusted', isHeadless: false, parentProfileKey: null, parentModelKey: null },
        () => true,
      );

      await expect(
        bound.execute({ script: secret }, { toolCallId: 'spoofed' } as ToolExecutionContext),
      ).resolves.toEqual({ isError: true, error: 'sanitized denial' });
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify(postPayload)).not.toContain(secret);
      expect(postPayload).toMatchObject({ args: { redacted: true, reason: 'blocked by policy' } });
    } finally {
      unregisterPost();
      unregisterPre();
    }
  });

  it('reserves Browser authority while an authorized launch waits for its admission drain', async () => {
    let releaseDrain!: () => void;
    const drain = new Promise<undefined>((resolve) => {
      releaseDrain = () => resolve(undefined);
    });
    const manager = browserManager();
    manager.cancelAssistantContinuations.mockImplementation(() => drain);
    getExistingBrowserManager.mockReturnValue(manager);
    const primarySender = { mainFrame: {}, send: vi.fn() };
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    const remoteEvent = { sender: null, __kaiWebBridge: true };
    registerTools([
      {
        name: 'browser_tabs',
        description: 'browser',
        inputSchema: z.object({}),
        source: 'browser',
        execute: vi.fn(async () => ({ ok: true })),
      },
    ]);

    try {
      const harness = await createIpcHarness({
        registerHandlers: (ipc) => {
          registerAgentHandlers(
            ipc as Parameters<typeof registerAgentHandlers>[0],
            '/tmp/app-home',
            undefined,
            () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
          );
        },
      });

      const launch = harness.invoke('agent:stream', primaryEvent, 'conv-deferred-browser-admission', [
        { id: 'user-1', role: 'user', content: 'hello' },
      ]);
      await vi.waitFor(() => expect(manager.cancelAssistantContinuations).toHaveBeenCalledOnce());

      await expect(
        harness.invoke('agent:stream', remoteEvent, 'conv-deferred-browser-admission', [
          { id: 'user-2', role: 'user', content: 'replace it' },
        ]),
      ).resolves.toMatchObject({
        busy: true,
        nativeBrowserAuthorityRequired: true,
      });

      releaseDrain();
      await expect(launch).resolves.toEqual({ conversationId: 'conv-deferred-browser-admission' });
      await vi.waitFor(() => expect(hasActiveStreams()).toBe(false));
    } finally {
      releaseDrain();
      registerTools([]);
    }
  });

  it('does not let a web mirror finalize a desktop Browser turn fallback', async () => {
    let releaseDrain!: () => void;
    const drain = new Promise<undefined>((resolve) => {
      releaseDrain = () => resolve(undefined);
    });
    const manager = browserManager();
    manager.cancelAssistantContinuations.mockImplementation(() => drain);
    getExistingBrowserManager.mockReturnValue(manager);
    const primarySender = { mainFrame: {}, send: vi.fn() };
    const primaryEvent = { sender: primarySender, senderFrame: primarySender.mainFrame };
    const remoteEvent = { sender: null, __kaiWebBridge: true };
    registerTools([
      {
        name: 'browser_tabs',
        description: 'browser',
        inputSchema: z.object({}),
        source: 'browser',
        execute: vi.fn(async () => ({ ok: true })),
      },
    ]);

    try {
      const harness = await createIpcHarness({
        registerHandlers: (ipc) => {
          registerAgentHandlers(
            ipc as Parameters<typeof registerAgentHandlers>[0],
            '/tmp/app-home',
            undefined,
            () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
          );
        },
      });

      const launch = harness.invoke('agent:stream', primaryEvent, 'conv-browser-fallback-authority', [
        { id: 'user-1', role: 'user', content: 'hello' },
      ]);
      await vi.waitFor(() => expect(manager.cancelAssistantContinuations).toHaveBeenCalledOnce());

      await expect(
        harness.invoke('agent:finalize-gui-fallback', remoteEvent, 'conv-browser-fallback-authority'),
      ).resolves.toEqual({ confirmed: false, headId: null });

      releaseDrain();
      await expect(launch).resolves.toEqual({ conversationId: 'conv-browser-fallback-authority' });
      await vi.waitFor(() => expect(hasActiveStreams()).toBe(false));
    } finally {
      releaseDrain();
      registerTools([]);
    }
  });

  it('rejects a headless submit before persistence when retained Browser tabs own the conversation', async () => {
    const manager = browserManager();
    manager.hasPendingAssistantContinuationForConversation.mockReturnValue(true);
    getExistingBrowserManager.mockReturnValue(manager);
    const read = vi.mocked(readConversation);
    read.mockReturnValue({
      id: 'conv-retained-browser-submit',
      runStatus: 'idle',
      messageTree: [{ id: 'assistant-1', parentId: null, role: 'assistant', content: 'partial' }],
      headId: 'assistant-1',
    } as never);
    registerTools([]);

    try {
      const harness = await createIpcHarness({
        registerHandlers: (ipc) => {
          registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
        },
      });

      await expect(
        harness.invoke(
          'agent:submit',
          { sender: null, __kaiWebBridge: true },
          'conv-retained-browser-submit',
          'take over',
        ),
      ).resolves.toEqual({ ok: false, error: 'native-browser-authority-required' });
      expect(appendConversationMessages).not.toHaveBeenCalled();
    } finally {
      read.mockReturnValue(null);
      registerTools([]);
    }
  });

  it('does not start a text stream while a Realtime turn owns the conversation', async () => {
    isRealtimeConversationTurnActive.mockReturnValue(true);
    registerTools([]);
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
      },
    });

    await expect(
      harness.invoke('agent:stream', FAKE_EVENT, 'conv-realtime-owned', [
        { id: 'user-1', role: 'user', content: 'start text too' },
      ]),
    ).resolves.toMatchObject({
      conversationId: 'conv-realtime-owned',
      busy: true,
      delivered: false,
      realtimeTurnActive: true,
    });
    expect(hasActiveStreams()).toBe(false);
  });

  it('rejects a headless submit before persistence while Realtime owns the conversation', async () => {
    isRealtimeConversationTurnActive.mockReturnValue(true);
    const read = vi.mocked(readConversation);
    read.mockReturnValue({ id: 'conv-realtime-submit', runStatus: 'idle', messageTree: [], headId: null } as never);
    registerTools([]);

    try {
      const harness = await createIpcHarness({
        registerHandlers: (ipc) => {
          registerAgentHandlers(ipc as Parameters<typeof registerAgentHandlers>[0], '/tmp/app-home');
        },
      });
      await expect(
        harness.invoke('agent:submit', FAKE_EVENT, 'conv-realtime-submit', 'start text too'),
      ).resolves.toEqual({ ok: false, error: 'conversation-busy' });
      expect(appendConversationMessages).not.toHaveBeenCalled();
    } finally {
      read.mockReturnValue(null);
      registerTools([]);
    }
  });

  it('does not let a secondary renderer cancel a retained Browser continuation with a fresh turn', async () => {
    const manager = browserManager();
    manager.hasPendingAssistantContinuationForConversation.mockReturnValue(true);
    getExistingBrowserManager.mockReturnValue(manager);
    const primarySender = { mainFrame: {}, send: vi.fn() };
    const secondarySender = { mainFrame: {}, send: vi.fn() };
    const harness = await createIpcHarness({
      registerHandlers: (ipc) => {
        registerAgentHandlers(
          ipc as Parameters<typeof registerAgentHandlers>[0],
          '/tmp/app-home',
          undefined,
          () => ({ isDestroyed: () => false, webContents: primarySender }) as never,
        );
      },
    });

    await expect(
      harness.invoke(
        'agent:stream',
        { sender: secondarySender, senderFrame: secondarySender.mainFrame },
        'conv-retained-browser-continuation',
        [{ id: 'user-1', role: 'user', content: 'replace it' }],
      ),
    ).resolves.toMatchObject({
      busy: true,
      nativeBrowserContinuationRequired: true,
    });
    expect(manager.cancelAssistantContinuations).not.toHaveBeenCalled();
  });

  it('rejects invalid post-hook arguments and returns schema-transformed observer input', () => {
    const tool = {
      name: 'browser_action',
      description: 'browser',
      inputSchema: z.object({ text: z.string().max(5) }).transform(({ text }) => ({ text: text.trim() })),
      source: 'browser' as const,
      execute: vi.fn(async () => null),
    } satisfies ToolDefinition;

    expect(() => __internal.validateToolInput(tool, { text: 'too-long' })).toThrow(
      'Invalid arguments for tool "browser_action".',
    );
    expect(__internal.validateToolInput(tool, { text: ' ok ' })).toEqual({ text: 'ok' });
  });

  it('retains temporary browser tabs only for a GUI max-turn continuation that can use native tools', () => {
    const shouldPrepare = __internal.shouldPrepareBrowserContinuation;
    const maxTurns = { type: 'error' as const, errorCategory: 'max_turns' };

    expect(shouldPrepare(maxTurns, false, true, true)).toBe(true);
    expect(shouldPrepare(maxTurns, true, true, true)).toBe(false);
    expect(shouldPrepare(maxTurns, false, false, true)).toBe(false);
    expect(shouldPrepare(maxTurns, false, true, false)).toBe(false);
    expect(shouldPrepare({ type: 'error', errorCategory: 'provider' }, false, true, true)).toBe(false);
  });

  it('treats an aborted or replaced owner as superseded after an async browser drain', () => {
    expect(__internal.isBrowserDrainSuperseded(false, 'run-1', 'run-1')).toBe(false);
    expect(__internal.isBrowserDrainSuperseded(true, 'run-1', 'run-1')).toBe(true);
    expect(__internal.isBrowserDrainSuperseded(false, 'run-2', 'run-1')).toBe(true);
    expect(__internal.isBrowserDrainSuperseded(false, undefined, 'run-1')).toBe(true);
  });

  it('invalidates delayed browser authority when its manager or renderer generation changes', () => {
    const manager = {
      isHostRendererAuthorityCurrent: vi.fn((generation: number) => generation === 8),
    };
    const replacement = {
      isHostRendererAuthorityCurrent: vi.fn((generation: number) => generation === 8),
    };

    expect(__internal.isNativeBrowserAuthorityCurrent(manager as never, 8)).toBe(true);
    expect(__internal.isNativeBrowserAuthorityCurrent(manager as never, 7)).toBe(false);
    expect(__internal.isNativeBrowserAuthorityCurrent(manager as never, undefined)).toBe(false);
    expect(__internal.isNativeBrowserAuthorityRevoked(true, manager as never, manager as never, 8)).toBe(false);
    expect(__internal.isNativeBrowserAuthorityRevoked(true, manager as never, manager as never, 7)).toBe(true);
    expect(__internal.isNativeBrowserAuthorityRevoked(true, manager as never, replacement as never, 8)).toBe(true);
    expect(__internal.isNativeBrowserAuthorityRevoked(false, manager as never, replacement as never, 7)).toBe(false);
  });

  it('resets a preflight turn left running when Browser renderer authority is revoked', () => {
    const read = vi.mocked(readConversation);
    const write = vi.mocked(writeConversation);
    const upsert = vi.mocked(broadcastUpsert);
    const conversation = { id: 'conversation-1', runStatus: 'running' as const };
    read.mockReturnValue(conversation as never);
    write.mockImplementation((_appHome, next) => next as never);

    expect(__internal.resetBrowserAuthorityRevokedRunStatus('/tmp/app-home', conversation.id)).toBe(true);
    expect(write).toHaveBeenCalledWith(
      '/tmp/app-home',
      expect.objectContaining({ id: conversation.id, runStatus: 'idle' }),
    );
    expect(upsert).toHaveBeenCalledWith(
      '/tmp/app-home',
      expect.objectContaining({ id: conversation.id, runStatus: 'idle' }),
    );
  });

  it('reserves a pending native Browser continuation for an authorized desktop renderer', () => {
    const manager = {
      hasPendingAssistantContinuation: vi.fn((_conversationId: string, runId: string) => runId === 'browser-run'),
    };

    expect(__internal.mayDriveBrowserContinuation(manager as never, 'conversation-1', 'plain-run', false)).toBe(true);
    expect(__internal.mayDriveBrowserContinuation(manager as never, 'conversation-1', 'browser-run', false)).toBe(
      false,
    );
    expect(__internal.mayDriveBrowserContinuation(manager as never, 'conversation-1', 'browser-run', true)).toBe(true);
    expect(__internal.mayDriveBrowserContinuation(null, 'conversation-1', 'browser-run', false)).toBe(true);
  });

  it('redacts plugin-provider errors whenever the provider can use authenticated Browser tools', () => {
    const error = new Error('ERR_FAILED https://alice:password@example.com/account?token=provider-secret');

    expect(__internal.pluginProviderErrorForExposure(error, true)).toBe(
      'ERR_FAILED [redacted browser URL: https://example.com]',
    );
    expect(__internal.pluginProviderErrorForExposure(error, false)).toContain('provider-secret');
  });
});

describe('observer workspace tool registry', () => {
  const tool = (name: string): ToolDefinition => ({
    name,
    description: name,
    inputSchema: z.any(),
    execute: vi.fn(async () => ({ ok: true })),
  });

  it('includes workspace tools that are intentionally outside the main registry', () => {
    const active = __internal.observerToolsForExecutionMode(
      [tool('web_search')],
      [tool('mastra_workspace_execute_command'), tool('mastra_workspace_list_files')],
      'auto',
    );

    expect(active.map((entry) => entry.name)).toEqual([
      'web_search',
      'mastra_workspace_execute_command',
      'mastra_workspace_list_files',
    ]);
  });

  it('keeps read-only workspace tools but removes shell execution in plan mode', () => {
    const active = __internal.observerToolsForExecutionMode(
      [tool('web_search'), tool('github')],
      [tool('mastra_workspace_execute_command'), tool('mastra_workspace_list_files')],
      'plan-first',
    );

    expect(active.map((entry) => entry.name)).toEqual(['web_search', 'mastra_workspace_list_files']);
  });
});

describe('cancel-generation ABA-safety (evicted-after-Stop must count as changed — R132)', () => {
  const { bumpExplicitCancelGeneration, captureCancelGeneration, cancelGenerationChanged } = __internal;

  it('a Stop after capture is detected as changed', () => {
    const captured = captureCancelGeneration('aba-conv-1'); // never Stopped → undefined
    expect(captured).toBeUndefined();
    bumpExplicitCancelGeneration('aba-conv-1'); // Stop
    expect(cancelGenerationChanged('aba-conv-1', captured)).toBe(true);
  });

  it('no Stop since capture is NOT changed', () => {
    bumpExplicitCancelGeneration('aba-conv-2');
    const captured = captureCancelGeneration('aba-conv-2'); // a positive sequence
    expect(captured).toBeGreaterThan(0);
    expect(cancelGenerationChanged('aba-conv-2', captured)).toBe(false);
  });

  it('an evicted-after-Stop entry re-reads as undefined and counts as CHANGED (no ABA to 0)', () => {
    bumpExplicitCancelGeneration('aba-conv-3'); // Stop → positive sequence
    const captured = captureCancelGeneration('aba-conv-3');
    expect(captured).toBeGreaterThan(0);
    // Simulate eviction under memory pressure: flood distinct ids past the 500 cap so the
    // oldest (aba-conv-3) is evicted. Its re-read is now undefined — which must NOT collide
    // with the captured positive sequence (the pre-R132 `?? 0` bug matched 0).
    for (let i = 0; i < 600; i++) bumpExplicitCancelGeneration(`flood-${i}`);
    expect(captureCancelGeneration('aba-conv-3')).toBeUndefined();
    expect(cancelGenerationChanged('aba-conv-3', captured)).toBe(true);
  });
});

describe('cancel-gen PUSH token (eviction-proof for run-starting deferred ops — R135)', () => {
  const { bumpExplicitCancelGeneration, registerCancelGenToken, releaseCancelGenToken } = __internal;

  it('a Stop flips a registered token even when the capture was undefined (never Stopped) AND the map entry is evicted', () => {
    // The R134 f-2 hole: capture undefined → Stop → evict → numeric re-read is undefined again.
    // The PUSH token catches it because the Stop flipped it directly.
    const token = registerCancelGenToken('push-conv-1'); // never Stopped at registration
    expect(token.cancelled).toBe(false);
    bumpExplicitCancelGeneration('push-conv-1'); // Stop → flips the token
    expect(token.cancelled).toBe(true);
    // Even after eviction of push-conv-1's map entry, the token stays cancelled.
    for (let i = 0; i < 600; i++) bumpExplicitCancelGeneration(`push-flood-${i}`);
    expect(token.cancelled).toBe(true);
    releaseCancelGenToken(token);
  });

  it('a token for a DIFFERENT conversation is not flipped by an unrelated Stop', () => {
    const token = registerCancelGenToken('push-conv-2');
    bumpExplicitCancelGeneration('push-conv-other');
    expect(token.cancelled).toBe(false);
    releaseCancelGenToken(token);
  });

  it('release removes the token so a later Stop no longer flips it', () => {
    const token = registerCancelGenToken('push-conv-3');
    releaseCancelGenToken(token);
    bumpExplicitCancelGeneration('push-conv-3');
    // The token object is detached from the registry; a Stop can't reach it.
    expect(token.cancelled).toBe(false);
  });
});

describe('planEnterResultFailed (skip plan-restart on a non-entry result — R146)', () => {
  const { planEnterResultFailed } = __internal;

  it('does NOT flag a successful entry (restart proceeds)', () => {
    expect(planEnterResultFailed({ success: true, mode: 'plan-first' })).toBe(false);
    expect(planEnterResultFailed('entered plan mode')).toBe(false);
    expect(planEnterResultFailed(null)).toBe(false);
  });

  it('flags a Mastra object success:false', () => {
    expect(planEnterResultFailed({ success: false, error: 'no persist' })).toBe(true);
  });

  it('flags a Pi stringified success:false', () => {
    expect(planEnterResultFailed('{"success":false,"error":"x"}')).toBe(true);
  });

  it('flags an SDK error wrap {isError:true, error:"{...success:false...}"} (R146 f-1)', () => {
    expect(planEnterResultFailed({ isError: true, error: '{"success":false,"error":"stopped"}' })).toBe(true);
    // Even a bare isError:true (no nested success) → did NOT enter → no restart.
    expect(planEnterResultFailed({ isError: true, error: 'boom' })).toBe(true);
  });
});

describe('isConversationDeletedSafe (throw-safe tombstone lookup — R147)', () => {
  const { isConversationDeletedSafe } = __internal;

  it('returns the tombstone result when the lookup succeeds', async () => {
    const store = await import('../conversation-store.js');
    (store.isWriteTombstoned as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    expect(isConversationDeletedSafe('/tmp/app', 'c1')).toBe(true);
    (store.isWriteTombstoned as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    expect(isConversationDeletedSafe('/tmp/app', 'c1')).toBe(false);
  });

  it('returns FALSE (not-deleted) when the lookup THROWS — never abandons a possibly-live chat', async () => {
    const store = await import('../conversation-store.js');
    (store.isWriteTombstoned as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('EMFILE');
    });
    expect(isConversationDeletedSafe('/tmp/app', 'c1')).toBe(false);
  });
});

describe('reconcileExecutionMode (GUI submit vs MAIN-authoritative disk mode — R128/R129)', () => {
  const { reconcileExecutionMode } = __internal;

  it('trusts disk plan-first over a stale auto submit (never expose mutating tools)', () => {
    expect(reconcileExecutionMode('auto', 'plan-first', true)).toBe('plan-first');
    expect(reconcileExecutionMode(undefined, 'plan-first', true)).toBe('plan-first');
  });

  it('trusts disk auto over a stale plan-first submit (no latched plan-first — R129 f-3)', () => {
    // A stale plan-first renderer state must NOT pin the conversation plan-first forever
    // after a genuine plan→auto toggle already wrote disk 'auto'.
    expect(reconcileExecutionMode('plan-first', 'auto', true)).toBe('auto');
    expect(reconcileExecutionMode('plan-first', undefined, true)).toBe('auto');
  });

  it('falls back to the submit ONLY when there is no persisted record (recordless first turn)', () => {
    expect(reconcileExecutionMode('plan-first', undefined, false)).toBe('plan-first');
    expect(reconcileExecutionMode('auto', undefined, false)).toBe('auto');
    expect(reconcileExecutionMode(undefined, undefined, false)).toBe('auto');
  });
});

describe("isSupersededRunEvent (mid-turn inject: drop the aborted run's stale events)", () => {
  it('suppresses a token-stamped event whose token no longer matches the active run', () => {
    // The prior run (token A) was superseded by a new run (token B); A's trailing
    // deltas / stale `done` must be dropped so they can\'t concat or reset the UI.
    expect(isSupersededRunEvent('A', 'B')).toBe(true);
  });

  it("allows the current run's own events (token matches active)", () => {
    expect(isSupersededRunEvent('B', 'B')).toBe(false);
  });

  it('never suppresses an untagged event (automation/external/approval broadcast)', () => {
    expect(isSupersededRunEvent(undefined, 'B')).toBe(false);
  });

  it('does not treat events as stale when no run is active', () => {
    expect(isSupersededRunEvent('A', undefined)).toBe(false);
    expect(isSupersededRunEvent(undefined, undefined)).toBe(false);
  });
});

describe('resolveInjectedTextFromGatedPayload (mid-turn inject enforcement)', () => {
  const { resolveInjectedTextFromGatedPayload } = __internal;

  it('returns the surviving user turn text (string content)', () => {
    const res = resolveInjectedTextFromGatedPayload([{ role: 'user', content: 'redacted answer' }]);
    expect(res).toEqual({ allowed: true, text: 'redacted answer' });
  });

  it('extracts text from a single content-part user message (redacting hook rewrote parts)', () => {
    const res = resolveInjectedTextFromGatedPayload([
      { role: 'user', content: [{ type: 'text', text: '[redacted]' }] },
    ]);
    expect(res).toEqual({ allowed: true, text: '[redacted]' });
  });

  it('denies when a hook REMOVED the user turn (payload is not a single user message)', () => {
    const res = resolveInjectedTextFromGatedPayload([{ role: 'assistant', content: 'only assistant left' }]);
    expect(res).toEqual({ allowed: false, text: '' });
  });

  it('denies when a hook ADDED extra messages (can’t splice added context as one inject)', () => {
    // A modify hook returned a system safety message + the rewritten user turn.
    // We can’t represent that as a single user-text inject → fail closed.
    const res = resolveInjectedTextFromGatedPayload([
      { role: 'system', content: 'SAFETY: redacted per policy' },
      { role: 'user', content: [{ type: 'text', text: 'answer' }] },
    ]);
    expect(res).toEqual({ allowed: false, text: '' });
  });

  it('denies when a hook redacts the message to EMPTY text (string or parts)', () => {
    expect(resolveInjectedTextFromGatedPayload([{ role: 'user', content: '' }])).toEqual({ allowed: false, text: '' });
    expect(resolveInjectedTextFromGatedPayload([{ role: 'user', content: '   ' }])).toEqual({
      allowed: false,
      text: '',
    });
    expect(resolveInjectedTextFromGatedPayload([{ role: 'user', content: [{ type: 'text', text: '' }] }])).toEqual({
      allowed: false,
      text: '',
    });
  });

  it('denies on an empty payload', () => {
    expect(resolveInjectedTextFromGatedPayload([])).toEqual({ allowed: false, text: '' });
  });

  it('preserves multiline / spacing-sensitive text VERBATIM (no whitespace collapse)', () => {
    const code = 'def f():\n    x = 1\n\n    return  x   # two spaces';
    const res = resolveInjectedTextFromGatedPayload([{ role: 'user', content: [{ type: 'text', text: code }] }]);
    expect(res).toEqual({ allowed: true, text: code });
  });

  it('concatenates multiple text parts verbatim', () => {
    const res = resolveInjectedTextFromGatedPayload([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'line1\n' },
          { type: 'text', text: 'line2' },
        ],
      },
    ]);
    expect(res).toEqual({ allowed: true, text: 'line1\nline2' });
  });

  it('denies when the surviving turn has a non-text part (hook rewrote to media/file)', () => {
    const res = resolveInjectedTextFromGatedPayload([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', image: 'data:...' },
        ],
      },
    ]);
    expect(res).toEqual({ allowed: false, text: '' });
  });

  describe('with history context (historyLen > 0)', () => {
    it('extracts ONLY the injected turn (last message) after N history messages', () => {
      // The gate ran hooks over [history…, injectedUser]; extract the last turn.
      const res = resolveInjectedTextFromGatedPayload(
        [
          { role: 'user', content: 'first prompt' },
          { role: 'assistant', content: 'a reply' },
          { role: 'user', content: [{ type: 'text', text: 'the injected answer' }] },
        ],
        2,
      );
      expect(res).toEqual({ allowed: true, text: 'the injected answer' });
    });

    it('denies when a hook ADDED a message AFTER the injected turn (payload too long)', () => {
      const res = resolveInjectedTextFromGatedPayload(
        [
          { role: 'user', content: 'first prompt' },
          { role: 'user', content: [{ type: 'text', text: 'answer' }] },
          { role: 'system', content: 'SAFETY appended' },
        ],
        1,
      );
      expect(res).toEqual({ allowed: false, text: '' });
    });

    it('denies when a hook REMOVED the injected turn (payload too short)', () => {
      const res = resolveInjectedTextFromGatedPayload([{ role: 'user', content: 'first prompt' }], 1);
      expect(res).toEqual({ allowed: false, text: '' });
    });

    it('denies when the message at the injected index is not a user turn', () => {
      const res = resolveInjectedTextFromGatedPayload(
        [
          { role: 'user', content: 'first prompt' },
          { role: 'assistant', content: 'hook replaced the inject with an assistant turn' },
        ],
        1,
      );
      expect(res).toEqual({ allowed: false, text: '' });
    });
  });
});

describe('isSupersessionDescendant (raced-answer handoff lineage guard — R81/R115)', () => {
  const { recordSupersession, isSupersessionDescendant } = __internal;

  it('follows a recorded supersession chain (A→B→C) but rejects unrelated tokens', () => {
    recordSupersession('A', 'B');
    recordSupersession('B', 'C');
    // C genuinely superseded A through the chain.
    expect(isSupersessionDescendant('A', 'C')).toBe(true);
    expect(isSupersessionDescendant('A', 'B')).toBe(true);
    // D never entered A's chain — an unrelated later turn must NOT inherit A's answer.
    expect(isSupersessionDescendant('A', 'D')).toBe(false);
    // Reverse direction is not a descendant.
    expect(isSupersessionDescendant('C', 'A')).toBe(false);
  });

  it('returns false when there is no recorded edge (a successor that died before admission)', () => {
    // 'X' was issued as latest but its supersession edge was never recorded (config
    // threw before stream admission), so a predecessor teardown must NOT treat it as a
    // live replacement — the R115 guard falls through to durable recovery.
    expect(isSupersessionDescendant('pred-no-edge', 'X')).toBe(false);
  });

  it('does not infinite-loop on a supersession cycle (corrupt lineage)', () => {
    recordSupersession('cyc1', 'cyc2');
    recordSupersession('cyc2', 'cyc1');
    // Cycle-guarded: terminates and does not match an unrelated token.
    expect(isSupersessionDescendant('cyc1', 'nope')).toBe(false);
    // Still finds a real descendant within the cycle.
    expect(isSupersessionDescendant('cyc1', 'cyc2')).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/schema.js';
import type { BrowserTabsReadApproval } from '../../browser/manager.js';

const manager = {
  assertAssistantRun: vi.fn(),
  previewAssistantTabId: vi.fn(
    (_conversationId: string, requestedTabId?: string) => requestedTabId ?? '00000000-0000-0000-0000-000000000001',
  ),
  resolveAssistantTabId: vi.fn(
    (_conversationId: string, requestedTabId?: string) => requestedTabId ?? '00000000-0000-0000-0000-000000000001',
  ),
  getState: vi.fn(),
  createTab: vi.fn(),
  duplicateAssistantTab: vi.fn(),
  commandTab: vi.fn(),
  reopenClosedTab: vi.fn(),
  captureTabsReadApproval: vi.fn<(conversationId: string) => BrowserTabsReadApproval>(() => ({
    conversationId: 'chat-1',
    activeTabId: null,
    tabOrder: [],
    tabRefs: [],
    tabGenerations: [],
    documentEpochs: [],
    tabUrls: [],
    userNavigationLeases: [],
  })),
  assertTabsReadApproval: vi.fn(),
  captureTabsApproval: vi.fn<(conversationId: string, action: string, tabId?: string) => Record<string, unknown>>(
    (conversationId: string, action: string, tabId?: string) => ({
      action,
      conversationId,
      tabId,
      tabGeneration: 3,
      origin: 'https://example.com',
    }),
  ),
  captureDocumentApproval: vi.fn(() => ({
    tabId: '00000000-0000-0000-0000-000000000001',
    tabGeneration: 7,
    origin: 'https://example.com',
  })),
  captureAutofillApproval: vi.fn(async () => ({
    tabId: '00000000-0000-0000-0000-000000000001',
    tabGeneration: 7,
    origin: 'https://example.com',
    credentialId: '00000000-0000-0000-0000-000000000002',
    credentialUpdatedAt: '2026-08-16T00:00:00.000Z',
    destinationOrigin: 'https://login.example',
  })),
  inspect: vi.fn(),
  networkDiagnostics: vi.fn(),
  action: vi.fn(),
  screenshot: vi.fn(),
  evaluate: vi.fn(),
  autofill: vi.fn(),
};
const broadcastStreamEventRaw = vi.hoisted(() => vi.fn());
const registerPendingApproval = vi.hoisted(() => vi.fn(async () => true));

vi.mock('../../browser/service.js', () => ({ getBrowserManager: () => manager }));
vi.mock('../../ipc/tool-approval.js', () => ({
  broadcastStreamEventRaw,
  registerPendingApproval,
}));

import { browserApprovalArgs, createBrowserTools } from '../browser.js';

function config(overrides: Partial<AppConfig['browser']> = {}): AppConfig {
  return {
    browser: {
      enabled: true,
      dataScope: 'global',
      readAccess: 'allow',
      structuredActions: 'allow',
      scriptInjection: 'allow',
      passwordAccess: 'user-only',
      offerToSavePasswords: true,
      searchProvider: 'duckduckgo',
      aiAllowPrivateNetwork: false,
      idleDiscardMinutes: 10,
      maxTabsPerConversation: 20,
      showBookmarksBar: false,
      ...overrides,
    },
  } as AppConfig;
}

const context = {
  toolCallId: 'tool-1',
  conversationId: 'chat-1',
  browserOwnerId: 'run-1',
  abortSignal: new AbortController().signal,
};

const assistantRun = { id: context.browserOwnerId, abortSignal: context.abortSignal };

function mockScreenshotResult(result: Record<string, unknown>): void {
  manager.screenshot.mockImplementation(async (...args: unknown[]) => {
    const run = args[3] as { abortSignal?: AbortSignal } | undefined;
    const postprocess = args[4] as
      | ((screenshot: Record<string, unknown>, abortSignal?: AbortSignal) => Promise<unknown>)
      | undefined;
    return postprocess ? postprocess(result, run?.abortSignal) : result;
  });
}

describe('browser tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    manager.previewAssistantTabId.mockImplementation(
      (_conversationId: string, requestedTabId?: string) => requestedTabId ?? '00000000-0000-0000-0000-000000000001',
    );
    manager.resolveAssistantTabId.mockImplementation(
      (_conversationId: string, requestedTabId?: string) => requestedTabId ?? '00000000-0000-0000-0000-000000000001',
    );
  });

  it('lists only the active conversation state and marks assistant-created tabs', async () => {
    manager.getState.mockReturnValue({ conversationId: 'chat-1', tabs: [], activeTabId: null });
    manager.createTab.mockResolvedValue({ id: 'tab-1' });
    const tools = createBrowserTools(() => config());
    const tabs = tools.find((tool) => tool.name === 'browser_tabs')!;
    await expect(tabs.execute({ action: 'list' }, context)).resolves.toMatchObject({ conversationId: 'chat-1' });
    await tabs.execute({ action: 'open', url: 'https://example.com' }, context);
    expect(manager.createTab).toHaveBeenCalledWith(
      {
        conversationId: 'chat-1',
        url: 'https://example.com',
        background: undefined,
        owner: 'assistant',
      },
      assistantRun,
    );
  });

  it('marks AI-duplicated and reopened tabs for turn-end cleanup', async () => {
    manager.getState.mockReturnValue({
      conversationId: 'chat-1',
      tabs: [{ id: '00000000-0000-0000-0000-000000000001', url: 'https://example.com' }],
      activeTabId: '00000000-0000-0000-0000-000000000001',
    });
    manager.duplicateAssistantTab.mockResolvedValue({ id: 'new-tab' });
    manager.reopenClosedTab.mockResolvedValue({ id: 'reopened-tab' });
    const tabs = createBrowserTools(() => config()).find((tool) => tool.name === 'browser_tabs')!;

    await tabs.execute({ action: 'duplicate', tabId: '00000000-0000-0000-0000-000000000001' }, context);
    expect(manager.duplicateAssistantTab).toHaveBeenCalledWith(
      'chat-1',
      '00000000-0000-0000-0000-000000000001',
      assistantRun,
      undefined,
    );

    await tabs.execute({ action: 'reopen_closed' }, context);
    expect(manager.reopenClosedTab).toHaveBeenCalledWith('chat-1', 'assistant', assistantRun, undefined);
  });

  it('redacts sensitive tab metadata from reads and returns receipts for mutations', async () => {
    const sensitiveTab = {
      id: '00000000-0000-0000-0000-000000000001',
      sensitive: true,
      title: 'Private account title',
      url: 'https://secret.example/account?token=secret',
      favicon: 'data:image/png;base64,SECRET',
      error: 'Failed to load https://secret.example/account?token=secret',
    };
    manager.getState.mockReturnValue({
      conversationId: 'chat-1',
      tabs: [sensitiveTab],
      activeTabId: sensitiveTab.id,
      credentialPrompts: [
        {
          id: 'credential-prompt',
          tabId: sensitiveTab.id,
          origin: 'https://secret.example',
          username: 'private-user@example.com',
          update: false,
        },
      ],
      permissionPrompts: [
        {
          id: 'permission-prompt',
          tabId: sensitiveTab.id,
          origin: 'https://secret.example',
          permission: 'camera',
        },
      ],
      authPrompts: [
        {
          id: 'auth-prompt',
          tabId: sensitiveTab.id,
          host: 'secret.example',
          endpoint: 'https://secret.example:443',
          authScheme: 'basic',
          realm: 'Private realm',
          isProxy: false,
          assistantTriggered: false,
        },
      ],
    });
    manager.createTab.mockResolvedValue(sensitiveTab);
    manager.action.mockResolvedValue({ ok: true, tab: sensitiveTab });
    const tools = createBrowserTools(() => config());
    const tabs = tools.find((tool) => tool.name === 'browser_tabs')!;
    const action = tools.find((tool) => tool.name === 'browser_action')!;

    const listed = (await tabs.execute({ action: 'list' }, context)) as { tabs: Array<Record<string, unknown>> };
    await expect(tabs.execute({ action: 'open', url: 'https://example.com' }, context)).resolves.toEqual({
      ok: true,
      action: 'open',
      tabId: sensitiveTab.id,
    });
    await expect(action.execute({ kind: 'wait', waitMs: 0 }, context)).resolves.toEqual({
      ok: true,
      action: 'wait',
      tabId: sensitiveTab.id,
    });

    expect(listed.tabs[0]).toMatchObject({
      sensitive: true,
      title: 'Sensitive page',
      url: 'about:blank',
      favicon: undefined,
      error: undefined,
    });
    expect(JSON.stringify({ listed })).not.toContain('secret.example');
    expect(JSON.stringify({ listed })).not.toContain('Private account title');
    expect(JSON.stringify({ listed })).not.toContain('private-user@example.com');
    expect(listed).not.toHaveProperty('credentialPrompts');
    expect(listed).not.toHaveProperty('permissionPrompts');
    expect(listed).not.toHaveProperty('authPrompts');
  });

  it('omits unbounded favicons and native errors from assistant-facing tab reads', async () => {
    const visibleTab = {
      id: '00000000-0000-0000-0000-000000000001',
      sensitive: false,
      title: 'Example',
      url: 'https://example.com',
      favicon: `data:image/png;base64,${'A'.repeat(100_000)}`,
      error: 'Browsing history could not be saved: EACCES /Users/private/.kai/browser/history.json',
      documentToken: 'renderer-capability-must-not-reach-model',
    };
    manager.getState.mockReturnValue({ conversationId: 'chat-1', tabs: [visibleTab], activeTabId: visibleTab.id });
    manager.createTab.mockResolvedValue(visibleTab);
    manager.action.mockResolvedValue({ ok: true, tab: visibleTab });
    const tools = createBrowserTools(() => config());
    const tabs = tools.find((tool) => tool.name === 'browser_tabs')!;
    const action = tools.find((tool) => tool.name === 'browser_action')!;

    await expect(tabs.execute({ action: 'list' }, context)).resolves.toMatchObject({
      tabs: [{ favicon: undefined, error: undefined }],
    });
    const listed = await tabs.execute({ action: 'list' }, context);
    expect(listed).not.toHaveProperty('tabs.0.documentToken');
    await expect(tabs.execute({ action: 'open', url: visibleTab.url }, context)).resolves.toEqual({
      ok: true,
      action: 'open',
      tabId: visibleTab.id,
    });
    await expect(action.execute({ kind: 'wait', waitMs: 0 }, context)).resolves.toEqual({
      ok: true,
      action: 'wait',
      tabId: visibleTab.id,
    });
  });

  it('does not expose page-controlled titles from authenticated tabs', async () => {
    manager.getState.mockReturnValue({
      conversationId: 'chat-1',
      tabs: [
        {
          id: 'tab-account',
          sensitive: false,
          title: 'Alice — Q4 acquisition plan',
          url: 'https://docs.example/private/plan',
        },
        {
          id: 'tab-new',
          sensitive: false,
          title: 'Secret draft title',
          url: 'about:blank',
        },
      ],
      activeTabId: 'tab-account',
    });
    const tabs = createBrowserTools(() => config()).find((tool) => tool.name === 'browser_tabs')!;

    const listed = (await tabs.execute({ action: 'list' }, context)) as { tabs: Array<Record<string, unknown>> };

    expect(listed.tabs).toMatchObject([
      { id: 'tab-account', title: 'https://docs.example', url: 'https://docs.example' },
      { id: 'tab-new', title: 'New tab', url: 'about:blank' },
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/Alice|acquisition|Secret draft/);
  });

  it('does not expose local, inline, or secret-bearing URLs through tab listing', async () => {
    const tabsState = [
      {
        id: 'tab-data',
        sensitive: false,
        title: 'data:text/html,INLINE_SECRET',
        url: 'data:text/html,INLINE_SECRET',
        error: 'Failed data:text/html,INLINE_SECRET',
      },
      {
        id: 'tab-file',
        sensitive: false,
        title: '/Users/private/secret.html',
        url: 'file:///Users/private/secret.html',
      },
      {
        id: 'tab-http',
        sensitive: false,
        title: 'https://alice:URL_PASSWORD@example.com/private/TOKEN?key=QUERY_SECRET#FRAGMENT_SECRET',
        url: 'https://alice:URL_PASSWORD@example.com/private/TOKEN?key=QUERY_SECRET#FRAGMENT_SECRET',
        error: 'Failed URL_PASSWORD QUERY_SECRET',
      },
    ];
    manager.getState.mockReturnValue({ conversationId: 'chat-1', tabs: tabsState, activeTabId: 'tab-http' });
    const tabs = createBrowserTools(() => config()).find((tool) => tool.name === 'browser_tabs')!;

    const listed = (await tabs.execute({ action: 'list' }, context)) as { tabs: Array<Record<string, unknown>> };

    expect(listed.tabs).toMatchObject([
      { id: 'tab-data', title: 'Private page', url: 'about:blank', error: undefined },
      { id: 'tab-file', title: 'Private page', url: 'about:blank', error: undefined },
      { id: 'tab-http', title: 'https://example.com', url: 'https://example.com', error: undefined },
    ]);
    expect(JSON.stringify(listed)).not.toMatch(
      /INLINE_SECRET|private\/secret|URL_PASSWORD|TOKEN|QUERY_SECRET|FRAGMENT_SECRET/,
    );
  });

  it('redacts credentials and secret-bearing URL components from browser inspection', async () => {
    const secretUrl = 'https://alice:URL_PASSWORD@example.com/oauth/callback?code=QUERY_SECRET#FRAGMENT_SECRET';
    manager.inspect.mockResolvedValue({
      tabId: 'tab-http',
      title: secretUrl,
      url: secretUrl,
      visibleText: 'Signed in',
      scrollX: 0,
      scrollY: 0,
      viewportWidth: 800,
      viewportHeight: 600,
      elements: [],
    });
    const inspect = createBrowserTools(() => config()).find((tool) => tool.name === 'browser_inspect')!;

    const result = await inspect.execute({ tabId: 'tab-http' }, context);

    expect(result).toMatchObject({ title: 'https://example.com', url: 'https://example.com' });
    expect(JSON.stringify(result)).not.toMatch(/URL_PASSWORD|oauth\/callback|QUERY_SECRET|FRAGMENT_SECRET/);
  });

  it('blocks assistant duplication of a sensitive tab', async () => {
    const id = '00000000-0000-0000-0000-000000000001';
    manager.duplicateAssistantTab.mockRejectedValueOnce(
      new Error('Duplicating a tab is blocked while it contains password data.'),
    );
    const tabs = createBrowserTools(() => config()).find((tool) => tool.name === 'browser_tabs')!;

    await expect(tabs.execute({ action: 'duplicate', tabId: id }, context)).rejects.toThrow(/password data/);
    expect(manager.duplicateAssistantTab).toHaveBeenCalledWith('chat-1', id, assistantRun, undefined);
  });

  it('does not expose presentation activation to the assistant', () => {
    const tabs = createBrowserTools(() => config()).find((tool) => tool.name === 'browser_tabs')!;
    const id = '00000000-0000-0000-0000-000000000001';

    expect(tabs.inputSchema.safeParse({ action: 'activate', tabId: id }).success).toBe(false);
  });

  it('uses the assistant run target when a tab command omits tabId', async () => {
    const id = '00000000-0000-0000-0000-000000000001';
    const tabs = createBrowserTools(() => config()).find((tool) => tool.name === 'browser_tabs')!;

    await tabs.execute({ action: 'close' }, context);

    expect(manager.commandTab).toHaveBeenCalledWith('chat-1', id, 'close', 'assistant', assistantRun, undefined);
    expect(manager.resolveAssistantTabId).toHaveBeenCalledWith('chat-1', undefined, assistantRun);
  });

  it('reports a clear error when a tab command omits tabId without an assistant target', async () => {
    manager.resolveAssistantTabId.mockImplementationOnce(() => {
      throw new Error('Browser tab not found in this chat.');
    });
    const tabs = createBrowserTools(() => config()).find((tool) => tool.name === 'browser_tabs')!;

    await expect(tabs.execute({ action: 'close' }, context)).rejects.toThrow(/not found in this chat/);
    expect(manager.commandTab).not.toHaveBeenCalled();
  });

  it('does not commit an explicitly previewed tab when ask-policy approval is denied', async () => {
    const id = '00000000-0000-0000-0000-000000000002';
    registerPendingApproval.mockResolvedValueOnce(false);
    const tabs = createBrowserTools(() => config({ structuredActions: 'ask' })).find(
      (tool) => tool.name === 'browser_tabs',
    )!;

    await expect(tabs.execute({ action: 'close', tabId: id }, context)).rejects.toThrow(/approval was denied/i);

    expect(manager.previewAssistantTabId).toHaveBeenCalledWith('chat-1', id, assistantRun);
    expect(manager.resolveAssistantTabId).not.toHaveBeenCalled();
    expect(manager.commandTab).not.toHaveBeenCalled();
  });

  it('enforces the independent script policy', async () => {
    const evaluate = createBrowserTools(() => config({ scriptInjection: 'deny' })).find(
      (tool) => tool.name === 'browser_evaluate',
    )!;
    await expect(evaluate.execute({ script: 'document.title' }, context)).rejects.toThrow(/disabled/);
    expect(manager.evaluate).not.toHaveBeenCalled();
  });

  it('enforces the structured-action policy independently', async () => {
    const action = createBrowserTools(() => config({ structuredActions: 'deny' })).find(
      (tool) => tool.name === 'browser_action',
    )!;
    await expect(action.execute({ kind: 'click', x: 1, y: 1 }, context)).rejects.toThrow(/disabled/);
    expect(manager.action).not.toHaveBeenCalled();
  });

  it('enforces the independent read policy for tab listing, inspection, network diagnostics, and screenshots', async () => {
    manager.getState.mockReturnValue({ conversationId: 'chat-1', tabs: [], activeTabId: null });
    const tools = createBrowserTools(() => config({ readAccess: 'deny' }));

    await expect(
      tools.find((tool) => tool.name === 'browser_tabs')!.execute({ action: 'list' }, context),
    ).rejects.toThrow(/disabled/);
    await expect(tools.find((tool) => tool.name === 'browser_inspect')!.execute({}, context)).rejects.toThrow(
      /disabled/,
    );
    await expect(tools.find((tool) => tool.name === 'browser_network')!.execute({}, context)).rejects.toThrow(
      /disabled/,
    );
    await expect(
      tools.find((tool) => tool.name === 'browser_screenshot')!.execute({ mode: 'viewport' }, context),
    ).rejects.toThrow(/disabled/);

    expect(manager.getState).not.toHaveBeenCalled();
    expect(manager.inspect).not.toHaveBeenCalled();
    expect(manager.networkDiagnostics).not.toHaveBeenCalled();
    expect(manager.screenshot).not.toHaveBeenCalled();
  });

  it('does not return the tab inventory after a mutation when read access is denied', async () => {
    const id = '00000000-0000-0000-0000-000000000001';
    manager.getState.mockReturnValue({
      conversationId: 'chat-1',
      activeTabId: id,
      tabs: [
        { id, title: 'Private account', url: 'https://secret.example/private?token=SECRET' },
        { id: 'tab-2', title: 'Other private account', url: 'https://other.example/private' },
      ],
    });
    const tabs = createBrowserTools(() => config({ readAccess: 'deny', structuredActions: 'allow' })).find(
      (tool) => tool.name === 'browser_tabs',
    )!;

    const result = await tabs.execute({ action: 'keep_open', tabId: id }, context);

    expect(result).toEqual({ ok: true, action: 'keep_open', tabId: id });
    expect(JSON.stringify(result)).not.toMatch(/secret\.example|other\.example|Private account/);
    expect(manager.getState).not.toHaveBeenCalled();
    expect(manager.commandTab).toHaveBeenCalledWith('chat-1', id, 'keep-open', 'assistant', assistantRun, undefined);
  });

  it('returns only mutation receipts when structured actions are allowed but read access is denied', async () => {
    const id = '00000000-0000-0000-0000-000000000001';
    const secretTab = {
      id,
      title: 'Private account',
      url: 'https://secret.example/private?token=SECRET',
      favicon: 'data:image/png;base64,SECRET',
    };
    manager.getState.mockReturnValue({ conversationId: 'chat-1', activeTabId: id, tabs: [secretTab] });
    manager.createTab.mockResolvedValue(secretTab);
    manager.duplicateAssistantTab.mockResolvedValue(secretTab);
    manager.reopenClosedTab.mockResolvedValue(secretTab);
    manager.action.mockResolvedValue({ ok: true, tab: secretTab });
    const tools = createBrowserTools(() => config({ readAccess: 'deny', structuredActions: 'allow' }));
    const tabs = tools.find((tool) => tool.name === 'browser_tabs')!;
    const action = tools.find((tool) => tool.name === 'browser_action')!;

    const results = [
      await tabs.execute({ action: 'open', url: 'https://secret.example/private?token=SECRET' }, context),
      await tabs.execute({ action: 'duplicate', tabId: id }, context),
      await tabs.execute({ action: 'reopen_closed' }, context),
      await action.execute({ kind: 'wait', tabId: id, waitMs: 0 }, context),
    ];

    expect(results).toEqual([
      { ok: true, action: 'open', tabId: id },
      { ok: true, action: 'duplicate', tabId: id },
      { ok: true, action: 'reopen_closed', tabId: id },
      { ok: true, action: 'wait', tabId: id },
    ]);
    expect(JSON.stringify(results)).not.toMatch(/secret\.example|Private account|SECRET|favicon/);
  });

  it('rechecks browser enablement after an approval wait', async () => {
    let currentConfig = config({ structuredActions: 'ask' });
    registerPendingApproval.mockImplementationOnce(async () => {
      currentConfig = config({ enabled: false, structuredActions: 'ask' });
      return true;
    });
    const action = createBrowserTools(() => currentConfig).find((tool) => tool.name === 'browser_action')!;

    await expect(action.execute({ kind: 'click', x: 1, y: 1 }, context)).rejects.toThrow(/disabled in Settings/);
    expect(manager.action).not.toHaveBeenCalled();
  });

  it('rechecks every Browser control policy after an approval wait', async () => {
    const cases = [
      {
        toolName: 'browser_tabs',
        initial: { readAccess: 'ask' as const },
        denied: { readAccess: 'deny' as const },
        input: { action: 'list' },
        called: manager.getState,
      },
      {
        toolName: 'browser_inspect',
        initial: { readAccess: 'ask' as const },
        denied: { readAccess: 'deny' as const },
        input: {},
        called: manager.inspect,
      },
      {
        toolName: 'browser_network',
        initial: { readAccess: 'ask' as const },
        denied: { readAccess: 'deny' as const },
        input: { waitFor: 'load' },
        called: manager.networkDiagnostics,
      },
      {
        toolName: 'browser_screenshot',
        initial: { readAccess: 'ask' as const },
        denied: { readAccess: 'deny' as const },
        input: { mode: 'viewport' },
        called: manager.screenshot,
      },
      {
        toolName: 'browser_tabs',
        initial: { structuredActions: 'ask' as const },
        denied: { structuredActions: 'deny' as const },
        input: { action: 'open', url: 'https://example.com' },
        called: manager.createTab,
      },
      {
        toolName: 'browser_action',
        initial: { structuredActions: 'ask' as const },
        denied: { structuredActions: 'deny' as const },
        input: { kind: 'click', x: 1, y: 1 },
        called: manager.action,
      },
      {
        toolName: 'browser_evaluate',
        initial: { scriptInjection: 'ask' as const },
        denied: { scriptInjection: 'deny' as const },
        input: { script: 'document.title' },
        called: manager.evaluate,
      },
      {
        toolName: 'browser_autofill',
        initial: { passwordAccess: 'ask' as const },
        denied: { passwordAccess: 'user-only' as const },
        input: {},
        called: manager.autofill,
      },
    ];

    for (const item of cases) {
      vi.clearAllMocks();
      let currentConfig = config(item.initial);
      registerPendingApproval.mockImplementationOnce(async () => {
        currentConfig = config(item.denied);
        return true;
      });
      const tool = createBrowserTools(() => currentConfig).find((candidate) => candidate.name === item.toolName)!;

      await expect(tool.execute(item.input, context)).rejects.toThrow(/disabled|user-only/);
      expect(item.called).not.toHaveBeenCalled();
    }
  });

  it('rejects retained browser tool snapshots after the feature is disabled', async () => {
    let currentConfig = config();
    const tabs = createBrowserTools(() => currentConfig).find((tool) => tool.name === 'browser_tabs')!;
    currentConfig = config({ enabled: false });

    await expect(tabs.execute({ action: 'list' }, context)).rejects.toThrow(/disabled in Settings/);
    expect(manager.getState).not.toHaveBeenCalled();
  });

  it('fails closed when a runtime omits assistant turn ownership', async () => {
    const inspect = createBrowserTools(() => config()).find((tool) => tool.name === 'browser_inspect')!;
    await expect(inspect.execute({}, { ...context, browserOwnerId: undefined })).rejects.toThrow(/turn ownership/);
    expect(manager.inspect).not.toHaveBeenCalled();
  });

  it('rejects stale or unknown run capabilities before exposing tab state', async () => {
    manager.assertAssistantRun.mockImplementationOnce(() => {
      throw new Error('The assistant browser turn has ended or is not registered.');
    });
    const tabs = createBrowserTools(() => config()).find((tool) => tool.name === 'browser_tabs')!;

    await expect(tabs.execute({ action: 'list' }, context)).rejects.toThrow(/ended or is not registered/);
    expect(manager.getState).not.toHaveBeenCalled();
  });

  it('rechecks assistant run ownership after a tab-list approval wait', async () => {
    manager.getState.mockReturnValue({ conversationId: 'chat-1', tabs: [], activeTabId: null });
    manager.assertAssistantRun
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('The assistant browser turn has ended or is not registered.');
      });
    const tabs = createBrowserTools(() => config({ readAccess: 'ask' })).find((tool) => tool.name === 'browser_tabs')!;

    await expect(tabs.execute({ action: 'list' }, context)).rejects.toThrow(/ended or is not registered/);
    expect(registerPendingApproval).toHaveBeenCalledOnce();
    expect(manager.getState).not.toHaveBeenCalled();
  });

  it('redacts typed page content and selectors from persisted ask-policy approvals', async () => {
    manager.action.mockResolvedValue({ ok: true, tab: { sensitive: false } });
    const action = createBrowserTools(() => config({ structuredActions: 'ask' })).find(
      (tool) => tool.name === 'browser_action',
    )!;
    const input = { kind: 'type', selector: '#password', value: 'user-visible-value' };

    await action.execute(input, context);

    expect(broadcastStreamEventRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'tool-1',
        toolName: 'browser_action',
        args: expect.objectContaining({
          kind: 'type',
          selector: '[redacted browser selector: 9 characters]',
          value: '[redacted typed text: 18 characters]',
          target: {
            tabId: '00000000-0000-0000-0000-000000000001',
            origin: '[redacted Browser origin]',
          },
          approvalKind: 'browser-control',
          reason: 'Interact with the current web page',
        }),
      }),
    );
    expect(JSON.stringify(broadcastStreamEventRaw.mock.calls)).not.toContain('user-visible-value');
    expect(JSON.stringify(broadcastStreamEventRaw.mock.calls)).not.toContain('#password');
    expect(registerPendingApproval).toHaveBeenCalledWith('tool-1', context.abortSignal, 'native-browser', {
      conversationId: 'chat-1',
      browserOwnerId: 'run-1',
      privateDetails: {
        browserInput: input,
        browserTarget: expect.objectContaining({ origin: 'https://example.com' }),
      },
    });
    expect(manager.action).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ value: 'user-visible-value' }),
      assistantRun,
      expect.objectContaining({ tabId: '00000000-0000-0000-0000-000000000001' }),
    );
  });

  it('does not broadcast a Browser approval after owner registration fails closed', async () => {
    registerPendingApproval.mockImplementationOnce(() => {
      throw new Error('Browser approval is no longer authorized for this assistant turn.');
    });
    const action = createBrowserTools(() => config({ structuredActions: 'ask' })).find(
      (tool) => tool.name === 'browser_action',
    )!;

    await expect(action.execute({ kind: 'click', x: 1, y: 1 }, context)).rejects.toThrow(/no longer authorized/);
    expect(broadcastStreamEventRaw).not.toHaveBeenCalled();
    expect(manager.action).not.toHaveBeenCalled();
  });

  it('captures and forwards exact ask-policy approval state for tab mutations', async () => {
    const id = '00000000-0000-0000-0000-000000000001';
    const approvals = new Map([
      ['duplicate', { action: 'duplicate', conversationId: 'chat-1', tabId: id, tabGeneration: 4 }],
      ['reopen_closed', { action: 'reopen_closed', conversationId: 'chat-1', closedTabRef: {} }],
      [
        'close_right',
        {
          action: 'close_right',
          conversationId: 'chat-1',
          tabId: id,
          tabGeneration: 4,
          tabOrder: [id, 'tab-2'],
          affectedTabIds: ['tab-2'],
        },
      ],
    ]);
    manager.captureTabsApproval.mockImplementation(
      (_conversationId: string, action: string) => approvals.get(action) ?? { action, conversationId: 'chat-1' },
    );
    manager.getState.mockReturnValue({ conversationId: 'chat-1', tabs: [{ id }], activeTabId: id });
    manager.duplicateAssistantTab.mockResolvedValue({ id: 'duplicate-tab' });
    manager.reopenClosedTab.mockResolvedValue({ id: 'reopened-tab' });
    const tabs = createBrowserTools(() => config({ structuredActions: 'ask' })).find(
      (tool) => tool.name === 'browser_tabs',
    )!;

    await tabs.execute({ action: 'duplicate', tabId: id }, context);
    await tabs.execute({ action: 'reopen_closed' }, context);
    await tabs.execute({ action: 'close_right', tabId: id }, context);

    expect(manager.captureTabsApproval).toHaveBeenNthCalledWith(1, 'chat-1', 'duplicate', id, assistantRun);
    expect(manager.captureTabsApproval).toHaveBeenNthCalledWith(2, 'chat-1', 'reopen_closed', undefined, assistantRun);
    expect(manager.captureTabsApproval).toHaveBeenNthCalledWith(3, 'chat-1', 'close_right', id, assistantRun);
    expect(manager.duplicateAssistantTab).toHaveBeenCalledWith('chat-1', id, assistantRun, approvals.get('duplicate'));
    expect(manager.reopenClosedTab).toHaveBeenCalledWith(
      'chat-1',
      'assistant',
      assistantRun,
      approvals.get('reopen_closed'),
    );
    expect(manager.commandTab).toHaveBeenCalledWith(
      'chat-1',
      id,
      'close-right',
      'assistant',
      assistantRun,
      approvals.get('close_right'),
    );
  });

  it('binds approved actions, scripts, and autofill to the document shown in the prompt', async () => {
    const approval = {
      tabId: '00000000-0000-0000-0000-000000000001',
      tabGeneration: 7,
      origin: 'https://example.com',
    };
    const autofillApproval = {
      ...approval,
      credentialId: '00000000-0000-0000-0000-000000000002',
      credentialUpdatedAt: '2026-08-16T00:00:00.000Z',
      destinationOrigin: 'https://login.example',
    };
    manager.captureDocumentApproval.mockReturnValue(approval);
    manager.captureAutofillApproval.mockResolvedValue(autofillApproval);
    manager.action.mockResolvedValue({ ok: true, tab: { id: approval.tabId, sensitive: false } });
    manager.evaluate.mockResolvedValue('Example');
    manager.getState.mockReturnValue({ conversationId: 'chat-1', tabs: [], activeTabId: approval.tabId });
    manager.autofill.mockResolvedValue(undefined);
    const tools = createBrowserTools(() =>
      config({ structuredActions: 'ask', scriptInjection: 'ask', passwordAccess: 'ask' }),
    );

    await tools.find((tool) => tool.name === 'browser_action')!.execute({ kind: 'wait', waitMs: 0 }, context);
    await tools.find((tool) => tool.name === 'browser_evaluate')!.execute({ script: 'document.title' }, context);
    await tools.find((tool) => tool.name === 'browser_autofill')!.execute({}, context);

    expect(manager.captureDocumentApproval).toHaveBeenNthCalledWith(1, 'chat-1', approval.tabId, assistantRun);
    expect(manager.captureDocumentApproval).toHaveBeenNthCalledWith(2, 'chat-1', approval.tabId, assistantRun);
    expect(manager.captureAutofillApproval).toHaveBeenCalledWith('chat-1', approval.tabId, undefined, assistantRun);
    expect(manager.action).toHaveBeenCalledWith(
      'chat-1',
      { kind: 'wait', waitMs: 0, tabId: approval.tabId },
      assistantRun,
      approval,
    );
    expect(broadcastStreamEventRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'browser_autofill',
        args: expect.objectContaining({
          target: {
            tabId: approval.tabId,
            origin: '[redacted Browser origin]',
            destinationOrigin: '[redacted Browser origin]',
          },
        }),
      }),
    );
    expect(manager.evaluate).toHaveBeenCalledWith('chat-1', 'document.title', approval.tabId, assistantRun, approval);
    expect(manager.autofill).toHaveBeenCalledWith(
      'chat-1',
      approval.tabId,
      undefined,
      'assistant',
      assistantRun,
      autofillApproval,
    );
  });

  it('binds approved Browser reads to the exact tab state and document shown in the prompt', async () => {
    const documentApproval = {
      tabId: '00000000-0000-0000-0000-000000000001',
      tabGeneration: 7,
      origin: 'https://example.com',
    };
    const tabsApproval = {
      conversationId: 'chat-1',
      activeTabId: documentApproval.tabId,
      tabOrder: [documentApproval.tabId],
      tabRefs: [{}],
      tabGenerations: [7],
      documentEpochs: [0],
      tabUrls: ['https://example.com/page'],
      userNavigationLeases: [2],
    };
    manager.captureTabsReadApproval.mockReturnValue(tabsApproval);
    manager.captureDocumentApproval.mockReturnValue(documentApproval);
    manager.getState.mockReturnValue({
      conversationId: 'chat-1',
      tabs: [],
      activeTabId: documentApproval.tabId,
    });
    manager.inspect.mockResolvedValue({ tabId: documentApproval.tabId, url: 'https://example.com', title: 'Example' });
    manager.networkDiagnostics.mockResolvedValue({ tabId: documentApproval.tabId, requests: [] });
    mockScreenshotResult({
      tabId: documentApproval.tabId,
      mode: 'viewport',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,AAAA',
      width: 10,
      height: 10,
    });
    const tools = createBrowserTools(() => config({ readAccess: 'ask' }));

    await tools.find((tool) => tool.name === 'browser_tabs')!.execute({ action: 'list' }, context);
    await tools.find((tool) => tool.name === 'browser_inspect')!.execute({}, context);
    await tools.find((tool) => tool.name === 'browser_network')!.execute({}, context);
    await tools.find((tool) => tool.name === 'browser_screenshot')!.execute({ mode: 'viewport' }, context);

    expect(manager.captureTabsReadApproval).toHaveBeenCalledWith('chat-1');
    expect(manager.assertTabsReadApproval).toHaveBeenCalledWith('chat-1', tabsApproval);
    expect(manager.inspect).toHaveBeenCalledWith('chat-1', documentApproval.tabId, assistantRun, documentApproval);
    expect(manager.networkDiagnostics).toHaveBeenCalledWith(
      'chat-1',
      { tabId: documentApproval.tabId },
      assistantRun,
      documentApproval,
    );
    expect(manager.screenshot).toHaveBeenCalledWith(
      'chat-1',
      { mode: 'viewport', tabId: documentApproval.tabId },
      'assistant',
      assistantRun,
      expect.any(Function),
      documentApproval,
    );
  });

  it('redacts script bodies from approval payloads before bounding or persistence', () => {
    const args = browserApprovalArgs('browser_evaluate', { script: 'x'.repeat(50_000) }, 'Run script');
    expect(args).toMatchObject({
      script: '[redacted browser script: 50000 characters]',
      approvalKind: 'browser-control',
      reason: 'Run script',
    });
  });

  it('keeps ask-policy scripts redacted in events but exact in transient native approval state', async () => {
    const evaluate = createBrowserTools(() => config({ scriptInjection: 'ask' })).find(
      (tool) => tool.name === 'browser_evaluate',
    )!;
    const script = 'x'.repeat(50_000);

    await evaluate.execute({ script }, context);

    expect(broadcastStreamEventRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'browser_evaluate',
        args: expect.objectContaining({ script: '[redacted browser script: 50000 characters]' }),
      }),
    );
    expect(JSON.stringify(broadcastStreamEventRaw.mock.calls)).not.toContain(script);
    expect(registerPendingApproval).toHaveBeenCalledWith('tool-1', context.abortSignal, 'native-browser', {
      conversationId: 'chat-1',
      browserOwnerId: 'run-1',
      privateDetails: {
        browserInput: { script },
        browserTarget: expect.objectContaining({ origin: 'https://example.com' }),
      },
    });
    expect(manager.evaluate).toHaveBeenCalledWith(
      'chat-1',
      script,
      expect.any(String),
      assistantRun,
      expect.any(Object),
    );
  });

  it('keeps host-captured target origins transient while persisting only a redacted marker', () => {
    const args = browserApprovalArgs(
      'browser_action',
      { kind: 'click', target: { tabId: 'fake', origin: 'https://attacker.example' } },
      'Click',
      {
        tabId: '00000000-0000-0000-0000-000000000001',
        origin: 'https://example.com',
      },
    );
    expect(args.target).toEqual({
      tabId: '00000000-0000-0000-0000-000000000001',
      origin: '[redacted Browser origin]',
    });
    expect(JSON.stringify(args)).not.toContain('example.com');
  });

  it('passes the turn abort signal into script evaluation', async () => {
    manager.evaluate.mockResolvedValue('ok');
    const evaluate = createBrowserTools(() => config()).find((tool) => tool.name === 'browser_evaluate')!;

    await expect(evaluate.execute({ script: 'document.title' }, context)).resolves.toEqual({ result: 'ok' });
    expect(manager.evaluate).toHaveBeenCalledWith(
      'chat-1',
      'document.title',
      '00000000-0000-0000-0000-000000000001',
      assistantRun,
    );
  });

  it('passes turn ownership into inspection, network diagnostics, and screenshots', async () => {
    manager.inspect.mockResolvedValue({ tabId: 'tab-1' });
    manager.networkDiagnostics.mockResolvedValue({ tabId: 'tab-1', requests: [] });
    mockScreenshotResult({
      tabId: 'tab-1',
      mode: 'viewport',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,AAAA',
      width: 10,
      height: 10,
    });
    const tools = createBrowserTools(() => config());

    await tools.find((tool) => tool.name === 'browser_inspect')!.execute({ tabId: 'tab-1' }, context);
    await tools
      .find((tool) => tool.name === 'browser_network')!
      .execute({ tabId: 'tab-1', waitFor: 'network-idle', limit: 25, timeoutMs: 5_000, idleMs: 250 }, context);
    await tools.find((tool) => tool.name === 'browser_screenshot')!.execute({ mode: 'viewport' }, context);

    expect(manager.inspect).toHaveBeenCalledWith('chat-1', 'tab-1', assistantRun, undefined);
    expect(manager.networkDiagnostics).toHaveBeenCalledWith(
      'chat-1',
      { tabId: 'tab-1', waitFor: 'network-idle', limit: 25, timeoutMs: 5_000, idleMs: 250 },
      assistantRun,
      undefined,
    );
    expect(manager.screenshot).toHaveBeenCalledWith(
      'chat-1',
      { mode: 'viewport', tabId: '00000000-0000-0000-0000-000000000001' },
      'assistant',
      assistantRun,
      expect.any(Function),
      undefined,
    );
  });

  it('never exposes a secret-bearing hostname from browser_network failures', async () => {
    manager.networkDiagnostics.mockRejectedValueOnce(
      new Error("net::ERR_NAME_NOT_RESOLVED loading 'https://reset-token.secret-host.example/account'"),
    );
    const network = createBrowserTools(() => config()).find((tool) => tool.name === 'browser_network')!;

    const error = await network.execute({}, context).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('net::ERR_NAME_NOT_RESOLVED');
    expect((error as Error).message).not.toContain('secret-host.example');
  });

  it('returns screenshots through model content without duplicating the data URL', async () => {
    mockScreenshotResult({
      tabId: 'tab-1',
      mode: 'viewport',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,AAAA',
      width: 100,
      height: 50,
    });
    const screenshot = createBrowserTools(() => config()).find((tool) => tool.name === 'browser_screenshot')!;
    const result = (await screenshot.execute({ mode: 'viewport' }, context)) as Record<string, unknown>;
    expect(result).not.toHaveProperty('dataUrl');
    expect(result).toMatchObject({ width: 100, height: 50, mimeType: 'image/png' });
    expect(result._modelContent).toEqual([{ type: 'image', data: 'AAAA', mediaType: 'image/png' }]);
    expect(manager.screenshot).toHaveBeenCalledWith(
      'chat-1',
      { mode: 'viewport', tabId: '00000000-0000-0000-0000-000000000001' },
      'assistant',
      assistantRun,
      expect.any(Function),
      undefined,
    );
  });

  it('fails cleanly if a screenshot capture has no in-memory image payload', async () => {
    mockScreenshotResult({
      tabId: 'tab-1',
      mode: 'viewport',
      mimeType: 'image/png',
      width: 100,
      height: 50,
      filePath: '/tmp/export.png',
    });
    const screenshot = createBrowserTools(() => config()).find((tool) => tool.name === 'browser_screenshot')!;
    await expect(screenshot.execute({ mode: 'viewport' }, context)).rejects.toThrow(/did not return image data/);
  });

  it('keeps AI password autofill disabled by default', async () => {
    const autofill = createBrowserTools(() => config()).find((tool) => tool.name === 'browser_autofill')!;
    await expect(autofill.execute({}, context)).rejects.toThrow(/user-only/);
    expect(manager.autofill).not.toHaveBeenCalled();
  });

  it('allows automatic autofill without returning a password', async () => {
    manager.resolveAssistantTabId.mockReturnValue('tab-1');
    manager.autofill.mockResolvedValue(undefined);
    const autofill = createBrowserTools(() => config({ passwordAccess: 'automatic' })).find(
      (tool) => tool.name === 'browser_autofill',
    )!;
    await expect(autofill.execute({}, context)).resolves.toEqual({
      filled: true,
      tabId: 'tab-1',
      passwordExposed: false,
    });
    expect(manager.autofill).toHaveBeenCalledWith('chat-1', 'tab-1', undefined, 'assistant', assistantRun);
  });
});

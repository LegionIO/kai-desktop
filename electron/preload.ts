import { contextBridge, ipcRenderer } from 'electron';
import type { ComputerUseEvent, ComputerUsePermissionSection, ComputerUseSurface } from '../shared/computer-use.js';
import type { AppShotPayload } from '../shared/app-shots.js';
import type { Appshot } from '../shared/appshots.js';
import type { DiffEvent, FileDiff } from '../shared/diff-types.js';
import type { AdapterCapabilities, PlatformPermissions } from './platform/types.js';
import type { PlatformCapabilities } from './platform/capabilities.js';
import type { CliInstallStatus as CliInstallStatusIpc } from './ipc/cli-install.js';

export type AppAPI = typeof appAPI;

const appAPI = {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (path: string, value: unknown) => ipcRenderer.invoke('config:set', path, value),
    onChanged: (callback: (config: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, config: unknown) => callback(config);
      ipcRenderer.on('config:changed', handler);
      return () => ipcRenderer.removeListener('config:changed', handler);
    },
  },

  agent: {
    stream: (
      conversationId: string,
      messages: unknown[],
      modelKey?: string,
      reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh',
      profileKey?: string,
      fallbackEnabled?: boolean,
      cwd?: string,
      executionMode?: 'auto' | 'plan-first',
      threadOverrides?: {
        temperature?: number | null;
        systemPromptOverride?: string | null;
        maxSteps?: number | null;
        maxRetries?: number | null;
        runtimeOverride?: string | null;
      },
      responseMessageId?: string,
    ) =>
      ipcRenderer.invoke(
        'agent:stream',
        conversationId,
        messages,
        modelKey,
        reasoningEffort,
        profileKey,
        fallbackEnabled,
        cwd,
        executionMode,
        threadOverrides,
        responseMessageId,
      ),
    cancelStream: (conversationId: string) => ipcRenderer.invoke('agent:cancel-stream', conversationId),
    inFlight: (conversationId: string) => ipcRenderer.invoke('agent:in-flight', conversationId) as Promise<boolean>,
    /** Cooperative mid-turn injection (Mastra): enqueue a follow-up into the
     *  running turn (spliced at its next step boundary) instead of a new turn. */
    injectMidTurn: (conversationId: string, userText: string) =>
      ipcRenderer.invoke('agent:inject-mid-turn', conversationId, userText) as Promise<{
        ok: boolean;
        cooperative?: boolean;
        id?: string;
        error?: string;
      }>,
    listInjects: (conversationId: string) =>
      ipcRenderer.invoke('agent:list-injects', conversationId) as Promise<
        Array<{ id: string; text: string; at: number }>
      >,
    cancelInject: (conversationId: string, id: string) =>
      ipcRenderer.invoke('agent:cancel-inject', conversationId, id) as Promise<{ ok: boolean; text?: string }>,
    approveToolCall: (toolCallId: string) => ipcRenderer.invoke('agent:approve-tool', toolCallId),
    rejectToolCall: (toolCallId: string) => ipcRenderer.invoke('agent:reject-tool', toolCallId),
    dismissToolCall: (toolCallId: string) => ipcRenderer.invoke('agent:dismiss-tool', toolCallId),
    answerToolQuestion: (toolCallId: string, answers: Record<string, string>) =>
      ipcRenderer.invoke('agent:answer-tool-question', toolCallId, answers),
    generateTitle: (messages: unknown[], modelKey?: string, hint?: string, conversationId?: string) =>
      ipcRenderer.invoke('agent:generate-title', messages, modelKey, hint, conversationId),
    onStreamEvent: (callback: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('agent:stream-event', handler);
      return () => ipcRenderer.removeListener('agent:stream-event', handler);
    },
    sendSubAgentMessage: (subAgentConversationId: string, message: string) =>
      ipcRenderer.invoke('agent:sub-agent-message', subAgentConversationId, message),
    stopSubAgent: (subAgentConversationId: string) =>
      ipcRenderer.invoke('agent:sub-agent-stop', subAgentConversationId),
    listSubAgents: () => ipcRenderer.invoke('agent:sub-agent-list'),
    getAvailableRuntimes: () => ipcRenderer.invoke('agent:get-available-runtimes'),
    getActiveRuntime: () => ipcRenderer.invoke('agent:get-active-runtime'),
  },

  // Dedicated approval window (flag-gated). The window receives its request
  // payload here and answers via the existing agent.approve/reject/answer
  // methods, then calls close() to dismiss itself.
  approval: {
    onRequest: (callback: (request: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('approval:request', handler);
      return () => ipcRenderer.removeListener('approval:request', handler);
    },
    close: (approvalId: string) => ipcRenderer.send('approval:close', approvalId),
  },

  // Dedicated notification pop-out window (approvals · questions · alerts).
  notification: {
    onRequest: (callback: (item: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('notif:request', handler);
      return () => ipcRenderer.removeListener('notif:request', handler);
    },
    get: (id: string) => ipcRenderer.invoke('notif:get', id),
    close: (id: string) => ipcRenderer.send('notif:close', id),
    reportSize: (height: number) => ipcRenderer.send('notif:resize', height),
  },

  conversations: {
    list: () => ipcRenderer.invoke('conversations:list'),
    search: (term: string) => ipcRenderer.invoke('conversations:search', term),
    get: (id: string) => ipcRenderer.invoke('conversations:get', id),
    put: (conversation: unknown) => ipcRenderer.invoke('conversations:put', conversation),
    delete: (id: string) => ipcRenderer.invoke('conversations:delete', id),
    clear: () => ipcRenderer.invoke('conversations:clear'),
    getActiveId: () => ipcRenderer.invoke('conversations:get-active-id'),
    setActiveId: (id: string) => ipcRenderer.invoke('conversations:set-active-id', id),
    fork: (id: string, upToMessageIndex?: number) =>
      ipcRenderer.invoke('conversations:fork', id, upToMessageIndex) as Promise<{
        ok: boolean;
        conversation?: unknown;
        error?: string;
      }>,
    export: (id: string, format: 'markdown' | 'json') =>
      ipcRenderer.invoke('conversations:export', id, format) as Promise<{
        ok: boolean;
        filePath?: string;
        canceled?: boolean;
        error?: string;
      }>,
    onChanged: (callback: (store: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, store: unknown) => callback(store);
      ipcRenderer.on('conversations:changed', handler);
      return () => ipcRenderer.removeListener('conversations:changed', handler);
    },
    editMessage: (conversationId: string, messageId: string, newContent: unknown) =>
      ipcRenderer.invoke('conversations:edit-message', conversationId, messageId, newContent),
    regenerate: (conversationId: string, assistantMessageId: string) =>
      ipcRenderer.invoke('conversations:regenerate', conversationId, assistantMessageId),
    switchVariant: (conversationId: string, variantId: string) =>
      ipcRenderer.invoke('conversations:switch-variant', conversationId, variantId),
  },

  alerts: {
    list: (openOnly?: boolean) => ipcRenderer.invoke('alerts:list', openOnly),
    get: (id: string) => ipcRenderer.invoke('alerts:get', id),
    unreadCount: () => ipcRenderer.invoke('alerts:unreadCount') as Promise<number>,
    answer: (id: string, answer: Record<string, string>) =>
      ipcRenderer.invoke('alerts:answer', id, answer) as Promise<{ ok: boolean; error?: string }>,
    decide: (id: string, decision: 'approve' | 'deny', note?: string) =>
      ipcRenderer.invoke('alerts:decide', id, decision, note) as Promise<{ ok: boolean; error?: string }>,
    dismiss: (id: string) => ipcRenderer.invoke('alerts:dismiss', id) as Promise<{ ok: boolean; error?: string }>,
    onChanged: (callback: (payload: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
      ipcRenderer.on('alerts:changed', handler);
      return () => ipcRenderer.removeListener('alerts:changed', handler);
    },
    onNavigate: (callback: (payload: { alertId?: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { alertId?: string }) => callback(payload);
      ipcRenderer.on('alerts:navigate', handler);
      return () => ipcRenderer.removeListener('alerts:navigate', handler);
    },
  },

  workspaces: {
    create: (args: { name: string; directory: string }) => ipcRenderer.invoke('workspaces:create', args),
    rename: (args: { id: string; name: string }) => ipcRenderer.invoke('workspaces:rename', args),
    delete: (args: { id: string }) => ipcRenderer.invoke('workspaces:delete', args),
    setActive: (args: { id: string | null }) => ipcRenderer.invoke('workspaces:set-active', args),
    saveLastConversation: (args: { workspaceId: string; conversationId: string | null }) =>
      ipcRenderer.invoke('workspaces:save-last-conversation', args),
    browseDirectory: () =>
      ipcRenderer.invoke('workspaces:browse-directory') as Promise<{ path: string; name: string } | null>,
  },

  memory: {
    clear: (options: { working?: boolean; observational?: boolean; semantic?: boolean; all?: boolean }) =>
      ipcRenderer.invoke('memory:clear', options) as Promise<{ success?: boolean; cleared?: string[]; error?: string }>,
    testEmbedding: () =>
      ipcRenderer.invoke('memory:test-embedding') as Promise<{
        ok?: boolean;
        model?: string;
        dimensions?: number;
        error?: string;
      }>,
  },

  mcp: {
    testConnection: (server: {
      name: string;
      url?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    }) =>
      ipcRenderer.invoke('mcp:test-connection', server) as Promise<{
        status: string;
        toolCount: number;
        error?: string;
      }>,
  },

  cliTools: {
    checkBinaries: (binaryNames: string[]) =>
      ipcRenderer.invoke('cli-tools:check-binaries', binaryNames) as Promise<Record<string, boolean>>,
  },

  cli: {
    installStatus: () => ipcRenderer.invoke('cli:install-status') as Promise<CliInstallStatusIpc>,
    install: () => ipcRenderer.invoke('cli:install') as Promise<CliInstallStatusIpc>,
    uninstall: () => ipcRenderer.invoke('cli:uninstall') as Promise<CliInstallStatusIpc>,
  },

  skills: {
    list: () =>
      ipcRenderer.invoke('skills:list') as Promise<
        Array<{
          name: string;
          description: string;
          version?: string;
          type: string;
          enabled: boolean;
          dir: string;
        }>
      >,
    get: (name: string) =>
      ipcRenderer.invoke('skills:get', name) as Promise<{
        manifest?: Record<string, unknown>;
        files?: Record<string, string>;
        dir?: string;
        error?: string;
      }>,
    delete: (name: string) =>
      ipcRenderer.invoke('skills:delete', name) as Promise<{ success?: boolean; error?: string }>,
    toggle: (name: string, enable: boolean) =>
      ipcRenderer.invoke('skills:toggle', name, enable) as Promise<{ success?: boolean; enabled?: boolean }>,
  },

  diffs: {
    listForConversation: (conversationId: string) =>
      ipcRenderer.invoke('diffs:list', conversationId) as Promise<FileDiff[]>,
    get: (conversationId: string, path: string) =>
      ipcRenderer.invoke('diffs:get', conversationId, path) as Promise<FileDiff | null>,
    revert: (conversationId: string, path: string) =>
      ipcRenderer.invoke('diffs:revert', conversationId, path) as Promise<{ success: boolean; error?: string }>,
    revertAll: (conversationId: string) =>
      ipcRenderer.invoke('diffs:revertAll', conversationId) as Promise<{
        success: boolean;
        reverted: number;
        skipped: string[];
      }>,
    revertHunk: (conversationId: string, path: string, hunkIndex: number) =>
      ipcRenderer.invoke('diffs:revertHunk', conversationId, path, hunkIndex) as Promise<{
        success: boolean;
        error?: string;
      }>,
    revertToOp: (conversationId: string, path: string, opIndex: number) =>
      ipcRenderer.invoke('diffs:revertToOp', conversationId, path, opIndex) as Promise<{
        success: boolean;
        error?: string;
      }>,
    clear: (conversationId: string) =>
      ipcRenderer.invoke('diffs:clear', conversationId) as Promise<{ success: boolean }>,
    onChange: (callback: (event: DiffEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: DiffEvent) => callback(payload);
      ipcRenderer.on('diffs:changed', handler);
      return () => ipcRenderer.removeListener('diffs:changed', handler);
    },
  },

  artifacts: {
    bundleReact: (source: string) =>
      ipcRenderer.invoke('artifact:bundle-react', { source }) as Promise<
        { ok: true; code: string } | { ok: false; error: string }
      >,
    bundleMermaid: () =>
      ipcRenderer.invoke('artifact:bundle-mermaid') as Promise<
        { ok: true; code: string } | { ok: false; error: string }
      >,
  },

  automations: {
    catalog: () =>
      ipcRenderer.invoke('automations:catalog') as Promise<
        Array<{
          source: string;
          displayName: string;
          events: Array<{
            event: string;
            title: string;
            description?: string;
            payloadSchema?: Record<string, unknown>;
          }>;
          actions: Array<{
            targetId: string;
            title: string;
            description?: string;
            inputSchema?: Record<string, unknown>;
          }>;
        }>
      >,
    log: () => ipcRenderer.invoke('automations:log') as Promise<unknown[]>,
    test: (ruleId: string, samplePayload: unknown) =>
      ipcRenderer.invoke('automations:test', ruleId, samplePayload) as Promise<unknown>,
    emit: (source: string, event: string, payload?: unknown) =>
      ipcRenderer.invoke('automations:emit', source, event, payload) as Promise<void>,
    inFlight: (conversationId: string) =>
      ipcRenderer.invoke('automations:in-flight', conversationId) as Promise<boolean>,
    abort: (conversationId: string) => ipcRenderer.invoke('automations:abort', conversationId) as Promise<boolean>,
    onRun: (callback: (record: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('automations:run', handler);
      return () => ipcRenderer.removeListener('automations:run', handler);
    },
    onCatalogChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('automations:catalog-changed', handler);
      return () => ipcRenderer.removeListener('automations:catalog-changed', handler);
    },
  },

  plugins: {
    getUIState: () => ipcRenderer.invoke('plugin:get-ui-state'),
    list: () =>
      ipcRenderer.invoke('plugin:list') as Promise<
        Array<{
          name: string;
          displayName: string;
          version: string;
          description: string;
          state: string;
          brandRequired: boolean;
          icon?: { lucide: string } | { svg: string };
          error?: string;
        }>
      >,
    getConfig: (pluginName: string) =>
      ipcRenderer.invoke('plugin:get-config', pluginName) as Promise<Record<string, unknown>>,
    setConfig: (pluginName: string, path: string, value: unknown) =>
      ipcRenderer.invoke('plugin:set-config', pluginName, path, value) as Promise<{ success: boolean }>,
    modalAction: (pluginName: string, modalId: string, action: string, data?: unknown) =>
      ipcRenderer.invoke('plugin:modal-action', pluginName, modalId, action, data),
    bannerAction: (pluginName: string, bannerId: string, action: string, data?: unknown) =>
      ipcRenderer.invoke('plugin:banner-action', pluginName, bannerId, action, data),
    action: (pluginName: string, targetId: string, action: string, data?: unknown) =>
      ipcRenderer.invoke('plugin:action', pluginName, targetId, action, data),
    marketplaceCatalog: () =>
      ipcRenderer.invoke('plugin:marketplace-catalog') as Promise<
        Array<{
          name: string;
          displayName: string;
          description: string;
          repo: string;
          ref: string;
          version: string;
          author?: string;
          tags?: string[];
          icon?: string;
          installed: boolean;
          installedVersion?: string;
          marketplaceUrl: string;
        }>
      >,
    marketplaceInstall: (pluginName: string) =>
      ipcRenderer.invoke('plugin:marketplace-install', pluginName) as Promise<{
        success: boolean;
        needsConfirmation?: boolean;
        pluginName?: string;
        reason?: 'no-integrity-hash';
      }>,
    marketplaceInstallUnverified: (pluginName: string) =>
      ipcRenderer.invoke('plugin:marketplace-install-unverified', pluginName) as Promise<{ success: boolean }>,
    marketplaceUninstall: (pluginName: string) =>
      ipcRenderer.invoke('plugin:marketplace-uninstall', pluginName) as Promise<{ success: boolean }>,
    disable: (pluginName: string, opts?: { persist?: boolean }) =>
      ipcRenderer.invoke('plugin:disable', pluginName, opts) as Promise<{ success: boolean }>,
    enable: (pluginName: string) => ipcRenderer.invoke('plugin:enable', pluginName) as Promise<{ success: boolean }>,
    pause: (pluginName: string) => ipcRenderer.invoke('plugin:pause', pluginName) as Promise<{ success: boolean }>,
    resume: (pluginName: string) => ipcRenderer.invoke('plugin:resume', pluginName) as Promise<{ success: boolean }>,
    kill: (pluginName: string) => ipcRenderer.invoke('plugin:kill', pluginName) as Promise<{ success: boolean }>,
    marketplaceRefresh: () =>
      ipcRenderer.invoke('plugin:marketplace-refresh') as Promise<
        Array<{
          name: string;
          displayName: string;
          description: string;
          repo: string;
          ref: string;
          version: string;
          author?: string;
          tags?: string[];
          icon?: string;
          installed: boolean;
          installedVersion?: string;
          marketplaceUrl: string;
        }>
      >,
    onUIStateChanged: (callback: (state: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
      ipcRenderer.on('plugin:ui-state-changed', handler);
      return () => ipcRenderer.removeListener('plugin:ui-state-changed', handler);
    },
    getAvailableUpdateCount: () => ipcRenderer.invoke('plugin:available-update-count') as Promise<number>,
    onUpdatesAvailable: (callback: (data: { count: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { count: number }) => callback(data);
      ipcRenderer.on('plugin:updates-available', handler);
      return () => ipcRenderer.removeListener('plugin:updates-available', handler);
    },
    getPendingRestart: () => ipcRenderer.invoke('plugin:pending-restart') as Promise<string[]>,
    restartApp: () => ipcRenderer.invoke('plugin:restart-app') as Promise<{ success: boolean }>,
    onPendingRestartChanged: (callback: (data: { plugins: string[] }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { plugins: string[] }) => callback(data);
      ipcRenderer.on('plugin:pending-restart-changed', handler);
      return () => ipcRenderer.removeListener('plugin:pending-restart-changed', handler);
    },
    getFailedUpdates: () =>
      ipcRenderer.invoke('plugin:failed-updates') as Promise<
        Array<{ name: string; attemptedVersion: string; runningVersion: string; error: string }>
      >,
    onFailedUpdatesChanged: (
      callback: (data: {
        failedUpdates: Array<{ name: string; attemptedVersion: string; runningVersion: string; error: string }>;
      }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: {
          failedUpdates: Array<{ name: string; attemptedVersion: string; runningVersion: string; error: string }>;
        },
      ) => callback(data);
      ipcRenderer.on('plugin:failed-updates-changed', handler);
      return () => ipcRenderer.removeListener('plugin:failed-updates-changed', handler);
    },
    onEvent: (callback: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('plugin:event', handler);
      return () => ipcRenderer.removeListener('plugin:event', handler);
    },
    onNavigationRequest: (callback: (request: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('plugin:navigation-request', handler);
      return () => ipcRenderer.removeListener('plugin:navigation-request', handler);
    },
    onNavigateDirect: (callback: (data: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('plugin:navigate-direct', handler);
      return () => ipcRenderer.removeListener('plugin:navigate-direct', handler);
    },
    onModalCallback: (callback: (data: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('plugin:modal-callback', handler);
      return () => ipcRenderer.removeListener('plugin:modal-callback', handler);
    },
    approveConsent: (pluginName: string) =>
      ipcRenderer.invoke('plugin:approve-consent', pluginName) as Promise<{ success: boolean }>,
    denyConsent: (pluginName: string) =>
      ipcRenderer.invoke('plugin:deny-consent', pluginName) as Promise<{ success: boolean }>,
    getPendingConsent: () =>
      ipcRenderer.invoke('plugin:pending-consent') as Promise<
        Array<{
          pluginName: string;
          displayName: string;
          permissions: string[];
          dangerousPermissions: string[];
          execScope?: { binaries: string[]; argPatterns?: Record<string, string[]> };
          fileHash: string;
        }>
      >,
    onConsentRequired: (callback: (data: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('plugin:consent-required', handler);
      return () => ipcRenderer.removeListener('plugin:consent-required', handler);
    },
  },

  modelCatalog: () => ipcRenderer.invoke('agent:model-catalog'),

  realtime: {
    startSession: (conversationId: string) =>
      ipcRenderer.invoke('realtime:start-session', conversationId) as Promise<{ ok?: boolean; error?: string }>,
    endSession: () => ipcRenderer.invoke('realtime:end-session') as Promise<{ ok?: boolean }>,
    sendAudio: (pcmBase64: string) => ipcRenderer.send('realtime:send-audio', pcmBase64),
    getStatus: () => ipcRenderer.invoke('realtime:get-status') as Promise<{ status: string }>,
    onEvent: (callback: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('realtime:event', handler);
      return () => ipcRenderer.removeListener('realtime:event', handler);
    },
  },

  profileCatalog: () => ipcRenderer.invoke('agent:profiles'),

  dialog: {
    openFile: (options?: { filters?: Array<{ name: string; extensions: string[] }> }) =>
      ipcRenderer.invoke('dialog:open-file', options),
    openDirectory: () => ipcRenderer.invoke('dialog:open-directory'),
    openDirectoryFiles: () => ipcRenderer.invoke('dialog:open-directory-files'),
    openPath: () =>
      ipcRenderer.invoke('dialog:open-path') as Promise<
        { canceled: true } | { canceled: false; path: string; isDirectory: boolean; name: string }
      >,
  },

  fileAccess: {
    previewPath: (entry: string) =>
      ipcRenderer.invoke('fileAccess:preview-path', entry) as Promise<{
        normalized: string;
        exists: boolean;
        isDirectory: boolean;
        matchCount: number;
        capped: boolean;
        allowed: boolean;
        denied: boolean;
        matchesAll?: boolean;
        error?: string;
      }>,
  },

  clipboard: {
    writeText: (text: string) =>
      ipcRenderer.invoke('clipboard:write-text', text) as Promise<{ ok: boolean; error?: string }>,
  },

  image: {
    fetch: (url: string) =>
      ipcRenderer.invoke('image:fetch', url) as Promise<{ data?: string; mime?: string; error?: string }>,
    save: (url: string, suggestedName?: string) =>
      ipcRenderer.invoke('image:save', url, suggestedName) as Promise<{
        canceled?: boolean;
        filePath?: string;
        error?: string;
      }>,
  },

  shell: {
    openPath: (filePath: string) =>
      ipcRenderer.invoke('shell:open-path', filePath) as Promise<{ ok: boolean; error?: string }>,
  },

  platform: {
    os: process.platform as 'darwin' | 'win32' | 'linux',
    homedir: () => ipcRenderer.invoke('platform:homedir'),
    getCapabilities: () =>
      ipcRenderer.invoke('platform:get-capabilities') as Promise<{ kind: string; capabilities: AdapterCapabilities }>,
    getPermissions: () => ipcRenderer.invoke('platform:get-permissions') as Promise<PlatformPermissions>,
    /** High-level product-feature capabilities per OS (#82). Distinct from the
     *  low-level adapter capabilities returned by `getCapabilities`. */
    getFeatureCapabilities: (): Promise<PlatformCapabilities> =>
      ipcRenderer.invoke('platform:get-feature-capabilities'),
    /** Push the aggregate attention badge to the OS app icon (macOS Dock /
     *  Windows taskbar overlay / Linux Unity count). Best-effort. */
    setDockBadge: (value: { count: number; hasText: boolean; style: 'dot' | 'truncate' | 'full' }): Promise<void> =>
      ipcRenderer.invoke('ui:set-dock-badge', value),
  },

  webServer: {
    getLanAddresses: () => ipcRenderer.invoke('webServer:lan-addresses') as Promise<string[]>,
    createToken: () => ipcRenderer.invoke('webServer:create-token') as Promise<string | null>,
  },

  fs: {
    listDirectory: (dirPath: string) =>
      ipcRenderer.invoke('fs:list-directory', dirPath) as Promise<{
        path?: string;
        entries: Array<{ name: string; isDirectory: boolean }>;
        error?: string;
      }>,
  },

  plans: {
    readFile: (filename: string) =>
      ipcRenderer.invoke('plans:read-file', filename) as Promise<{ content?: string; error?: string }>,
  },

  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    listAll: () => ipcRenderer.invoke('tasks:list-all'),
    get: (id: string) => ipcRenderer.invoke('tasks:get', id),
    create: (taskData: unknown) => ipcRenderer.invoke('tasks:create', taskData),
    update: (id: string, updates: unknown) => ipcRenderer.invoke('tasks:update', id, updates),
    delete: (id: string) => ipcRenderer.invoke('tasks:delete', id),
    unarchive: (id: string) => ipcRenderer.invoke('tasks:unarchive', id),
    kickBack: (id: string, reason: string, source: 'ai' | 'human') =>
      ipcRenderer.invoke('tasks:kick-back', id, reason, source),
    getOrder: () => ipcRenderer.invoke('tasks:get-order'),
    saveOrder: (order: unknown) => ipcRenderer.invoke('tasks:save-order', order),
    onChanged: (callback: (tasks: unknown[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, tasks: unknown[]) => callback(tasks);
      ipcRenderer.on('tasks:changed', handler);
      return () => ipcRenderer.removeListener('tasks:changed', handler);
    },
    // Terminal methods
    terminalCreate: (taskId: string, options: { runtime: string; cwd?: string; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('tasks:terminal-create', taskId, options) as Promise<{ sessionId?: string; error?: string }>,
    terminalWrite: (sessionId: string, data: string) => ipcRenderer.invoke('tasks:terminal-write', sessionId, data),
    terminalResize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('tasks:terminal-resize', sessionId, cols, rows),
    terminalKill: (sessionId: string) =>
      ipcRenderer.invoke('tasks:terminal-kill', sessionId) as Promise<{ ok: boolean }>,
    terminalGetBuffer: (sessionId: string) =>
      ipcRenderer.invoke('tasks:terminal-get-buffer', sessionId) as Promise<string[]>,
    onTerminalData: (callback: (event: { sessionId: string; data: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; data: string }) => callback(data);
      ipcRenderer.on('tasks:terminal-data', handler);
      return () => ipcRenderer.removeListener('tasks:terminal-data', handler);
    },
    onTerminalExit: (callback: (event: { sessionId: string; exitCode: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; exitCode: number }) =>
        callback(data);
      ipcRenderer.on('tasks:terminal-exit', handler);
      return () => ipcRenderer.removeListener('tasks:terminal-exit', handler);
    },
    // AI plan generation
    streamPlan: (taskId: string, userMessage: string, history?: unknown[]) =>
      ipcRenderer.invoke('tasks:stream-plan', taskId, userMessage, history) as Promise<{ taskId: string }>,
    cancelPlanStream: (taskId: string) => ipcRenderer.invoke('tasks:cancel-stream', taskId) as Promise<{ ok: boolean }>,
    generateTitle: (userMessage: string) =>
      ipcRenderer.invoke('tasks:generate-title', userMessage) as Promise<{ title: string | null }>,
    onStreamEvent: (callback: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('tasks:stream-event', handler);
      return () => ipcRenderer.removeListener('tasks:stream-event', handler);
    },
  },

  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
    get: (id: string) => ipcRenderer.invoke('agents:get', id),
    create: (payload: unknown) => ipcRenderer.invoke('agents:create', payload),
    update: (id: string, updates: unknown) => ipcRenderer.invoke('agents:update', id, updates),
    delete: (id: string) => ipcRenderer.invoke('agents:delete', id),
    assignTask: (agentId: string, taskId: string) => ipcRenderer.invoke('agents:assign-task', agentId, taskId),
    unassignTask: (agentId: string) => ipcRenderer.invoke('agents:unassign-task', agentId),
    start: (agentId: string) =>
      ipcRenderer.invoke('agents:start', agentId) as Promise<{ sessionId?: string; error?: string }>,
    stop: (agentId: string) => ipcRenderer.invoke('agents:stop', agentId),
    synthesizePrompt: (agentId: string, userDescription: string) =>
      ipcRenderer.invoke('agents:synthesize-prompt', agentId, userDescription),
    onChanged: (callback: (agents: unknown[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, agents: unknown[]) => callback(agents);
      ipcRenderer.on('agents:changed', handler);
      return () => ipcRenderer.removeListener('agents:changed', handler);
    },
  },

  orchestrator: {
    getState: () => ipcRenderer.invoke('orchestrator:get-state'),
    toggle: (enabled: boolean) => ipcRenderer.invoke('orchestrator:toggle', enabled),
    setConfig: (config: Record<string, unknown>) => ipcRenderer.invoke('orchestrator:set-config', config),
    getConfig: () => ipcRenderer.invoke('orchestrator:get-config'),
    forceTick: () => ipcRenderer.invoke('orchestrator:force-tick'),
    clearLog: () => ipcRenderer.invoke('orchestrator:clear-log'),
    onStateChanged: (callback: (state: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
      ipcRenderer.on('orchestrator:state-changed', handler);
      return () => {
        ipcRenderer.removeListener('orchestrator:state-changed', handler);
      };
    },
  },

  computerUse: {
    startSession: (goal: string, options: unknown) => ipcRenderer.invoke('computer-use:start-session', goal, options),
    pauseSession: (sessionId: string) => ipcRenderer.invoke('computer-use:pause-session', sessionId),
    resumeSession: (sessionId: string) => ipcRenderer.invoke('computer-use:resume-session', sessionId),
    stopSession: (sessionId: string) => ipcRenderer.invoke('computer-use:stop-session', sessionId),
    approveAction: (sessionId: string, actionId: string) =>
      ipcRenderer.invoke('computer-use:approve-action', sessionId, actionId),
    rejectAction: (sessionId: string, actionId: string, reason?: string) =>
      ipcRenderer.invoke('computer-use:reject-action', sessionId, actionId, reason),
    listSessions: () => ipcRenderer.invoke('computer-use:list-sessions'),
    getSession: (sessionId: string) => ipcRenderer.invoke('computer-use:get-session', sessionId),
    setSurface: (sessionId: string, surface: ComputerUseSurface) =>
      ipcRenderer.invoke('computer-use:set-surface', sessionId, surface),
    sendGuidance: (sessionId: string, text: string) =>
      ipcRenderer.invoke('computer-use:send-guidance', sessionId, text),
    updateSessionSettings: (
      sessionId: string,
      settings: {
        modelKey?: string | null;
        profileKey?: string | null;
        fallbackEnabled?: boolean;
        reasoningEffort?: string;
      },
    ) => ipcRenderer.invoke('computer-use:update-session-settings', sessionId, settings),
    continueSession: (sessionId: string, newGoal: string) =>
      ipcRenderer.invoke('computer-use:continue-session', sessionId, newGoal),
    markSessionsSeen: (conversationId: string) => ipcRenderer.invoke('computer-use:mark-sessions-seen', conversationId),
    openSetupWindow: (conversationId?: string | null) =>
      ipcRenderer.invoke('computer-use:open-setup-window', conversationId),
    getLocalMacosPermissions: () => ipcRenderer.invoke('computer-use:get-local-macos-permissions'),
    requestLocalMacosPermissions: () => ipcRenderer.invoke('computer-use:request-local-macos-permissions'),
    requestSingleLocalMacosPermission: (section: ComputerUsePermissionSection) =>
      ipcRenderer.invoke('computer-use:request-single-local-macos-permission', section),
    openLocalMacosPrivacySettings: (section?: ComputerUsePermissionSection) =>
      ipcRenderer.invoke('computer-use:open-local-macos-privacy-settings', section),
    probeInputMonitoring: (timeoutMs?: number) =>
      ipcRenderer.invoke('computer-use:probe-input-monitoring', timeoutMs) as Promise<{
        inputMonitoringGranted: boolean;
      }>,
    checkFullScreenApps: () =>
      ipcRenderer.invoke('computer-use:check-fullscreen-apps') as Promise<{
        apps: string[];
        problematicApps: string[];
      }>,
    exitFullScreenApps: (appNames: string[]) =>
      ipcRenderer.invoke('computer-use:exit-fullscreen-apps', appNames) as Promise<{
        exited: string[];
        failed: string[];
      }>,
    listRunningApps: () => ipcRenderer.invoke('computer-use:list-running-apps') as Promise<{ apps: string[] }>,
    listDisplays: () =>
      ipcRenderer.invoke('computer-use:list-displays') as Promise<{
        displays: Array<{
          name: string;
          displayId: string;
          pixelWidth: number;
          pixelHeight: number;
          isPrimary: boolean;
        }>;
      }>,
    focusSession: (sessionId: string) => ipcRenderer.invoke('computer-use:focus-session', sessionId),
    overlayMouseEnter: () => ipcRenderer.send('computer-use:overlay-set-ignore-mouse', false),
    overlayMouseLeave: () => ipcRenderer.send('computer-use:overlay-set-ignore-mouse', true),
    onEvent: (callback: (event: ComputerUseEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: ComputerUseEvent) => callback(data);
      ipcRenderer.on('computer-use:event', handler);
      return () => ipcRenderer.removeListener('computer-use:event', handler);
    },
    onOverlayState: (callback: (state: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('computer-use:overlay-state', handler);
      return () => ipcRenderer.removeListener('computer-use:overlay-state', handler);
    },
    onFocusThread: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('computer-use:focus-thread', handler);
      return () => ipcRenderer.removeListener('computer-use:focus-thread', handler);
    },
  },

  mic: {
    listDevices: () => ipcRenderer.invoke('stt:list-devices') as Promise<Array<{ deviceId: string; label: string }>>,
    startRecording: (deviceId?: string) =>
      ipcRenderer.invoke('stt:start-recording', deviceId) as Promise<{
        ok?: boolean;
        silent?: boolean;
        error?: string;
      }>,
    stopRecording: () =>
      ipcRenderer.invoke('stt:stop-recording') as Promise<{
        wavBase64?: string;
        durationSec?: number;
        maxAmplitude?: number;
        error?: string;
      }>,
    cancelRecording: () => ipcRenderer.invoke('stt:cancel-recording') as Promise<{ ok?: boolean }>,
    startMonitor: (deviceIds?: string[]) =>
      ipcRenderer.invoke('stt:start-monitor', deviceIds) as Promise<Record<string, { ok?: boolean; error?: string }>>,
    getLevel: () => ipcRenderer.invoke('stt:get-level') as Promise<Record<string, number>>,
    stopMonitor: () => ipcRenderer.invoke('stt:stop-monitor') as Promise<{ ok?: boolean }>,
    liveStart: (config: {
      subscriptionKey: string;
      region?: string;
      endpoint?: string;
      language: string;
      deviceId?: string;
    }) => ipcRenderer.invoke('stt:live-start', config) as Promise<{ ok?: boolean; error?: string }>,
    liveMicStart: (deviceId?: string) =>
      ipcRenderer.invoke('stt:live-mic-start', deviceId) as Promise<{ ok?: boolean; error?: string }>,
    liveMicDrain: () => ipcRenderer.invoke('stt:live-mic-drain') as Promise<string[]>,
    liveMicStop: () => ipcRenderer.invoke('stt:live-mic-stop') as Promise<{ ok?: boolean }>,
    liveAudio: (pcmBase64: string) => ipcRenderer.send('stt:live-audio', pcmBase64),
    liveStop: () => ipcRenderer.invoke('stt:live-stop') as Promise<{ ok?: boolean }>,
    onPartial: (callback: (text: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, text: string) => callback(text);
      ipcRenderer.on('stt:partial', handler);
      return () => ipcRenderer.removeListener('stt:partial', handler);
    },
    onFinal: (callback: (text: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, text: string) => callback(text);
      ipcRenderer.on('stt:final', handler);
      return () => ipcRenderer.removeListener('stt:final', handler);
    },
    onSttError: (callback: (error: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, error: string) => callback(error);
      ipcRenderer.on('stt:error', handler);
      return () => ipcRenderer.removeListener('stt:error', handler);
    },
    streamStart: (options?: { deviceId?: string; language?: string }) =>
      ipcRenderer.invoke('stt:stream-start', options) as Promise<{ ok?: boolean; error?: string }>,
    streamStop: () => ipcRenderer.invoke('stt:stream-stop') as Promise<{ text: string; error?: string }>,
    streamCancel: () => ipcRenderer.invoke('stt:stream-cancel') as Promise<{ ok?: boolean }>,
    batchTranscribe: (options: { wavBase64?: string; language: string }) =>
      ipcRenderer.invoke('stt:batch-transcribe', options) as Promise<{
        text: string;
        durationSec?: number;
        error?: string;
      }>,
    onTranscriptionProgress: (
      callback: (progress: { percent: number; chunkIndex: number; totalChunks: number }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        progress: { percent: number; chunkIndex: number; totalChunks: number },
      ) => callback(progress);
      ipcRenderer.on('stt:transcription-progress', handler);
      return () => ipcRenderer.removeListener('stt:transcription-progress', handler);
    },
  },

  usage: {
    summary: () => ipcRenderer.invoke('usage:summary'),
    byConversation: (params?: Record<string, unknown>) => ipcRenderer.invoke('usage:by-conversation', params),
    byModel: () => ipcRenderer.invoke('usage:by-model'),
    timeSeries: (params?: Record<string, unknown>) => ipcRenderer.invoke('usage:time-series', params),
    nonLlmEvents: (params?: Record<string, string>) => ipcRenderer.invoke('usage:non-llm-events', params),
    recordEvent: (event: unknown) => ipcRenderer.invoke('usage:record-event', event),
    exportCsv: () => ipcRenderer.invoke('usage:export-csv'),
  },

  autoUpdate: {
    check: () => ipcRenderer.invoke('auto-update:check'),
    install: () => ipcRenderer.invoke('auto-update:install'),
    onStatus: (callback: (status: Record<string, unknown>) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: Record<string, unknown>) => callback(status);
      ipcRenderer.on('auto-update:status', handler);
      return () => ipcRenderer.removeListener('auto-update:status', handler);
    },
  },

  ota: {
    check: () => ipcRenderer.invoke('ota:check'),
    download: () => ipcRenderer.invoke('ota:download'),
    apply: () => ipcRenderer.invoke('ota:apply'),
    applyAndRestart: () => ipcRenderer.invoke('ota:apply-and-restart'),
    status: () => ipcRenderer.invoke('ota:status'),
    rollback: () => ipcRenderer.invoke('ota:rollback'),
    onStatus: (callback: (status: Record<string, unknown>) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: Record<string, unknown>) => callback(status);
      ipcRenderer.on('ota:status', handler);
      return () => ipcRenderer.removeListener('ota:status', handler);
    },
  },

  onMenuOpenSettings: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('menu:open-settings', handler);
    return () => ipcRenderer.removeListener('menu:open-settings', handler);
  },

  onFind: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('menu:find', handler);
    return () => ipcRenderer.removeListener('menu:find', handler);
  },

  onModelSwitched: (callback: (modelKey: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, modelKey: string) => callback(modelKey);
    ipcRenderer.on('agent:model-switched', handler);
    return () => ipcRenderer.removeListener('agent:model-switched', handler);
  },

  onExecutionModeChanged: (callback: (mode: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, mode: string) => callback(mode);
    ipcRenderer.on('agent:execution-mode-changed', handler);
    return () => ipcRenderer.removeListener('agent:execution-mode-changed', handler);
  },

  partitions: {
    list: () => ipcRenderer.invoke('partitions:list') as Promise<Array<{ name: string; sizeBytes: number }>>,
    delete: (names: string[]) =>
      ipcRenderer.invoke('partitions:delete', names) as Promise<{
        success?: boolean;
        deleted?: string[];
        error?: string;
      }>,
  },

  debug: {
    log: (file: string, message: string) => ipcRenderer.send('debug:log', file, message),
  },

  diagnostics: {
    getSummary: () =>
      ipcRenderer.invoke('diagnostics:get-summary') as Promise<{
        logPath: string;
        logSizeBytes: number;
        sinceBoot: string;
        totalErrors: number;
        counters: Array<{
          key: string;
          kind: 'uncaughtException' | 'unhandledRejection';
          plugin: string | null;
          count: number;
          lastTs: string;
          sample: string;
        }>;
        pluginProcesses: Array<{
          pluginName: string;
          displayName: string;
          pid: number | null;
          status: 'starting' | 'running' | 'paused' | 'stopping' | 'crashed';
          canPause: boolean;
          startedAt: string;
          crashCount: number;
          lastExitCode: number | null;
          lastError: string | null;
          cpuPercent: number;
          cumulativeCpuSeconds: number | null;
          privateMemoryBytes: number;
          residentSetBytes: number;
        }>;
      }>,
    tailLog: (maxBytes?: number) =>
      ipcRenderer.invoke('diagnostics:tail-log', maxBytes) as Promise<{
        text: string;
        sizeBytes: number;
        truncated: boolean;
      }>,
    clearLog: () => ipcRenderer.invoke('diagnostics:clear-log') as Promise<{ success: boolean; logSizeBytes: number }>,
    resetCounters: () => ipcRenderer.invoke('diagnostics:reset-counters') as Promise<{ success: boolean }>,
  },

  appShots: {
    capture: () => ipcRenderer.invoke('app-shots:capture') as Promise<AppShotPayload>,
    suspendHotkey: () => ipcRenderer.invoke('app-shots:suspend-hotkey'),
    resumeHotkey: () => ipcRenderer.invoke('app-shots:resume-hotkey'),
    resolveRef: (refId: string) => ipcRenderer.invoke('app-shots:resolve-ref', refId) as Promise<AppShotPayload | null>,
    onCaptured: (callback: (payload: AppShotPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: AppShotPayload) => callback(payload);
      ipcRenderer.on('app-shots:captured', handler);
      return () => ipcRenderer.removeListener('app-shots:captured', handler);
    },
  },

  // Persisted appshot gallery (#81) — distinct from `appShots` (ephemeral capture).
  appshots: {
    list: (): Promise<Appshot[]> => ipcRenderer.invoke('appshots:list'),
    get: (id: string): Promise<Appshot | null> => ipcRenderer.invoke('appshots:get', id),
    getImage: (id: string): Promise<string | null> => ipcRenderer.invoke('appshots:get-image', id),
    delete: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('appshots:delete', id),
    deleteAll: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('appshots:delete-all'),
    update: (
      id: string,
      patch: { tags?: string[]; pinned?: boolean },
    ): Promise<{ ok: boolean; error?: string; appshot?: Appshot }> => ipcRenderer.invoke('appshots:update', id, patch),
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('appshots:changed', handler);
      return () => ipcRenderer.removeListener('appshots:changed', handler);
    },
  },

  dictation: {
    toggle: () => ipcRenderer.invoke('dictation:toggle'),
    stop: () => ipcRenderer.invoke('dictation:stop'),
    getState: () => ipcRenderer.invoke('dictation:get-state'),
    getTypingMode: () => ipcRenderer.invoke('dictation:get-typing-mode'),
    setDevice: (deviceId: string) => ipcRenderer.invoke('dictation:set-device', deviceId),
    suspendHotkey: () => ipcRenderer.invoke('dictation:suspend-hotkey'),
    resumeHotkey: () => ipcRenderer.invoke('dictation:resume-hotkey'),
    setOverlayInteractive: (interactive: boolean) => ipcRenderer.send('dictation:overlay-set-interactive', interactive),
    resizeOverlay: (height: number) => ipcRenderer.send('dictation:overlay-resize', height),
    restoreOverlayFocus: () => ipcRenderer.send('dictation:overlay-restore-focus'),
    onStateChange: (
      callback: (state: {
        state: string;
        elapsed: number;
        hotkeyRegistered?: boolean;
        hotkeyError?: string | null;
      }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        state: { state: string; elapsed: number; hotkeyRegistered?: boolean; hotkeyError?: string | null },
      ) => callback(state);
      ipcRenderer.on('dictation:state', handler);
      return () => ipcRenderer.removeListener('dictation:state', handler);
    },
    onLevel: (callback: (level: number) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, level: number) => callback(level);
      ipcRenderer.on('dictation:level', handler);
      return () => ipcRenderer.removeListener('dictation:level', handler);
    },
    onPartial: (callback: (text: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, text: string) => callback(text);
      ipcRenderer.on('dictation:partial', handler);
      return () => ipcRenderer.removeListener('dictation:partial', handler);
    },
    onFinal: (callback: (text: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, text: string) => callback(text);
      ipcRenderer.on('dictation:final', handler);
      return () => ipcRenderer.removeListener('dictation:final', handler);
    },
    onError: (callback: (message: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
      ipcRenderer.on('dictation:error', handler);
      return () => ipcRenderer.removeListener('dictation:error', handler);
    },
    onTypingMode: (callback: (mode: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, mode: string) => callback(mode);
      ipcRenderer.on('dictation:typing-mode', handler);
      return () => ipcRenderer.removeListener('dictation:typing-mode', handler);
    },
  },

  titlebar: {
    doubleClick: () => ipcRenderer.invoke('titlebar:double-click'),
  },
};

contextBridge.exposeInMainWorld('app', appAPI);

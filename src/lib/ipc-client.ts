import type {
  ComputerUseEvent,
  ComputerUsePermissions,
  ComputerUsePermissionRequestResult,
  ComputerUsePermissionSection,
  ComputerUseSurface,
} from '../../shared/computer-use';
import type { TaskFile, KaiTaskOrder, TaskConversationMessage, TaskStreamEvent } from '../../shared/task-types';
import type { AgentFile, CreateAgentPayload } from '../../shared/agent-types';
import type { AppShotPayload } from '../../shared/app-shots';
import type { Appshot } from '../../shared/appshots';
import type { DiffEvent, FileDiff } from '../../shared/diff-types';
import type { AdapterCapabilities, PlatformPermissions } from '../../electron/platform/types';
import type { PlatformCapabilities } from '../../electron/platform/capabilities';
import type { ConversationChange } from '../../electron/ipc/conversations';
import type { CliInstallStatus } from '../../electron/ipc/cli-install';
import type { Alert, AlertIndexEntry } from '../../electron/ipc/alert-store';

export type { ConversationChange } from '../../electron/ipc/conversations';
export type { ConversationRecord } from '../../electron/ipc/conversation-store';
export type { CliInstallStatus } from '../../electron/ipc/cli-install';
export type { Alert, AlertIndexEntry, AlertKind, AlertStatus, AlertQuestion } from '../../electron/ipc/alert-store';

/** Payload pushed on `alerts:changed` — the reason + the affected alert. */
export type AlertsChangedPayload = { reason: 'created' | 'resolved' | 'dismissed'; alert?: Alert };

export type AutomationSourceCatalogEntry = {
  source: string;
  displayName: string;
  events: Array<{ event: string; title: string; description?: string; payloadSchema?: Record<string, unknown> }>;
  actions: Array<{ targetId: string; title: string; description?: string; inputSchema?: Record<string, unknown> }>;
};

export type AutomationRunRecord = {
  id: string;
  ruleId: string;
  ruleName: string;
  ts: number;
  event: { key: string; source: string; event: string; payload: unknown };
  matched: boolean;
  skippedReason?: 'debounce' | 'rate-limit' | 'conditions';
  results: Array<{ type: string; ok: boolean; output?: unknown; error?: string; durationMs: number }>;
  error?: string;
};

type AppAPI = {
  config: {
    get: () => Promise<unknown>;
    set: (path: string, value: unknown) => Promise<unknown>;
    onChanged: (callback: (config: unknown) => void) => () => void;
  };
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
    ) => Promise<unknown>;
    cancelStream: (conversationId: string) => Promise<unknown>;
    inFlight: (conversationId: string) => Promise<boolean>;
    injectMidTurn: (
      conversationId: string,
      userText: string,
    ) => Promise<{ ok: boolean; cooperative?: boolean; id?: string; error?: string }>;
    listInjects: (conversationId: string) => Promise<Array<{ id: string; text: string; at: number }>>;
    cancelInject: (conversationId: string, id: string) => Promise<{ ok: boolean; text?: string }>;
    approveToolCall: (toolCallId: string) => Promise<{ ok: boolean }>;
    rejectToolCall: (toolCallId: string) => Promise<{ ok: boolean }>;
    dismissToolCall: (toolCallId: string) => Promise<{ ok: boolean }>;
    answerToolQuestion: (toolCallId: string, answers: Record<string, string>) => Promise<{ ok: boolean }>;
    generateTitle: (
      messages: unknown[],
      modelKey?: string,
      hint?: string,
      conversationId?: string,
    ) => Promise<{ title: string | null; suppressed?: boolean }>;
    onStreamEvent: (callback: (event: unknown) => void) => () => void;
    sendSubAgentMessage: (subAgentConversationId: string, message: string) => Promise<{ ok: boolean }>;
    stopSubAgent: (subAgentConversationId: string) => Promise<{ ok: boolean }>;
    listSubAgents: () => Promise<{ ids: string[] }>;
    getAvailableRuntimes: () => Promise<Array<{ id: string; name: string; available: boolean; reason?: string }>>;
    getActiveRuntime: () => Promise<string>;
  };
  approval: {
    onRequest: (callback: (request: unknown) => void) => () => void;
    close: (approvalId: string) => void;
  };
  notification: {
    onRequest: (callback: (item: unknown) => void) => () => void;
    get: (id: string) => Promise<unknown>;
    close: (id: string) => void;
    reportSize: (height: number) => void;
  };
  conversations: {
    list: () => Promise<unknown[]>;
    search: (term: string) => Promise<unknown[]>;
    get: (id: string) => Promise<unknown>;
    put: (conversation: unknown) => Promise<unknown>;
    delete: (id: string) => Promise<unknown>;
    clear: () => Promise<unknown>;
    getActiveId: () => Promise<string | null>;
    setActiveId: (id: string) => Promise<unknown>;
    fork: (
      id: string,
      upToMessageIndex?: number,
    ) => Promise<{ ok: boolean; conversation?: { id: string } & Record<string, unknown>; error?: string }>;
    export: (
      id: string,
      format: 'markdown' | 'json',
    ) => Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }>;
    onChanged: (callback: (change: ConversationChange) => void) => () => void;
    editMessage: (
      conversationId: string,
      messageId: string,
      newContent: unknown,
    ) => Promise<{ ok: boolean; conversation?: unknown; error?: string }>;
    regenerate: (
      conversationId: string,
      assistantMessageId: string,
    ) => Promise<{ ok: boolean; conversation?: unknown; error?: string }>;
    switchVariant: (
      conversationId: string,
      variantId: string,
    ) => Promise<{ ok: boolean; conversation?: unknown; error?: string }>;
  };
  alerts: {
    list: (openOnly?: boolean) => Promise<AlertIndexEntry[]>;
    get: (id: string) => Promise<Alert | null>;
    unreadCount: () => Promise<number>;
    answer: (id: string, answer: Record<string, string>) => Promise<{ ok: boolean; error?: string }>;
    decide: (id: string, decision: 'approve' | 'deny', note?: string) => Promise<{ ok: boolean; error?: string }>;
    dismiss: (id: string) => Promise<{ ok: boolean; error?: string }>;
    onChanged: (callback: (payload: AlertsChangedPayload) => void) => () => void;
    onNavigate: (callback: (payload: { alertId?: string }) => void) => () => void;
  };
  workspaces: {
    create: (args: { name: string; directory: string }) => Promise<unknown>;
    rename: (args: { id: string; name: string }) => Promise<void>;
    delete: (args: { id: string }) => Promise<void>;
    setActive: (args: { id: string | null }) => Promise<void>;
    saveLastConversation: (args: { workspaceId: string; conversationId: string | null }) => Promise<void>;
    browseDirectory: () => Promise<{ path: string; name: string } | null>;
  };
  memory: {
    clear: (options: {
      working?: boolean;
      observational?: boolean;
      semantic?: boolean;
      all?: boolean;
    }) => Promise<{ success?: boolean; cleared?: string[]; error?: string }>;
    testEmbedding: () => Promise<{ ok?: boolean; model?: string; dimensions?: number; error?: string }>;
  };
  mcp: {
    testConnection: (server: {
      name: string;
      url?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    }) => Promise<{ status: string; toolCount: number; error?: string }>;
  };
  cliTools: {
    checkBinaries: (binaryNames: string[]) => Promise<Record<string, boolean>>;
  };
  cli: {
    installStatus: () => Promise<CliInstallStatus>;
    install: () => Promise<CliInstallStatus>;
    uninstall: () => Promise<CliInstallStatus>;
  };
  skills: {
    list: () => Promise<
      Array<{
        name: string;
        description: string;
        version?: string;
        type: string;
        enabled: boolean;
        dir: string;
      }>
    >;
    get: (name: string) => Promise<{
      manifest?: Record<string, unknown>;
      files?: Record<string, string>;
      dir?: string;
      error?: string;
    }>;
    delete: (name: string) => Promise<{ success?: boolean; error?: string }>;
    toggle: (name: string, enable: boolean) => Promise<{ success?: boolean; enabled?: boolean }>;
  };
  diffs: {
    listForConversation: (conversationId: string) => Promise<FileDiff[]>;
    get: (conversationId: string, path: string) => Promise<FileDiff | null>;
    revert: (conversationId: string, path: string) => Promise<{ success: boolean; error?: string }>;
    revertAll: (conversationId: string) => Promise<{ success: boolean; reverted: number; skipped: string[] }>;
    revertHunk: (
      conversationId: string,
      path: string,
      hunkIndex: number,
    ) => Promise<{ success: boolean; error?: string }>;
    revertToOp: (
      conversationId: string,
      path: string,
      opIndex: number,
    ) => Promise<{ success: boolean; error?: string }>;
    clear: (conversationId: string) => Promise<{ success: boolean }>;
    onChange: (callback: (event: DiffEvent) => void) => () => void;
  };
  artifacts: {
    bundleReact: (source: string) => Promise<{ ok: true; code: string } | { ok: false; error: string }>;
    bundleMermaid: () => Promise<{ ok: true; code: string } | { ok: false; error: string }>;
  };
  automations: {
    catalog: () => Promise<AutomationSourceCatalogEntry[]>;
    log: () => Promise<AutomationRunRecord[]>;
    test: (ruleId: string, samplePayload: unknown) => Promise<AutomationRunRecord>;
    emit: (source: string, event: string, payload?: unknown) => Promise<void>;
    inFlight: (conversationId: string) => Promise<boolean>;
    abort: (conversationId: string) => Promise<boolean>;
    onRun: (callback: (record: AutomationRunRecord) => void) => () => void;
    onCatalogChanged: (callback: () => void) => () => void;
  };
  plugins: {
    getUIState: () => Promise<unknown>;
    list: () => Promise<
      Array<{
        name: string;
        displayName: string;
        version: string;
        description: string;
        state: string;
        brandRequired: boolean;
        error?: string;
      }>
    >;
    getConfig: (pluginName: string) => Promise<Record<string, unknown>>;
    setConfig: (pluginName: string, path: string, value: unknown) => Promise<{ success: boolean }>;
    modalAction: (pluginName: string, modalId: string, action: string, data?: unknown) => Promise<unknown>;
    bannerAction: (pluginName: string, bannerId: string, action: string, data?: unknown) => Promise<unknown>;
    action: (pluginName: string, targetId: string, action: string, data?: unknown) => Promise<unknown>;
    marketplaceCatalog: () => Promise<
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
    >;
    marketplaceInstall: (
      pluginName: string,
    ) => Promise<{ success: boolean; needsConfirmation?: boolean; pluginName?: string; reason?: string }>;
    marketplaceInstallUnverified: (pluginName: string) => Promise<{ success: boolean }>;
    marketplaceUninstall: (pluginName: string) => Promise<{ success: boolean }>;
    disable: (pluginName: string, opts?: { persist?: boolean }) => Promise<{ success: boolean }>;
    enable: (pluginName: string) => Promise<{ success: boolean }>;
    marketplaceRefresh: () => Promise<
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
    >;
    onUIStateChanged: (callback: (state: unknown) => void) => () => void;
    getAvailableUpdateCount: () => Promise<number>;
    onUpdatesAvailable: (callback: (data: { count: number }) => void) => () => void;
    getPendingRestart: () => Promise<string[]>;
    restartApp: () => Promise<{ success: boolean }>;
    onPendingRestartChanged: (callback: (data: { plugins: string[] }) => void) => () => void;
    getFailedUpdates: () => Promise<
      Array<{ name: string; attemptedVersion: string; runningVersion: string; error: string }>
    >;
    onFailedUpdatesChanged: (
      callback: (data: {
        failedUpdates: Array<{ name: string; attemptedVersion: string; runningVersion: string; error: string }>;
      }) => void,
    ) => () => void;
    onEvent: (callback: (event: unknown) => void) => () => void;
    onNavigationRequest: (callback: (request: unknown) => void) => () => void;
    onNavigateDirect: (callback: (data: unknown) => void) => () => void;
    onModalCallback: (callback: (data: unknown) => void) => () => void;
  };
  modelCatalog: () => Promise<unknown>;
  realtime: {
    startSession: (conversationId: string) => Promise<{ ok?: boolean; error?: string }>;
    endSession: () => Promise<{ ok?: boolean }>;
    sendAudio: (pcmBase64: string) => void;
    getStatus: () => Promise<{ status: string }>;
    onEvent: (callback: (event: unknown) => void) => () => void;
  };
  profileCatalog: () => Promise<{
    profiles: Array<{ key: string; name: string; primaryModelKey: string; fallbackModelKeys: string[] }>;
    defaultKey: string | null;
  }>;
  dialog: {
    openFile: (options?: { filters?: Array<{ name: string; extensions: string[] }> }) => Promise<unknown>;
    openDirectory: () => Promise<{ canceled: boolean; directoryPath?: string; name?: string }>;
    openDirectoryFiles: () => Promise<{ canceled: boolean; filePaths: string[] }>;
    openPath: () => Promise<{ canceled: true } | { canceled: false; path: string; isDirectory: boolean; name: string }>;
  };
  fileAccess: {
    previewPath: (entry: string) => Promise<{
      normalized: string;
      exists: boolean;
      isDirectory: boolean;
      matchCount: number;
      capped: boolean;
      allowed: boolean;
      denied: boolean;
      error?: string;
    }>;
  };
  clipboard: {
    writeText: (text: string) => Promise<{ ok: boolean; error?: string }>;
  };
  image: {
    fetch: (url: string) => Promise<{ data?: string; mime?: string; error?: string }>;
    save: (url: string, suggestedName?: string) => Promise<{ canceled?: boolean; filePath?: string; error?: string }>;
  };
  shell: {
    openPath: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
  };
  partitions: {
    list: () => Promise<Array<{ name: string; sizeBytes: number }>>;
    delete: (names: string[]) => Promise<{ success?: boolean; deleted?: string[]; error?: string }>;
  };
  plans: {
    readFile: (filename: string) => Promise<{ content?: string; error?: string }>;
  };
  tasks: {
    list: () => Promise<TaskFile[]>;
    listAll: () => Promise<TaskFile[]>;
    get: (id: string) => Promise<TaskFile | null>;
    create: (taskData: Omit<TaskFile, 'id' | 'createdAt' | 'updatedAt'>) => Promise<TaskFile>;
    update: (id: string, updates: Partial<TaskFile>) => Promise<TaskFile>;
    delete: (id: string) => Promise<{ ok: boolean }>;
    unarchive: (id: string) => Promise<TaskFile>;
    kickBack: (id: string, reason: string, source: 'ai' | 'human') => Promise<{ ok: boolean }>;
    getOrder: () => Promise<KaiTaskOrder | null>;
    saveOrder: (order: KaiTaskOrder) => Promise<{ ok: boolean }>;
    onChanged: (callback: (tasks: TaskFile[]) => void) => () => void;
    terminalCreate: (
      taskId: string,
      options: { runtime: string; cwd?: string; cols?: number; rows?: number },
    ) => Promise<{ sessionId?: string; error?: string }>;
    terminalWrite: (sessionId: string, data: string) => Promise<void>;
    terminalResize: (sessionId: string, cols: number, rows: number) => Promise<void>;
    terminalKill: (sessionId: string) => Promise<{ ok: boolean }>;
    terminalGetBuffer: (sessionId: string) => Promise<string[]>;
    onTerminalData: (callback: (event: { sessionId: string; data: string }) => void) => () => void;
    onTerminalExit: (callback: (event: { sessionId: string; exitCode: number }) => void) => () => void;
    // AI plan generation
    streamPlan: (
      taskId: string,
      userMessage: string,
      history?: TaskConversationMessage[],
    ) => Promise<{ taskId: string }>;
    cancelPlanStream: (taskId: string) => Promise<{ ok: boolean }>;
    generateTitle: (userMessage: string) => Promise<{ title: string | null }>;
    onStreamEvent: (callback: (event: TaskStreamEvent) => void) => () => void;
  };
  agents: {
    list: () => Promise<AgentFile[]>;
    get: (id: string) => Promise<AgentFile | null>;
    create: (payload: CreateAgentPayload) => Promise<AgentFile>;
    update: (id: string, updates: Partial<AgentFile>) => Promise<AgentFile>;
    delete: (id: string) => Promise<{ ok: boolean }>;
    assignTask: (agentId: string, taskId: string) => Promise<{ ok: boolean; error?: string }>;
    unassignTask: (agentId: string) => Promise<{ ok: boolean; error?: string }>;
    start: (agentId: string) => Promise<{ sessionId?: string; error?: string }>;
    stop: (agentId: string) => Promise<{ ok?: boolean; error?: string }>;
    synthesizePrompt: (
      agentId: string,
      userDescription: string,
    ) => Promise<{ ok?: boolean; matchedRole?: string | null; error?: string }>;
    onChanged: (callback: (agents: AgentFile[]) => void) => () => void;
  };
  platform: {
    os: 'darwin' | 'win32' | 'linux';
    homedir: () => Promise<string>;
    getCapabilities: () => Promise<{ kind: string; capabilities: AdapterCapabilities }>;
    getPermissions: () => Promise<PlatformPermissions>;
    getFeatureCapabilities: () => Promise<PlatformCapabilities>;
    setDockBadge: (value: { count: number; hasText: boolean; style: 'dot' | 'truncate' | 'full' }) => Promise<void>;
  };
  appShots: {
    capture: () => Promise<AppShotPayload>;
    suspendHotkey: () => Promise<unknown>;
    resumeHotkey: () => Promise<unknown>;
    resolveRef: (refId: string) => Promise<AppShotPayload | null>;
    onCaptured: (callback: (payload: AppShotPayload) => void) => () => void;
  };
  appshots: {
    list: () => Promise<Appshot[]>;
    get: (id: string) => Promise<Appshot | null>;
    getImage: (id: string) => Promise<string | null>;
    delete: (id: string) => Promise<{ ok: boolean; error?: string }>;
    deleteAll: () => Promise<{ ok: boolean }>;
    update: (
      id: string,
      patch: { tags?: string[]; pinned?: boolean },
    ) => Promise<{ ok: boolean; error?: string; appshot?: Appshot }>;
    onChanged: (callback: () => void) => () => void;
  };
  computerUse: {
    startSession: (goal: string, options: unknown) => Promise<unknown>;
    pauseSession: (sessionId: string) => Promise<unknown>;
    resumeSession: (sessionId: string) => Promise<unknown>;
    stopSession: (sessionId: string) => Promise<unknown>;
    approveAction: (sessionId: string, actionId: string) => Promise<unknown>;
    rejectAction: (sessionId: string, actionId: string, reason?: string) => Promise<unknown>;
    listSessions: () => Promise<unknown[]>;
    getSession: (sessionId: string) => Promise<unknown>;
    setSurface: (sessionId: string, surface: ComputerUseSurface) => Promise<unknown>;
    sendGuidance: (sessionId: string, text: string) => Promise<unknown>;
    updateSessionSettings: (
      sessionId: string,
      settings: {
        modelKey?: string | null;
        profileKey?: string | null;
        fallbackEnabled?: boolean;
        reasoningEffort?: string;
      },
    ) => Promise<unknown>;
    continueSession: (sessionId: string, newGoal: string) => Promise<unknown>;
    markSessionsSeen: (conversationId: string) => Promise<unknown>;
    openSetupWindow: (conversationId?: string | null) => Promise<unknown>;
    getLocalMacosPermissions: () => Promise<ComputerUsePermissions>;
    requestLocalMacosPermissions: () => Promise<ComputerUsePermissionRequestResult>;
    requestSingleLocalMacosPermission: (section: ComputerUsePermissionSection) => Promise<ComputerUsePermissions>;
    openLocalMacosPrivacySettings: (
      section?: ComputerUsePermissionSection,
    ) => Promise<{ opened: ComputerUsePermissionSection | null }>;
    probeInputMonitoring: (timeoutMs?: number) => Promise<{ inputMonitoringGranted: boolean }>;
    checkFullScreenApps: () => Promise<{ apps: string[]; problematicApps: string[] }>;
    exitFullScreenApps: (appNames: string[]) => Promise<{ exited: string[]; failed: string[] }>;
    listRunningApps: () => Promise<{ apps: string[] }>;
    listDisplays: () => Promise<{
      displays: Array<{ name: string; displayId: string; pixelWidth: number; pixelHeight: number; isPrimary: boolean }>;
    }>;
    focusSession: (sessionId: string) => Promise<unknown>;
    overlayMouseEnter: () => void;
    overlayMouseLeave: () => void;
    onEvent: (callback: (event: ComputerUseEvent) => void) => () => void;
    onOverlayState: (callback: (state: unknown) => void) => () => void;
    onFocusThread: (callback: () => void) => () => void;
  };
  mic: {
    listDevices: () => Promise<Array<{ deviceId: string; label: string }>>;
    startRecording: (deviceId?: string) => Promise<{ ok?: boolean; silent?: boolean; error?: string }>;
    stopRecording: () => Promise<{
      wavBase64?: string;
      durationSec?: number;
      maxAmplitude?: number;
      error?: string;
    }>;
    cancelRecording: () => Promise<{ ok?: boolean }>;
    startMonitor: (deviceIds?: string[]) => Promise<Record<string, { ok?: boolean; error?: string }>>;
    getLevel: () => Promise<Record<string, number>>;
    stopMonitor: () => Promise<{ ok?: boolean }>;
    liveStart: (config: {
      subscriptionKey: string;
      region?: string;
      endpoint?: string;
      language: string;
      deviceId?: string;
    }) => Promise<{ ok?: boolean; error?: string }>;
    liveMicStart: (deviceId?: string) => Promise<{ ok?: boolean; error?: string }>;
    liveMicDrain: () => Promise<string[]>;
    liveMicStop: () => Promise<{ ok?: boolean }>;
    liveAudio: (pcmBase64: string) => void;
    liveStop: () => Promise<{ ok?: boolean }>;
    onPartial: (callback: (text: string) => void) => () => void;
    onFinal: (callback: (text: string) => void) => () => void;
    onSttError: (callback: (error: string) => void) => () => void;
  };
  usage: {
    summary: () => Promise<unknown>;
    byConversation: (params?: Record<string, unknown>) => Promise<unknown>;
    byModel: () => Promise<unknown>;
    timeSeries: (params?: Record<string, unknown>) => Promise<unknown>;
    nonLlmEvents: (params?: Record<string, string>) => Promise<unknown>;
    recordEvent: (event: unknown) => Promise<unknown>;
    exportCsv: () => Promise<unknown>;
  };
  autoUpdate: {
    check: () => Promise<{ ok?: boolean; error?: string }>;
    install: () => Promise<void>;
    onStatus: (
      callback: (status: {
        state: string;
        version?: string;
        percent?: number;
        transferred?: number;
        total?: number;
        bytesPerSecond?: number;
        mode?: 'full' | 'differential';
        fullSize?: number;
      }) => void,
    ) => () => void;
  };
  onMenuOpenSettings: (callback: () => void) => () => void;
  onFind: (callback: () => void) => () => void;
  onModelSwitched: (callback: (modelKey: string) => void) => () => void;
  onExecutionModeChanged: (callback: (mode: string) => void) => () => void;
  dictation: {
    toggle: () => Promise<DictationRuntimeState>;
    stop: () => Promise<DictationRuntimeState>;
    getState: () => Promise<DictationRuntimeState>;
    getTypingMode: () => Promise<string>;
    setDevice: (deviceId: string) => Promise<{ ok: boolean }>;
    suspendHotkey: () => Promise<{ ok: boolean }>;
    resumeHotkey: () => Promise<{ ok: boolean }>;
    setOverlayInteractive: (interactive: boolean) => void;
    resizeOverlay: (height: number) => void;
    restoreOverlayFocus: () => void;
    onStateChange: (callback: (state: DictationRuntimeState) => void) => () => void;
    onLevel: (callback: (level: number) => void) => () => void;
    onPartial: (callback: (text: string) => void) => () => void;
    onFinal: (callback: (text: string) => void) => () => void;
    onError: (callback: (message: string) => void) => () => void;
    onTypingMode: (callback: (mode: string) => void) => () => void;
  };
  titlebar: {
    doubleClick: () => Promise<void>;
  };
};

type DictationRuntimeState = {
  state: string;
  elapsed: number;
  hotkeyRegistered?: boolean;
  hotkeyError?: string | null;
};

declare global {
  interface Window {
    app?: AppAPI;
  }
}

function getApp(): AppAPI {
  if (!window.app) {
    throw new Error(__BRAND_PRODUCT_NAME + ' IPC bridge not available. Ensure the app is running in Electron.');
  }
  return window.app;
}

export const app: AppAPI = new Proxy({} as AppAPI, {
  get(_target, prop: string) {
    const api = getApp();
    return (api as Record<string, unknown>)[prop];
  },
});

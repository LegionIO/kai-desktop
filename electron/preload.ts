import { contextBridge, ipcRenderer } from 'electron';
import type {
  ComputerUseEvent,
  ComputerUsePermissionSection,
  ComputerUseSurface,
} from '../shared/computer-use.js';

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
      threadOverrides?: { temperature?: number | null; systemPromptOverride?: string | null; maxSteps?: number | null; maxRetries?: number | null; runtimeOverride?: string | null },
    ) => ipcRenderer.invoke('agent:stream', conversationId, messages, modelKey, reasoningEffort, profileKey, fallbackEnabled, cwd, executionMode, threadOverrides),
    cancelStream: (conversationId: string) => ipcRenderer.invoke('agent:cancel-stream', conversationId),
    approveToolCall: (toolCallId: string) => ipcRenderer.invoke('agent:approve-tool', toolCallId),
    rejectToolCall: (toolCallId: string) => ipcRenderer.invoke('agent:reject-tool', toolCallId),
    dismissToolCall: (toolCallId: string) => ipcRenderer.invoke('agent:dismiss-tool', toolCallId),
    answerToolQuestion: (toolCallId: string, answers: Record<string, string>) => ipcRenderer.invoke('agent:answer-tool-question', toolCallId, answers),
    generateTitle: (messages: unknown[], modelKey?: string, hint?: string) => ipcRenderer.invoke('agent:generate-title', messages, modelKey, hint),
    onStreamEvent: (callback: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('agent:stream-event', handler);
      return () => ipcRenderer.removeListener('agent:stream-event', handler);
    },
    sendSubAgentMessage: (subAgentConversationId: string, message: string) =>
      ipcRenderer.invoke('agent:sub-agent-message', subAgentConversationId, message),
    stopSubAgent: (subAgentConversationId: string) =>
      ipcRenderer.invoke('agent:sub-agent-stop', subAgentConversationId),
    listSubAgents: () =>
      ipcRenderer.invoke('agent:sub-agent-list'),
    getAvailableRuntimes: () =>
      ipcRenderer.invoke('agent:get-available-runtimes'),
    getActiveRuntime: () =>
      ipcRenderer.invoke('agent:get-active-runtime'),
  },

  conversations: {
    list: () => ipcRenderer.invoke('conversations:list'),
    get: (id: string) => ipcRenderer.invoke('conversations:get', id),
    put: (conversation: unknown) => ipcRenderer.invoke('conversations:put', conversation),
    delete: (id: string) => ipcRenderer.invoke('conversations:delete', id),
    clear: () => ipcRenderer.invoke('conversations:clear'),
    getActiveId: () => ipcRenderer.invoke('conversations:get-active-id'),
    setActiveId: (id: string) => ipcRenderer.invoke('conversations:set-active-id', id),
    onChanged: (callback: (store: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, store: unknown) => callback(store);
      ipcRenderer.on('conversations:changed', handler);
      return () => ipcRenderer.removeListener('conversations:changed', handler);
    },
  },

  workspaces: {
    create: (args: { name: string; directory: string }) =>
      ipcRenderer.invoke('workspaces:create', args),
    rename: (args: { id: string; name: string }) =>
      ipcRenderer.invoke('workspaces:rename', args),
    delete: (args: { id: string }) =>
      ipcRenderer.invoke('workspaces:delete', args),
    setActive: (args: { id: string | null }) =>
      ipcRenderer.invoke('workspaces:set-active', args),
    saveLastConversation: (args: { workspaceId: string; conversationId: string | null }) =>
      ipcRenderer.invoke('workspaces:save-last-conversation', args),
    browseDirectory: () =>
      ipcRenderer.invoke('workspaces:browse-directory') as Promise<{ path: string; name: string } | null>,
  },

  memory: {
    clear: (options: { working?: boolean; observational?: boolean; semantic?: boolean; all?: boolean }) =>
      ipcRenderer.invoke('memory:clear', options) as Promise<{ success?: boolean; cleared?: string[]; error?: string }>,
    testEmbedding: () =>
      ipcRenderer.invoke('memory:test-embedding') as Promise<{ ok?: boolean; model?: string; dimensions?: number; error?: string }>,
  },

  mcp: {
    testConnection: (server: { name: string; url?: string; command?: string; args?: string[]; env?: Record<string, string> }) =>
      ipcRenderer.invoke('mcp:test-connection', server) as Promise<{ status: string; toolCount: number; error?: string }>,
  },

  cliTools: {
    checkBinaries: (binaryNames: string[]) =>
      ipcRenderer.invoke('cli-tools:check-binaries', binaryNames) as Promise<Record<string, boolean>>,
  },

  skills: {
    list: () => ipcRenderer.invoke('skills:list') as Promise<Array<{
      name: string;
      description: string;
      version?: string;
      type: string;
      enabled: boolean;
      dir: string;
    }>>,
    get: (name: string) => ipcRenderer.invoke('skills:get', name) as Promise<{
      manifest?: Record<string, unknown>;
      files?: Record<string, string>;
      dir?: string;
      error?: string;
    }>,
    delete: (name: string) => ipcRenderer.invoke('skills:delete', name) as Promise<{ success?: boolean; error?: string }>,
    toggle: (name: string, enable: boolean) => ipcRenderer.invoke('skills:toggle', name, enable) as Promise<{ success?: boolean; enabled?: boolean }>,
  },

  plugins: {
    getUIState: () => ipcRenderer.invoke('plugin:get-ui-state'),
    list: () => ipcRenderer.invoke('plugin:list') as Promise<Array<{
      name: string;
      displayName: string;
      version: string;
      description: string;
      state: string;
      brandRequired: boolean;
      icon?: { lucide: string } | { svg: string };
      error?: string;
    }>>,
    getConfig: (pluginName: string) => ipcRenderer.invoke('plugin:get-config', pluginName) as Promise<Record<string, unknown>>,
    setConfig: (pluginName: string, path: string, value: unknown) =>
      ipcRenderer.invoke('plugin:set-config', pluginName, path, value) as Promise<{ success: boolean }>,
    modalAction: (pluginName: string, modalId: string, action: string, data?: unknown) =>
      ipcRenderer.invoke('plugin:modal-action', pluginName, modalId, action, data),
    bannerAction: (pluginName: string, bannerId: string, action: string, data?: unknown) =>
      ipcRenderer.invoke('plugin:banner-action', pluginName, bannerId, action, data),
    action: (pluginName: string, targetId: string, action: string, data?: unknown) =>
      ipcRenderer.invoke('plugin:action', pluginName, targetId, action, data),
    marketplaceCatalog: () => ipcRenderer.invoke('plugin:marketplace-catalog') as Promise<Array<{
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
    }>>,
    marketplaceInstall: (pluginName: string) =>
      ipcRenderer.invoke('plugin:marketplace-install', pluginName) as Promise<{ success: boolean }>,
    marketplaceUninstall: (pluginName: string) =>
      ipcRenderer.invoke('plugin:marketplace-uninstall', pluginName) as Promise<{ success: boolean }>,
    marketplaceRefresh: () =>
      ipcRenderer.invoke('plugin:marketplace-refresh') as Promise<Array<{
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
      }>>,
    onUIStateChanged: (callback: (state: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
      ipcRenderer.on('plugin:ui-state-changed', handler);
      return () => ipcRenderer.removeListener('plugin:ui-state-changed', handler);
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
      ipcRenderer.invoke('plugin:pending-consent') as Promise<Array<{ pluginName: string; manifest: unknown; fileHash: string }>>,
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
    endSession: () =>
      ipcRenderer.invoke('realtime:end-session') as Promise<{ ok?: boolean }>,
    sendAudio: (pcmBase64: string) =>
      ipcRenderer.send('realtime:send-audio', pcmBase64),
    getStatus: () =>
      ipcRenderer.invoke('realtime:get-status') as Promise<{ status: string }>,
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
  },

  clipboard: {
    writeText: (text: string) =>
      ipcRenderer.invoke('clipboard:write-text', text) as Promise<{ ok: boolean; error?: string }>,
  },

  image: {
    fetch: (url: string) => ipcRenderer.invoke('image:fetch', url) as Promise<{ data?: string; mime?: string; error?: string }>,
    save: (url: string, suggestedName?: string) => ipcRenderer.invoke('image:save', url, suggestedName) as Promise<{ canceled?: boolean; filePath?: string; error?: string }>,
  },

  shell: {
    openPath: (filePath: string) => ipcRenderer.invoke('shell:open-path', filePath) as Promise<{ ok: boolean; error?: string }>,
  },

  platform: {
    homedir: () => ipcRenderer.invoke('platform:homedir'),
  },

  webServer: {
    getLanAddresses: () => ipcRenderer.invoke('webServer:lan-addresses') as Promise<string[]>,
    createToken: () => ipcRenderer.invoke('webServer:create-token') as Promise<string | null>,
  },

  fs: {
    listDirectory: (dirPath: string) => ipcRenderer.invoke('fs:list-directory', dirPath) as Promise<{ path?: string; entries: Array<{ name: string; isDirectory: boolean }>; error?: string }>,
  },

  plans: {
    readFile: (filename: string) => ipcRenderer.invoke('plans:read-file', filename) as Promise<{ content?: string; error?: string }>,
  },

  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    listAll: () => ipcRenderer.invoke('tasks:list-all'),
    get: (id: string) => ipcRenderer.invoke('tasks:get', id),
    create: (taskData: unknown) => ipcRenderer.invoke('tasks:create', taskData),
    update: (id: string, updates: unknown) => ipcRenderer.invoke('tasks:update', id, updates),
    delete: (id: string) => ipcRenderer.invoke('tasks:delete', id),
    unarchive: (id: string) => ipcRenderer.invoke('tasks:unarchive', id),
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
    terminalWrite: (sessionId: string, data: string) =>
      ipcRenderer.invoke('tasks:terminal-write', sessionId, data),
    terminalResize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('tasks:terminal-resize', sessionId, cols, rows),
    terminalKill: (sessionId: string) =>
      ipcRenderer.invoke('tasks:terminal-kill', sessionId) as Promise<{ ok: boolean }>,
    onTerminalData: (callback: (event: { sessionId: string; data: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; data: string }) => callback(data);
      ipcRenderer.on('tasks:terminal-data', handler);
      return () => ipcRenderer.removeListener('tasks:terminal-data', handler);
    },
    onTerminalExit: (callback: (event: { sessionId: string; exitCode: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; exitCode: number }) => callback(data);
      ipcRenderer.on('tasks:terminal-exit', handler);
      return () => ipcRenderer.removeListener('tasks:terminal-exit', handler);
    },
    // AI plan generation
    streamPlan: (taskId: string, userMessage: string, history?: unknown[]) =>
      ipcRenderer.invoke('tasks:stream-plan', taskId, userMessage, history) as Promise<{ taskId: string }>,
    cancelPlanStream: (taskId: string) =>
      ipcRenderer.invoke('tasks:cancel-stream', taskId) as Promise<{ ok: boolean }>,
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
    start: (agentId: string) => ipcRenderer.invoke('agents:start', agentId) as Promise<{ sessionId?: string; error?: string }>,
    stop: (agentId: string) => ipcRenderer.invoke('agents:stop', agentId),
    synthesizePrompt: (agentId: string, userDescription: string) => ipcRenderer.invoke('agents:synthesize-prompt', agentId, userDescription),
    onChanged: (callback: (agents: unknown[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, agents: unknown[]) => callback(agents);
      ipcRenderer.on('agents:changed', handler);
      return () => ipcRenderer.removeListener('agents:changed', handler);
    },
  },

  computerUse: {
    startSession: (goal: string, options: unknown) => ipcRenderer.invoke('computer-use:start-session', goal, options),
    pauseSession: (sessionId: string) => ipcRenderer.invoke('computer-use:pause-session', sessionId),
    resumeSession: (sessionId: string) => ipcRenderer.invoke('computer-use:resume-session', sessionId),
    stopSession: (sessionId: string) => ipcRenderer.invoke('computer-use:stop-session', sessionId),
    approveAction: (sessionId: string, actionId: string) => ipcRenderer.invoke('computer-use:approve-action', sessionId, actionId),
    rejectAction: (sessionId: string, actionId: string, reason?: string) => ipcRenderer.invoke('computer-use:reject-action', sessionId, actionId, reason),
    listSessions: () => ipcRenderer.invoke('computer-use:list-sessions'),
    getSession: (sessionId: string) => ipcRenderer.invoke('computer-use:get-session', sessionId),
    setSurface: (sessionId: string, surface: ComputerUseSurface) => ipcRenderer.invoke('computer-use:set-surface', sessionId, surface),
    sendGuidance: (sessionId: string, text: string) => ipcRenderer.invoke('computer-use:send-guidance', sessionId, text),
    updateSessionSettings: (sessionId: string, settings: { modelKey?: string | null; profileKey?: string | null; fallbackEnabled?: boolean; reasoningEffort?: string }) => ipcRenderer.invoke('computer-use:update-session-settings', sessionId, settings),
    continueSession: (sessionId: string, newGoal: string) => ipcRenderer.invoke('computer-use:continue-session', sessionId, newGoal),
    markSessionsSeen: (conversationId: string) => ipcRenderer.invoke('computer-use:mark-sessions-seen', conversationId),
    openSetupWindow: (conversationId?: string | null) => ipcRenderer.invoke('computer-use:open-setup-window', conversationId),
    getLocalMacosPermissions: () => ipcRenderer.invoke('computer-use:get-local-macos-permissions'),
    requestLocalMacosPermissions: () => ipcRenderer.invoke('computer-use:request-local-macos-permissions'),
    requestSingleLocalMacosPermission: (section: ComputerUsePermissionSection) => ipcRenderer.invoke('computer-use:request-single-local-macos-permission', section),
    openLocalMacosPrivacySettings: (section?: ComputerUsePermissionSection) => ipcRenderer.invoke('computer-use:open-local-macos-privacy-settings', section),
    probeInputMonitoring: (timeoutMs?: number) => ipcRenderer.invoke('computer-use:probe-input-monitoring', timeoutMs) as Promise<{ inputMonitoringGranted: boolean }>,
    checkFullScreenApps: () => ipcRenderer.invoke('computer-use:check-fullscreen-apps') as Promise<{ apps: string[]; problematicApps: string[] }>,
    exitFullScreenApps: (appNames: string[]) => ipcRenderer.invoke('computer-use:exit-fullscreen-apps', appNames) as Promise<{ exited: string[]; failed: string[] }>,
    listRunningApps: () => ipcRenderer.invoke('computer-use:list-running-apps') as Promise<{ apps: string[] }>,
    listDisplays: () => ipcRenderer.invoke('computer-use:list-displays') as Promise<{ displays: Array<{ name: string; displayId: string; pixelWidth: number; pixelHeight: number; isPrimary: boolean }> }>,
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
    startRecording: (deviceId?: string) => ipcRenderer.invoke('stt:start-recording', deviceId) as Promise<{ ok?: boolean; silent?: boolean; error?: string }>,
    stopRecording: () => ipcRenderer.invoke('stt:stop-recording') as Promise<{
      wavBase64?: string;
      durationSec?: number;
      maxAmplitude?: number;
      error?: string;
    }>,
    cancelRecording: () => ipcRenderer.invoke('stt:cancel-recording') as Promise<{ ok?: boolean }>,
    startMonitor: (deviceIds?: string[]) => ipcRenderer.invoke('stt:start-monitor', deviceIds) as Promise<Record<string, { ok?: boolean; error?: string }>>,
    getLevel: () => ipcRenderer.invoke('stt:get-level') as Promise<Record<string, number>>,
    stopMonitor: () => ipcRenderer.invoke('stt:stop-monitor') as Promise<{ ok?: boolean }>,
    liveStart: (config: { subscriptionKey: string; region?: string; endpoint?: string; language: string; deviceId?: string }) =>
      ipcRenderer.invoke('stt:live-start', config) as Promise<{ ok?: boolean; error?: string }>,
    liveMicStart: (deviceId?: string) => ipcRenderer.invoke('stt:live-mic-start', deviceId) as Promise<{ ok?: boolean; error?: string }>,
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
    batchTranscribe: (options: {
      wavBase64?: string;
      tempFilePath?: string;
      language: string;
    }) => ipcRenderer.invoke('stt:batch-transcribe', options) as Promise<{
      text: string;
      durationSec?: number;
      error?: string;
    }>,
    onTranscriptionProgress: (callback: (progress: { percent: number; chunkIndex: number; totalChunks: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: { percent: number; chunkIndex: number; totalChunks: number }) => callback(progress);
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
    delete: (names: string[]) => ipcRenderer.invoke('partitions:delete', names) as Promise<{ success?: boolean; deleted?: string[]; error?: string }>,
  },

  debug: {
    log: (file: string, message: string) => ipcRenderer.send('debug:log', file, message),
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
    onStateChange: (callback: (state: { state: string; elapsed: number; hotkeyRegistered?: boolean; hotkeyError?: string | null }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: { state: string; elapsed: number; hotkeyRegistered?: boolean; hotkeyError?: string | null }) => callback(state);
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
};

contextBridge.exposeInMainWorld('app', appAPI);

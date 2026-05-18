import type { ToolDefinition } from '../tools/types.js';
import type { AppConfig } from '../config/schema.js';
import type { CompatCheckResult } from './plugin-compat.js';
import type { PluginSafeConfig } from './safe-config.js';

export type { PluginSafeConfig } from './safe-config.js';

/* ── Manifest ── */

export type PluginPermission =
  | 'config:read'
  | 'config:read-secrets'
  | 'config:write'
  | 'tools:register'
  | 'ui:banner'
  | 'ui:modal'
  | 'ui:settings'
  | 'ui:panel'
  | 'ui:navigation'
  | 'messages:hook'
  | 'network:fetch'
  | 'auth:window'
  | 'http:listen'
  | 'notifications:send'
  | 'conversations:read'
  | 'conversations:write'
  | 'navigation:open'
  | 'state:publish'
  | 'agent:generate'
  | 'agent:inference-provider'
  | 'agent:register-runtime'
  | 'agent:register-cli-tool'
  | 'safe-storage'
  | 'browser:window'
  | 'exec:whitelisted'
  | 'tools:detect'
  | 'system:env'
  | 'audit:log'
  | 'lifecycle:hook';

export type PluginApprovalRecord = {
  hash: string;
  permissions?: string[];
  approvedAt: string;
};

/* ── Scoped Filesystem & Execution Declarations ── */

export type ScopedDirectory =
  | 'claude-home'   // ~/.claude/
  | 'codex-home';   // ~/.codex/

export type AllowedBinary =
  | 'claude'       // Claude Code CLI
  | 'codex'        // Codex CLI
  | 'node'         // Node.js
  | 'npm'          // npm
  | 'pip'          // Python package manager
  | 'pip3'         // Python 3 package manager
  | 'python'       // Python interpreter
  | 'python3'      // Python 3 interpreter
  | 'git'          // Git CLI
  | 'bash';        // Bash (only for whitelisted scripts)

export type ExecScopeDeclaration = {
  binaries: AllowedBinary[];
  argPatterns?: Record<string, string[]>;
};

export type ExecRequest = {
  binary: AllowedBinary;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;       // default 60_000, max 300_000
  stdin?: string;
};

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string;
  durationMs: number;
  truncated: boolean;
};

export type ToolDetectionResult = {
  name: string;
  installed: boolean;
  path?: string;
  version?: string;
  error?: string;
};

export type AuditEntry = {
  timestamp: string;
  pluginName: string;
  action: 'exec:run' | 'tools:detect';
  target: string;
  args?: string[];
  exitCode?: number;
  durationMs?: number;
  approved: boolean;
  userConsentId?: string;
};

export type PluginManifest = {
  name: string;
  displayName: string;
  version: string;
  description: string;
  author?: string;
  icon?: { lucide: string } | { svg: string };
  permissions: PluginPermission[];
  configSchema?: Record<string, unknown>;
  execScope?: ExecScopeDeclaration;
  /** npm-style semver range constraint on the host plugin API version. */
  engines?: { kai?: string };
  /** Host capabilities this plugin requires to function correctly. */
  capabilities?: string[];
};

/* ── Plugin State ── */

export type PluginState = 'loading' | 'active' | 'error' | 'disabled';

export type PluginInstance = {
  manifest: PluginManifest;
  dir: string;
  fileHash: string;
  state: PluginState;
  error?: string;
  compatWarning?: CompatCheckResult;
  module: PluginModule | null;
  registeredTools: ToolDefinition[];
  preSendHooks: PreSendHook[];
  postReceiveHooks: PostReceiveHook[];
  preUpdateHooks: PreUpdateHook[];
  postUpdateHooks: PostUpdateHook[];
  uiBanners: PluginBannerDescriptor[];
  uiModals: PluginModalDescriptor[];
  uiSettingsSections: PluginSettingsSectionDescriptor[];
  uiPanels: PluginPanelDescriptor[];
  uiNavigationItems: PluginNavigationItemDescriptor[];
  uiCommands: PluginCommandDescriptor[];
  conversationDecorations: PluginConversationDecorationDescriptor[];
  threadDecorations: PluginThreadDecorationDescriptor[];
  publishedState: Record<string, unknown>;
  notifications: PluginNotificationDescriptor[];
  configChangeListeners: Array<(config: AppConfig | PluginSafeConfig) => void>;
  rendererBuild: PluginRendererBuild | null;
  inferenceProvider: PluginInferenceProvider | null;
  contributedRuntimes: PluginRuntimeContribution[];
  contributedCliTools: PluginCliToolContribution[];
};

/* ── Plugin Module (what dist/backend.js must export) ── */

export type PluginModule = {
  activate: (api: PluginAPI) => Promise<void> | void;
  deactivate?: () => Promise<void> | void;
  /**
   * Called when the app config changes. The argument is a redacted
   * {@link PluginSafeConfig} unless the plugin declares the
   * `'config:read-secrets'` permission, in which case the full
   * {@link AppConfig} (including credentials) is passed instead.
   *
   * Plugins MUST narrow the union at runtime (e.g. check a known
   * `hasApiKey`/`apiKey` discriminator) rather than relying on the
   * declared permission alone, because future host-side fallbacks may
   * downgrade to the safe view for any reason.
   */
  onConfigChanged?: (config: AppConfig | PluginSafeConfig) => void;
};

/* ── Message Hooks ── */

export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-result'; toolCallId: string; result: unknown; isError?: boolean }
  | { type: 'image'; image: string; mimeType?: string }
  | Record<string, unknown>;

export type HookMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | MessageContent[];
};

export type PreSendHookArgs = {
  messages: HookMessage[];
  modelKey: string;
  /**
   * Redacted view of the app config. Credential-bearing fields (provider
   * API keys, AWS secrets, MCP server env vars, web server password, TLS
   * private key paths, Azure subscription keys) are stripped or replaced
   * with `hasX: boolean` indicators. See {@link PluginSafeConfig}.
   */
  config: PluginSafeConfig;
  systemPrompt?: string;
};

export type PreSendHookResult = {
  messages: HookMessage[];
  systemPrompt?: string;
  abort?: boolean;
  abortReason?: string;
};

export type PreSendHook = (args: PreSendHookArgs) => Promise<PreSendHookResult> | PreSendHookResult;

export type PostReceiveHookArgs = {
  response: HookMessage;
  messages: HookMessage[];
  /**
   * Redacted view of the app config. See {@link PluginSafeConfig} and the
   * note on {@link PreSendHookArgs.config}.
   */
  config: PluginSafeConfig;
};

export type PostReceiveHookResult = {
  response: HookMessage;
};

export type PostReceiveHook = (args: PostReceiveHookArgs) => Promise<PostReceiveHookResult> | PostReceiveHookResult;

/* ── Lifecycle Hooks ── */

export type PreUpdateHookArgs = {
  version: string;
  artifactPath: string;
};

export type PreUpdateHookResult = {
  abort?: boolean;
  abortReason?: string;
};

export type PreUpdateHook = (args: PreUpdateHookArgs) => Promise<PreUpdateHookResult> | PreUpdateHookResult;

export type PostUpdateHookArgs = {
  version: string;
  success: boolean;
};

export type PostUpdateHook = (args: PostUpdateHookArgs) => Promise<void> | void;

/* ── UI Descriptors (JSON-serializable across IPC) ── */

export type PluginBannerDescriptor = {
  id: string;
  pluginName: string;
  component?: string;
  text?: string;
  variant?: 'info' | 'warning' | 'error';
  dismissible?: boolean;
  visible: boolean;
  props?: Record<string, unknown>;
};

export type PluginModalDescriptor = {
  id: string;
  pluginName: string;
  component: string;
  title?: string;
  closeable: boolean;
  visible: boolean;
  props?: Record<string, unknown>;
};

export type PluginSettingsSectionDescriptor = {
  id: string;
  pluginName: string;
  label: string;
  component: 'SettingsView';
  priority?: number;
};

export type PluginPanelDescriptor = {
  id: string;
  pluginName: string;
  component: 'PanelView';
  title: string;
  visible: boolean;
  width?: 'default' | 'wide' | 'full';
  props?: Record<string, unknown>;
};

export type PluginNavigationTarget =
  | { type: 'panel'; panelId: string }
  | { type: 'conversation'; conversationId: string }
  | { type: 'action'; targetId: string; action: string; data?: unknown };

export type PluginNavigationItemDescriptor = {
  id: string;
  pluginName: string;
  label: string;
  icon?: { lucide: string } | { svg: string };
  visible: boolean;
  priority?: number;
  badge?: string | number;
  target: PluginNavigationTarget;
};

export type PluginCommandDescriptor = {
  id: string;
  pluginName: string;
  label: string;
  shortcut?: string;
  visible: boolean;
  priority?: number;
  target: PluginNavigationTarget;
};

export type PluginConversationDecorationDescriptor = {
  id: string;
  pluginName: string;
  conversationId: string;
  label: string;
  variant?: 'info' | 'warning' | 'error' | 'success';
  visible: boolean;
};

export type PluginThreadDecorationDescriptor = {
  id: string;
  pluginName: string;
  conversationId?: string;
  label: string;
  variant?: 'info' | 'warning' | 'error' | 'success';
  visible: boolean;
};

export type PluginRendererScript = {
  pluginName: string;
  scriptPath: string;
  scriptHash: string;
  entryUrl: string;
};

export type PluginRendererStyle = {
  pluginName: string;
  stylePath: string;
  styleHash: string;
  styleUrl?: string;
  styleContent?: string;
};

export type PluginRendererBuild = {
  pluginName: string;
  pluginDir: string;
  fileHash: string;
  outDir: string;
  entryPath: string;
  entryUrl: string;
  scripts: PluginRendererScript[];
  styles: PluginRendererStyle[];
  mimeTypes: Record<string, string>;
};

export type PluginNotificationDescriptor = {
  id: string;
  pluginName: string;
  title: string;
  body?: string;
  level?: 'info' | 'success' | 'warning' | 'error';
  visible: boolean;
  native?: boolean;
  autoDismissMs?: number;
  target?: PluginNavigationTarget;
};

export type PluginPublishedState = Record<string, Record<string, unknown>>;

export type PluginUIState = {
  banners: PluginBannerDescriptor[];
  modals: PluginModalDescriptor[];
  settingsSections: PluginSettingsSectionDescriptor[];
  panels: PluginPanelDescriptor[];
  navigationItems: PluginNavigationItemDescriptor[];
  commands: PluginCommandDescriptor[];
  conversationDecorations: PluginConversationDecorationDescriptor[];
  threadDecorations: PluginThreadDecorationDescriptor[];
  rendererScripts: PluginRendererScript[];
  rendererStyles: PluginRendererStyle[];
  pluginConfigs: Record<string, Record<string, unknown>>;
  pluginStates: PluginPublishedState;
  pluginStatuses: Record<string, PluginState>;
  pluginErrors: Record<string, string | undefined>;
  notifications: PluginNotificationDescriptor[];
  requiredPluginsReady: boolean;
  brandRequiredPluginNames: string[];
  contributedCliTools: (PluginCliToolContribution & { pluginName: string })[];
};

/* ── PluginAPI (given to each plugin's activate()) ── */

export type PluginNavigationRequest = {
  pluginName: string;
  target: PluginNavigationTarget;
};

export type PluginConversationRecord = {
  id: string;
  title: string | null;
  fallbackTitle: string | null;
  messages: unknown[];
  messageTree?: unknown[];
  headId?: string | null;
  conversationCompaction: unknown | null;
  lastContextUsage: unknown | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  titleStatus: string;
  titleUpdatedAt: string | null;
  messageCount: number;
  userMessageCount: number;
  runStatus: string;
  hasUnread: boolean;
  lastAssistantUpdateAt: string | null;
  selectedModelKey: string | null;
  selectedProfileKey?: string | null;
  fallbackEnabled?: boolean;
  profilePrimaryModelKey?: string | null;
  currentWorkingDirectory?: string | null;
  metadata?: Record<string, unknown>;
};

export type PluginConversationAppendMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: MessageContent[] | string;
  metadata?: Record<string, unknown>;
  parentId?: string | null;
  createdAt?: string;
};

export type PluginAPI = {
  pluginName: string;
  pluginDir: string;

  /** Host environment introspection (no permission required). */
  host: {
    /** Returns the host's plugin API semver version. */
    apiVersion: () => string;
    /** Returns the full list of capabilities this host exposes. */
    capabilities: () => string[];
    /** Check if a specific capability is available on this host. */
    hasCapability: (cap: string) => boolean;
  };

  config: {
    /**
     * Read the current app config. Returns a redacted {@link PluginSafeConfig}
     * by default — provider API keys, AWS secrets, MCP server env vars, web
     * server password, TLS private key paths, Azure subscription keys, and
     * provider extra headers are replaced with boolean / key-list indicators
     * (`hasApiKey`, `envKeys`, etc.).
     *
     * Plugins that declare the `'config:read-secrets'` permission receive
     * the full {@link AppConfig} including credentials. Approval for that
     * permission is gated through the standard install-time consent flow.
     *
     * Callers should narrow the union at runtime, e.g.:
     * ```ts
     * const cfg = api.config.get();
     * if ('apiKey' in cfg.models.providers.openai) {
     *   // full-config branch
     * }
     * ```
     */
    get: () => AppConfig | PluginSafeConfig;
    set: (path: string, value: unknown) => void;
    getPluginData: () => Record<string, unknown>;
    setPluginData: (path: string, value: unknown) => void;
    /**
     * Subscribe to app config changes. The callback receives the same
     * redacted-by-default view as {@link PluginAPI.config.get}: a
     * {@link PluginSafeConfig} unless the plugin holds `'config:read-secrets'`,
     * in which case the full {@link AppConfig} is delivered.
     */
    onChanged: (callback: (config: AppConfig | PluginSafeConfig) => void) => () => void;
  };

  state: {
    get: () => Record<string, unknown>;
    replace: (next: Record<string, unknown>) => void;
    set: (path: string, value: unknown) => void;
    emitEvent: (eventName: string, data?: unknown) => void;
  };

  tools: {
    register: (tools: ToolDefinition[]) => void;
    unregister: (toolNames: string[]) => void;
  };

  messages: {
    registerPreSendHook: (hook: PreSendHook) => void;
    registerPostReceiveHook: (hook: PostReceiveHook) => void;
  };

  lifecycle: {
    registerPreUpdateHook: (hook: PreUpdateHook) => void;
    registerPostUpdateHook: (hook: PostUpdateHook) => void;
  };

  ui: {
    showBanner: (descriptor: Omit<PluginBannerDescriptor, 'pluginName'>) => void;
    hideBanner: (id: string) => void;
    showModal: (descriptor: Omit<PluginModalDescriptor, 'pluginName'>) => void;
    hideModal: (id: string) => void;
    updateModal: (id: string, updates: Partial<Omit<PluginModalDescriptor, 'id' | 'pluginName'>>) => void;
    registerSettingsView: (descriptor: Omit<PluginSettingsSectionDescriptor, 'pluginName' | 'component'>) => void;
    registerPanelView: (descriptor: Omit<PluginPanelDescriptor, 'pluginName' | 'component'>) => void;
    registerNavigationItem: (descriptor: Omit<PluginNavigationItemDescriptor, 'pluginName' | 'label' | 'icon'> & { label?: string; icon?: PluginNavigationItemDescriptor['icon'] }) => void;
    registerCommand: (descriptor: Omit<PluginCommandDescriptor, 'pluginName'>) => void;
    showConversationDecoration: (descriptor: Omit<PluginConversationDecorationDescriptor, 'pluginName'>) => void;
    hideConversationDecoration: (id: string) => void;
    showThreadDecoration: (descriptor: Omit<PluginThreadDecorationDescriptor, 'pluginName'>) => void;
    hideThreadDecoration: (id: string) => void;
  };

  notifications: {
    show: (descriptor: Omit<PluginNotificationDescriptor, 'pluginName' | 'visible'>) => void;
    dismiss: (id: string) => void;
  };

  navigation: {
    open: (target: PluginNavigationTarget) => void;
  };

  conversations: {
    list: () => PluginConversationRecord[];
    get: (conversationId: string) => PluginConversationRecord | null;
    upsert: (conversation: PluginConversationRecord) => void;
    setActive: (conversationId: string) => void;
    getActiveId: () => string | null;
    appendMessage: (conversationId: string, message: PluginConversationAppendMessage) => PluginConversationRecord | null;
    markUnread: (conversationId: string, unread: boolean) => void;
  };

  log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };

  shell: {
    openExternal: (url: string) => Promise<void>;
  };

  auth: {
    openAuthWindow: (options: PluginAuthWindowOptions) => Promise<PluginAuthResult>;
  };

  safeStorage: {
    isEncryptionAvailable: () => boolean;
    encryptString: (plaintext: string) => string;
    decryptString: (base64Cipher: string) => string;
  };

  browser: {
    open: (options: PluginBrowserWindowOptions) => void;
  };

  session: {
    clearCookies: (partition: string, filter?: { domain?: string }) => Promise<number>;
  };

  http: {
    listen: (port: number, handler: (req: PluginHttpRequest) => PluginHttpResponse | Promise<PluginHttpResponse>, options?: { host?: string }) => Promise<void>;
    close: () => Promise<void>;
  };

  agent: {
    generate: (options: PluginAgentGenerateOptions) => Promise<PluginAgentGenerateResult>;
    registerInferenceProvider: (provider: PluginInferenceProvider) => void;
    unregisterInferenceProvider: () => void;
    registerRuntime: (runtime: PluginRuntimeContribution) => void;
    unregisterRuntime: (runtimeId: string) => void;
    registerCliTool: (tool: PluginCliToolContribution) => void;
  };

  onAction: (targetId: string, handler: (action: string, data?: unknown) => void | Promise<void>) => void;

  fetch: typeof globalThis.fetch;

  /* ── Whitelisted Command Execution ── */
  exec: {
    run: (request: ExecRequest) => Promise<ExecResult>;
    which: (binary: AllowedBinary) => Promise<string | null>;
  };

  /* ── Tool Detection (read-only) ── */
  detect: {
    claudeCode: () => Promise<ToolDetectionResult>;
    codex: () => Promise<ToolDetectionResult>;
    python: () => Promise<ToolDetectionResult>;
    node: () => Promise<ToolDetectionResult>;
    git: () => Promise<ToolDetectionResult>;
    pip: () => Promise<ToolDetectionResult>;
    binary: (name: AllowedBinary) => Promise<ToolDetectionResult>;
    claudePlugin: (pluginName: string) => Promise<{ installed: boolean; version?: string; path?: string }>;
    codexSkill: (skillId: string) => Promise<{ installed: boolean; path?: string }>;
    all: () => Promise<Record<string, ToolDetectionResult>>;
  };

  /* ── Safe Environment Access ── */
  env: {
    home: () => string;
    platform: () => string;
    get: (name: string) => string | undefined;
    paths: () => string[];
  };
};

export type PluginHttpRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body?: string;
};

export type PluginHttpResponse = {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
};

/* ── Plugin Agent Generate Types ── */

export type PluginAgentMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string | MessageContent[];
};

export type PluginAgentGenerateOptions = {
  messages: PluginAgentMessage[];
  modelKey?: string;
  profileKey?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  fallbackEnabled?: boolean;
  systemPrompt?: string;
  maxTokens?: number;
  tools?: boolean;
  abortSignal?: AbortSignal;
};

export type PluginAgentGenerateResult = {
  text: string;
  modelKey: string;
  toolCalls: Array<{
    toolName: string;
    args: unknown;
    result: unknown;
    error?: string;
    durationMs?: number;
  }>;
};

/* ── Plugin Inference Provider ── */

export type PluginInferenceStreamEvent = {
  conversationId: string;
  type: 'text-delta' | 'tool-call' | 'tool-result' | 'tool-error' | 'tool-progress' | 'tool-compaction' | 'error' | 'done' | 'context-usage' | 'enrichment' | 'compaction' | 'model-fallback';
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  data?: unknown;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
};

export type PluginInferenceStreamOptions = {
  conversationId: string;
  messages: Array<{ role: string; content: unknown }>;
  modelKey: string;
  systemPrompt: string;
  reasoningEffort?: string;
  abortSignal?: AbortSignal;
  /**
   * Tool definitions available to this conversation. Plugins acting as
   * inference providers should forward these to their underlying LLM so
   * the model can invoke them. The host filters by execution mode before
   * passing (e.g. plan-first mode strips mutating tools).
   *
   * Optional for backward compatibility with existing plugins; omitted
   * means no tools are available for this turn.
   */
  tools?: ToolDefinition[];
};

export type PluginInferenceProvider = {
  /** Human-readable name for logging. */
  name: string;
  /** Return true when this provider can handle inference right now. */
  isAvailable: () => boolean;
  /** Stream inference. Yield PluginInferenceStreamEvent objects. */
  stream: (options: PluginInferenceStreamOptions) => AsyncGenerator<PluginInferenceStreamEvent>;
};

/**
 * A runtime contributed by a plugin. Appears in the Runtimes tab alongside
 * Claude Code, Codex, and Mastra. Availability is checked dynamically.
 */
export type PluginRuntimeContribution = {
  /** Machine-readable id shown in the runtime selector (e.g. 'my-runtime'). */
  id: string;
  /** Human-readable name shown in the Runtimes tab. */
  name: string;
  /** Optional one-line description shown below the dropdown when this runtime is selected. */
  description?: string;
  /** Return true when this runtime is currently reachable/available. */
  isAvailable: () => boolean;
};

/**
 * A CLI tool contributed by a plugin. Appears in the Tools → CLI tab.
 * The binary is checked for existence on PATH just like built-in CLI tools.
 */
export type PluginCliToolContribution = {
  /** Display name (e.g. 'my-tool'). */
  name: string;
  /** Binary executable name (e.g. 'my-tool'). */
  binary: string;
  /** Optional additional binaries that should also be allowed. */
  extraBinaries?: string[];
  /** Description shown in the Tools UI. */
  description: string;
  /** Example usage prefix. */
  prefix?: string;
};

/* ── Modal/Banner Actions (renderer → main via IPC) ── */

export type PluginActionPayload = {
  pluginName: string;
  targetId: string;
  action: string;
  data?: unknown;
};

/* ── Auth Window Types ── */

/* ── Session Cookie Promotion Types ── */

/**
 * Describes a session cookie being considered for promotion.
 * Passed to the cookiePromotion callback when using function mode.
 */
export type SessionCookieInfo = {
  /** The cookie's domain (e.g. ".login.microsoftonline.com") */
  domain: string;
  /** The cookie name */
  name: string;
  /** The cookie path */
  path: string;
  /** Whether the cookie is secure */
  secure: boolean;
  /** Whether the cookie is httpOnly */
  httpOnly: boolean;
};

/**
 * Controls how session cookies (those without Expires/Max-Age) are promoted
 * to persistent cookies so they survive auth window closes.
 *
 * By default (undefined/false), NO promotion happens — session cookies die
 * when the last BrowserWindow using the partition closes. Plugins must opt in.
 *
 * Domain patterns support:
 * - `"*"` — matches all domains
 * - `"example.com"` — exact match (also matches cookie domain ".example.com")
 * - `"*.example.com"` — suffix wildcard (matches sub.example.com, deep.sub.example.com)
 * - `"prefix.*"` — prefix wildcard (matches prefix.anything.com)
 */
export type CookiePromotionConfig =
  | false
  | { domains: string[]; ttlDays?: number }
  | ((cookie: SessionCookieInfo) => { promote: boolean; ttlDays?: number } | false);

export type PluginAuthWindowOptions = {
  url: string;
  callbackMatch?: string;
  title?: string;
  width?: number;
  height?: number;
  timeoutMs?: number;
  showOnCreate?: boolean;
  showAfterMs?: number;
  successMessage?: string;
  extractParams?: string[];
  interceptUrls?: string[];
  interceptHeader?: string;
  partition?: string;
  onReady?: (helpers: AuthWindowHelpers) => void;
  /**
   * Custom user-agent string for the auth window.
   * - `undefined` (default): uses the branded user-agent.
   * - `false`: keeps Electron's default Chromium user-agent (useful when
   *   third-party login pages block non-browser user-agent strings).
   * - `string`: uses the provided string as-is.
   */
  customUserAgent?: string | false;
  /**
   * Controls session cookie promotion for this window's partition.
   * By default, no promotion happens. Opt in to persist session cookies
   * across window closes.
   */
  cookiePromotion?: CookiePromotionConfig;
};

export type AuthWindowHelpers = {
  executeJavaScript: (code: string) => Promise<unknown>;
  getURL: () => string;
  onDidNavigate: (callback: (url: string) => void) => void;
  show: () => void;
  hide: () => void;
  close: () => void;
};

export type PluginBrowserWindowOptions = {
  url: string;
  title?: string;
  width?: number;
  height?: number;
  partition?: string;
  /**
   * Custom user-agent string for the browser window.
   * - `undefined` (default): uses the branded user-agent.
   * - `false`: keeps Electron's default Chromium user-agent.
   * - `string`: uses the provided string as-is.
   */
  customUserAgent?: string | false;
  /**
   * Controls session cookie promotion for this window's partition.
   * By default, no promotion happens. Opt in to persist session cookies
   * across window closes.
   */
  cookiePromotion?: CookiePromotionConfig;
};

export type PluginAuthResult = {
  success: boolean;
  params?: Record<string, string>;
  error?: string;
};

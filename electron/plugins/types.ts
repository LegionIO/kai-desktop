import type { ToolDefinition } from '../tools/types.js';
import type { AppConfig } from '../config/schema.js';
import type { ActionDescriptor, AutomationEvent, EventDescriptor } from '../automations/types.js';
import type {
  HookEvent as AgentHookEvent,
  HookHandler as AgentHookHandler,
  HookRegistrationOptions as AgentHookRegistrationOptions,
} from '../agent/hooks/dispatcher.js';
import type { CompatCheckResult } from './plugin-compat.js';
import type { PluginSafeConfig } from './safe-config.js';
import type { KaiTaskMetadata, KaiTaskStatus, TaskExternalLink, TaskFile } from '../../shared/task-types.js';

export type { PluginSafeConfig } from './safe-config.js';
export type { ActionDescriptor, AutomationEvent, EventDescriptor } from '../automations/types.js';
export type {
  HookEvent as AgentHookEvent,
  HookMode as AgentHookMode,
  HookHandler as AgentHookHandler,
  HookOutcome as AgentHookOutcome,
  HookRegistrationOptions as AgentHookRegistrationOptions,
} from '../agent/hooks/dispatcher.js';

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
  | 'http:listen:network'
  | 'notifications:send'
  | 'conversations:read'
  | 'conversations:write'
  | 'tasks:read'
  | 'tasks:write'
  | 'navigation:open'
  | 'state:publish'
  | 'events:publish'
  | 'events:subscribe'
  | 'agent:generate'
  | 'agent:hook'
  | 'agent:inference-provider'
  | 'agent:register-cli-tool'
  | 'safe-storage'
  | 'browser:window'
  | 'browser:authenticated-session'
  | 'exec:whitelisted'
  | 'tools:detect'
  | 'system:env'
  | 'audit:log'
  | 'lifecycle:hook';

/**
 * Permissions that grant code-execution or secret-read capability and therefore
 * require explicit user consent before a plugin is loaded/installed. This is the
 * SINGLE SOURCE OF TRUTH — both the runtime consent gate (plugin-manager.ts) and
 * the marketplace install flow (marketplace-service.ts) import it, so a new
 * dangerous permission can't be gated in one path but silently skipped in the
 * other.
 *   - 'exec:whitelisted'   — run whitelisted binaries.
 *   - 'config:read-secrets'— read provider API keys, AWS/MCP secrets, web-server
 *                            password, TLS key paths (vs. the redacted safe config).
 *   - 'agent:hook'         — full MITM on the agent loop (observe/block/modify
 *                            prompts, tool args + results); ≈ arbitrary tool exec.
 *   - 'http:listen:network'— bind the plugin's http.listen server to a
 *                            non-loopback interface (0.0.0.0/::/a LAN address),
 *                            exposing its unauthenticated, plugin-controlled
 *                            handler to the local network instead of just this
 *                            machine.
 *   - 'tasks:write'        — create, edit, or archive user tasks, including
 *                            changing their workflow status.
 *   - 'browser:authenticated-session' — run frontend code in Kai's privileged
 *                            renderer, where Kai desktop data, API keys, and
 *                            authenticated Browser pages are available, and
 *                            allow a plugin-provided inference backend to
 *                            control those authenticated pages.
 */
export const DANGEROUS_PLUGIN_PERMISSIONS: ReadonlySet<PluginPermission> = new Set<PluginPermission>([
  'exec:whitelisted',
  'config:read-secrets',
  'agent:hook',
  'http:listen:network',
  'tasks:write',
  'browser:authenticated-session',
]);

export type PluginApprovalRecord = {
  hash: string;
  permissions?: string[];
  approvedAt: string;
};

/* ── Scoped Filesystem & Execution Declarations ── */

export type ScopedDirectory =
  | 'claude-home' // ~/.claude/
  | 'codex-home'; // ~/.codex/

export type AllowedBinary =
  | 'claude' // Claude Code CLI
  | 'codex' // Codex CLI
  | 'node' // Node.js
  | 'npm' // npm
  | 'pip' // Python package manager
  | 'pip3' // Python 3 package manager
  | 'python' // Python interpreter
  | 'python3' // Python 3 interpreter
  | 'git' // Git CLI
  | 'bash'; // Bash (only for whitelisted scripts)

export type ExecScopeDeclaration = {
  binaries: AllowedBinary[];
  argPatterns?: Record<string, string[]>;
};

/** Payload sent to the renderer when a plugin needs user consent to load. */
export type PluginConsentRequest = {
  pluginName: string;
  displayName: string;
  permissions: PluginPermission[];
  dangerousPermissions: PluginPermission[];
  execScope?: ExecScopeDeclaration;
  fileHash: string;
};

export type ExecRequest = {
  binary: AllowedBinary;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number; // default 60_000, max 300_000
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

/**
 * Result an `onAction` handler may return. A plugin can return nothing (fire-
 * and-forget), or a small structured ack the renderer/automation can read back
 * — e.g. `{ ok: true, message: 'Saved' }`. The full value is passed through by
 * `PluginManager.handleAction` unchanged.
 */
export type PluginActionResult = void | { ok?: boolean; message?: string; data?: unknown; [key: string]: unknown };

export type PluginActionHandler = (action: string, data?: unknown) => PluginActionResult | Promise<PluginActionResult>;

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
  /** True while this instance is running its deactivate()/cleanup teardown. */
  tearingDown?: boolean;
  /** True if this instance ended in `error` state due to a TRANSIENT filesystem
   *  failure during load/activation (not a deterministic defect). loadAll's faithful
   *  startup pass consults this to mark discovery incomplete + block installs even for
   *  a plugin an EARLIER non-faithful path (e.g. initMarketplace's required-plugin
   *  auto-install) already loaded as an error stub, so a transient failure there can't
   *  let an app update bypass the plugin's pre-update veto (R51P1). */
  transientLoadFailure?: boolean;
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
  contributedCliTools: PluginCliToolContribution[];
  declaredEvents: EventDescriptor[];
  declaredActions: ActionDescriptor[];
  eventUnsubscribers: Array<() => void>;
  agentHookUnsubscribers: Array<() => void>;
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
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      args: unknown;
      result?: unknown;
      isError?: boolean;
    }
  | { type: 'tool-result'; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
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
  /**
   * Aborted when the hook exceeds its per-hook timeout, or when the update is
   * cancelled/blocked WHILE the hook is still running. A well-behaved hook should
   * observe this and stop any privileged / long-running work. Propagates to
   * utility-process plugins via the wire transport's AbortSignal support for the
   * duration of the call. Note: once a hook has RETURNED, its signal is no longer
   * driven (a later cancellation can't reach detached background work a returned
   * hook left running) — a hook that starts background work should tie that work
   * to the signal and finish it before returning, or reconcile on next launch.
   * Optional to observe — existing hooks keep working unchanged.
   */
  signal: AbortSignal;
};

export type PreUpdateHookResult = {
  abort?: boolean;
  abortReason?: string;
  /**
   * Optional signal a plugin MAY set to mark its own abort as an *operational
   * failure* (a broken elevation command, a transient error) rather than a
   * deliberate policy block. When set, the update can offer "Proceed anyway".
   *
   * IMPORTANT: correctness must NOT depend on plugins setting this. The runner
   * also treats a *thrown* hook as a failure, and a deliberate `{ abort: true }`
   * from ANY plugin always wins over a failure elsewhere (see
   * `PreUpdateHooksOutcome`). This flag only lets a plugin opt a returned (not
   * thrown) abort into the overridable bucket.
   */
  failed?: boolean;
};

export type PreUpdateHook = (args: PreUpdateHookArgs) => Promise<PreUpdateHookResult> | PreUpdateHookResult;

/**
 * Aggregate outcome of running EVERY active plugin's pre-update hooks. The
 * runner runs them all (a failure in one must not skip a later plugin's
 * deliberate veto) and collapses the results with this precedence:
 *
 *   blocked  (a deliberate `{ abort: true }` from any plugin) — NOT overridable
 *     >  overridable  (a thrown hook, or a returned `{ failed: true }` abort) — user may Proceed anyway
 *       >  proceed  (all hooks passed)
 *
 * `reason` carries the first relevant plugin's message for display.
 * `rollback()` reverts setup performed by the plugins that actually participated
 * in THIS attempt. It is bound to the exact participating plugin instances
 * captured during the run (not looked up by name later), so a concurrent plugin
 * reload/disable during the hook window can't misdirect cleanup to a replacement
 * instance or skip an unloaded original. Invoke it on any non-proceed path. It
 * resolves with the names of participants whose cleanup did NOT complete
 * (`failed`) rather than throwing all-or-nothing, so the caller can mark the
 * SUCCEEDED participants done and re-owe only the failed ones (R35P1 per-plugin
 * guarantee — a plugin that cleaned up fine must not have its cleanup rerun).
 *
 * `stillFresh()` returns false if the active plugin generation has changed since
 * this outcome was produced. The caller re-checks it right before installing —
 * the user may sit on the "Proceed anyway" dialog while a plugin activates, which
 * would make the run's own generation check stale (R12P1).
 */
export type PreUpdateHooksOutcome = {
  rollback: (opts?: { onPluginDone?: (name: string) => void | Promise<void> }) => Promise<{ failed: string[] }>;
  stillFresh: () => boolean;
  /** Names of plugins whose pre-update hooks participated (rollback notifies
   *  these); the caller notifies the remaining active plugins by excluding them,
   *  so no plugin's post-update hook fires twice (R33P1). */
  participantNames: string[];
  /** Subset of `participantNames` that actually captured ≥1 post-update hook. The
   *  updater records these (∪ post-only plugins) as an attempt's `owed`, so a
   *  participant with NO cleanup hook isn't owed forever by a reconciler that
   *  refuses to clear hookless plugins (R35P1). */
  postHookParticipantNames: string[];
  /** Names of participants whose pre-update hook TIMED OUT and may still be
   *  running (could apply privileged setup after we proceed). The updater unions
   *  these into an attempt's `owed` at commit so a still-running elevation is
   *  reconciled even if the plugin never registered a post-hook (R8P1). */
  timedOutParticipantNames: string[];
  /** Names of participants whose pre-update hook FAILED (threw or returned
   *  `failed:true`), possibly after partial privileged setup and WITHOUT
   *  registering a post-update hook. The updater unions these into an attempt's
   *  `owed` at commit so their setup is reconciled even though they're hookless —
   *  a "successful" empty rollback must not erase the debt (R28P18). */
  failedParticipantNames: string[];
} & ({ decision: 'proceed' } | { decision: 'overridable'; reason: string } | { decision: 'blocked'; reason: string });

export type PostUpdateHookArgs = {
  version: string;
  success: boolean;
  /**
   * Aborted when the hook exceeds its per-hook timeout. A well-behaved cleanup
   * hook should observe this and stop, so an abandoned rollback can't overlap a
   * later retry's setup. Propagates to utility-process plugins via the wire
   * transport's AbortSignal support. Optional to observe.
   */
  signal: AbortSignal;
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
  | { type: 'action'; targetId: string; action: string; data?: unknown; panelId?: string };

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
  /** Immutable bytes captured from the exact directory snapshot the user
   * approved. Backend activation can mutate its own install directory, but it
   * can never change what the privileged renderer receives this session. */
  assets: ReadonlyMap<string, Uint8Array>;
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

/* ── Task-board integration ── */

/** Fields a plugin may set when creating a task on the Kai board. */
export type PluginTaskCreateInput = {
  title: string;
  description?: string;
  status?: KaiTaskStatus;
  metadata?: KaiTaskMetadata;
  workspaceId?: string;
  priority?: number;
};

/**
 * User-owned task fields a plugin may change. Execution/review audit fields,
 * agent assignments, timestamps, and external links are host-managed.
 */
export type PluginTaskUpdateInput = Partial<PluginTaskCreateInput>;

/** Plugin-owned portion of an external task identity. */
export type PluginTaskExternalLinkInput = Omit<TaskExternalLink, 'pluginName' | 'syncedAt'>;

export type PluginTaskUpsertExternalInput = {
  external: PluginTaskExternalLinkInput;
  task: PluginTaskCreateInput;
  /** Attach the external identity to an existing local task instead of creating one. */
  taskId?: string;
};

/** Correlates an inbound sync write with the change notification it produces. */
export type PluginTaskMutationOptions = {
  correlationId?: string;
};

export type PluginTaskChangeOrigin =
  | { type: 'app' | 'system' }
  | { type: 'plugin'; pluginName: string; correlationId?: string };

export type PluginTaskChangeEvent = {
  type: 'created' | 'updated' | 'archived' | 'unarchived' | 'deleted';
  taskId: string;
  task?: TaskFile;
  previous?: TaskFile;
  changedFields: Array<keyof TaskFile>;
  origin: PluginTaskChangeOrigin;
  timestamp: string;
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

  events: {
    /** Declare events this plugin emits and/or actions it exposes for automations. */
    declare: (decl: { events?: EventDescriptor[]; actions?: ActionDescriptor[] }) => void;
    /** Emit an event onto the automation bus (namespaced as `plugin.<name>:<event>`). */
    emit: (event: string, payload?: unknown) => void;
    /** Subscribe to bus events. `key` is `<source>:<event>` or `'*'`. Returns an unsubscribe fn. */
    on: (key: string, handler: (event: AutomationEvent) => void) => () => void;
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
    /**
     * Register a post-update cleanup/notification hook. For cleanup that must
     * survive an app RESTART/CRASH (e.g. revoking privileged setup a pre-update
     * hook performed), register this at plugin ACTIVATION — NOT only inside a
     * pre-update hook. Rationale (R28P48): the post-update ledger persists the owed
     * plugin's NAME across relaunch, but a JS callback cannot be serialized; after
     * `quitAndInstall` or a crash, the reconciler re-activates the plugin and
     * invokes the hooks it registered AT ACTIVATION. A hook registered ONLY as a
     * closure inside `registerPreUpdateHook` is best-effort within the SAME session
     * (same-generation rollback re-reads it), but is GONE after a restart — so its
     * cleanup would never run and the ledger debt is discarded after the reconcile
     * give-up cap. Make the activation-registered hook idempotent and able to
     * re-derive what to clean up from durable plugin state.
     */
    registerPostUpdateHook: (hook: PostUpdateHook) => void;
  };

  /**
   * Agent lifecycle hooks (UserPromptSubmit / PreToolUse / PostToolUse /
   * AssistantMessage / AgentStop / ConversationStart). Plugin hooks run before
   * user shell hooks so DLP / sanitization sees raw payloads. Returns an
   * unregister function; all registrations are also cleared automatically when
   * the plugin is disabled or unloaded.
   */
  hooks: {
    register: (event: AgentHookEvent, handler: AgentHookHandler, opts?: AgentHookRegistrationOptions) => () => void;
  };

  ui: {
    showBanner: (descriptor: Omit<PluginBannerDescriptor, 'pluginName'>) => void;
    hideBanner: (id: string) => void;
    showModal: (descriptor: Omit<PluginModalDescriptor, 'pluginName'>) => void;
    hideModal: (id: string) => void;
    updateModal: (id: string, updates: Partial<Omit<PluginModalDescriptor, 'id' | 'pluginName'>>) => void;
    registerSettingsView: (descriptor: Omit<PluginSettingsSectionDescriptor, 'pluginName' | 'component'>) => void;
    registerPanelView: (descriptor: Omit<PluginPanelDescriptor, 'pluginName' | 'component'>) => void;
    registerNavigationItem: (
      descriptor: Omit<PluginNavigationItemDescriptor, 'pluginName' | 'label' | 'icon'> & {
        label?: string;
        icon?: PluginNavigationItemDescriptor['icon'];
      },
    ) => void;
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
    appendMessage: (
      conversationId: string,
      message: PluginConversationAppendMessage,
    ) => PluginConversationRecord | null;
    markUnread: (conversationId: string, unread: boolean) => void;
  };

  /** Permission-gated access to the Kanban / Tasks board. */
  tasks: {
    list: (options?: { includeArchived?: boolean }) => Promise<TaskFile[]>;
    get: (taskId: string) => Promise<TaskFile | null>;
    create: (task: PluginTaskCreateInput, options?: PluginTaskMutationOptions) => Promise<TaskFile>;
    update: (taskId: string, updates: PluginTaskUpdateInput, options?: PluginTaskMutationOptions) => Promise<TaskFile>;
    archive: (taskId: string, options?: PluginTaskMutationOptions) => Promise<TaskFile>;
    unarchive: (taskId: string, options?: PluginTaskMutationOptions) => Promise<TaskFile>;
    /**
     * Create or update a task by the calling plugin's stable external identity.
     * This is the preferred inbound-sync primitive because retries are
     * idempotent and cannot overwrite another plugin's external link.
     */
    upsertExternal: (
      input: PluginTaskUpsertExternalInput,
      options?: PluginTaskMutationOptions,
    ) => Promise<{ task: TaskFile; created: boolean }>;
    /**
     * Subscribe to local task changes. Events include their origin and optional
     * correlation id so two-way sync plugins can suppress their own echoes.
     */
    onChanged: (handler: (event: PluginTaskChangeEvent) => void | Promise<void>) => () => void;
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
    listen: (
      port: number,
      handler: (req: PluginHttpRequest) => PluginHttpResponse | Promise<PluginHttpResponse>,
      options?: { host?: string },
    ) => Promise<void>;
    close: () => Promise<void>;
  };

  agent: {
    generate: (options: PluginAgentGenerateOptions) => Promise<PluginAgentGenerateResult>;
    stream: (options: PluginAgentGenerateOptions) => AsyncGenerator<PluginAgentStreamEvent>;
    registerInferenceProvider: (provider: PluginInferenceProvider) => void;
    unregisterInferenceProvider: () => void;
    registerCliTool: (tool: PluginCliToolContribution) => void;
  };

  onAction: (targetId: string, handler: PluginActionHandler) => void;

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
  role: 'user' | 'assistant' | 'system' | 'tool';
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

export type PluginAgentStreamEvent = {
  conversationId: string;
  type:
    | 'text-delta'
    | 'observer-message'
    | 'tool-call'
    | 'tool-result'
    | 'tool-error'
    | 'tool-progress'
    | 'tool-compaction'
    | 'tool-approval-required'
    | 'prompt-redacted'
    | 'error'
    | 'done'
    | 'compaction'
    | 'context-usage'
    | 'model-fallback'
    | 'enrichment'
    | 'retry'
    | 'step-progress'
    | 'max-steps-reached';
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
  modelKey?: string;
  errorCategory?: string;
  errorStatusCode?: number;
  stepInfo?: {
    currentStep: number;
    maxSteps: number;
    hitLimit: boolean;
    taskComplete: boolean;
  };
};

/* ── Plugin Inference Provider ── */

export type PluginInferenceStreamEvent = {
  conversationId: string;
  type:
    | 'text-delta'
    | 'tool-call'
    | 'tool-result'
    | 'tool-error'
    | 'tool-progress'
    | 'tool-compaction'
    | 'error'
    | 'done'
    | 'context-usage'
    | 'enrichment'
    | 'compaction'
    | 'model-fallback';
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
  modelKey?: string;
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

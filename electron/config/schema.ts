import { z } from 'zod';

export const executionModeSchema = z.enum(['auto', 'plan-first']);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

const computerUseSupportSchema = z.enum([
  'openai-responses',
  'anthropic-client-tool',
  'gemini-computer-use',
  'custom',
  'none',
]);

const computerUseTargetSchema = z.enum(['isolated-browser', 'local-macos']);

const computerUseSurfaceSchema = z.enum(['docked', 'window']);

const computerUseApprovalModeSchema = z.enum(['step', 'goal', 'autonomous']);

const computerUseToolSurfaceSchema = z.enum(['both', 'only-calls', 'only-chat', 'none']);

const partialTypingStrategySchema = z.enum(['disabled', 'full-replacement', 'ax-verified', 'tail-only', 'full-patch']);

const providerSchema = z.object({
  type: z.enum(['openai-compatible', 'anthropic', 'amazon-bedrock', 'google']),
  enabled: z.boolean().optional(),
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
  useResponsesApi: z.boolean().optional(),
  apiVersion: z.string().optional(),
  region: z.string().optional(),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  sessionToken: z.string().optional(),
  awsProfile: z.string().optional(),
  roleArn: z.string().optional(),
  useDefaultCredentials: z.boolean().optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  providerTools: z.array(z.record(z.string(), z.unknown())).optional(),
});

const promptCachingSchema = z.object({
  enabled: z.boolean(),
  /** Anthropic-only: cache TTL for ephemeral cache_control blocks. */
  ttl: z.enum(['5m', '1h']).optional(),
});

export type PromptCachingConfig = z.infer<typeof promptCachingSchema>;

const modelEntrySchema = z.object({
  key: z.string(),
  displayName: z.string(),
  provider: z.string(),
  modelName: z.string(),
  deploymentName: z.string().optional(),
  maxInputTokens: z.number().positive().optional(),
  useResponsesApi: z.boolean().optional(),
  providerTools: z.array(z.record(z.string(), z.unknown())).optional(),
  computerUseSupport: computerUseSupportSchema.optional(),
  visionCapable: z.boolean().optional(),
  preferredTarget: computerUseTargetSchema.optional(),
  promptCaching: promptCachingSchema.optional(),
});

const modelsConfigSchema = z.object({
  defaultModelKey: z.string(),
  providers: z.record(z.string(), providerSchema),
  catalog: z.array(modelEntrySchema),
});

const embeddingProviderSchema = z.object({
  type: z.enum(['openai', 'azure', 'custom']),
  model: z.string().optional(), // e.g. "text-embedding-3-small"
  openai: z
    .object({
      apiKey: z.string().optional(),
    })
    .optional(),
  azure: z
    .object({
      endpoint: z.string().optional(), // e.g. "https://myresource.openai.azure.com"
      apiKey: z.string().optional(),
      deploymentName: z.string().optional(), // e.g. "text-embedding-3-small"
      apiVersion: z.string().optional(), // e.g. "2024-02-01"
    })
    .optional(),
  custom: z
    .object({
      baseUrl: z.string().optional(), // Any OpenAI-compatible embeddings endpoint
      apiKey: z.string().optional(),
    })
    .optional(),
});

const memoryConfigSchema = z.object({
  enabled: z.boolean(),
  workingMemory: z.object({
    enabled: z.boolean(),
    scope: z.enum(['thread', 'resource']),
    template: z.string().optional(),
  }),
  observationalMemory: z.object({
    enabled: z.boolean(),
    scope: z.enum(['thread', 'resource']),
    deploymentName: z.string().optional(),
  }),
  semanticRecall: z.object({
    enabled: z.boolean(),
    topK: z.number().positive(),
    scope: z.enum(['thread', 'resource']),
    embeddingProvider: embeddingProviderSchema.optional(),
  }),
  lastMessages: z.number().positive(),
});

const toolCompactionSchema = z.object({
  enabled: z.boolean(),
  useAI: z.boolean(),
  triggerTokens: z.number().positive(),
  outputMaxTokens: z.number().positive(),
  truncateMinChars: z.number().positive(),
  truncateHeadRatio: z.number().min(0).max(1),
  truncateMinTailChars: z.number().positive(),
});

const conversationCompactionSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['observational-memory']),
  triggerPercent: z.number().min(0).max(1),
  ignoreRecentUserMessages: z.number().nonnegative(),
  ignoreRecentAssistantMessages: z.number().nonnegative(),
  outputMaxTokens: z.number().positive(),
  promptReserveTokens: z.number().positive(),
  contextWindowTokens: z.number().positive().optional(),
});

const shellGuardrailsSchema = z.object({
  enabled: z.boolean(),
  timeout: z.number().positive(),
  allowPatterns: z.array(z.string()),
  denyPatterns: z.array(z.string()),
  requireConfirmation: z.boolean().optional(),
});

const fileAccessSchema = z.object({
  enabled: z.boolean(),
  allowPaths: z.array(z.string()),
  denyPaths: z.array(z.string()),
});

const diffTrackingSchema = z.object({
  enabled: z.boolean(),
  /** Max files to stat during a pre/post shell snapshot before falling back to AI inference. */
  snapshotFileLimit: z.number().positive(),
  /** Wall-clock budget (ms) for a single snapshot walk. */
  snapshotTimeoutMs: z.number().positive(),
  /** When true, ask the default model to infer changed paths when the snapshot is skipped or empty. */
  aiFallback: z.boolean(),
});

const processStreamingSchema = z.object({
  enabled: z.boolean(),
  updateIntervalMs: z.number().positive(),
  modelFeedMode: z.enum(['incremental', 'final-only']),
  maxOutputBytes: z.number().positive(),
  truncationMode: z.enum(['head', 'tail', 'head-tail']),
  stopAfterMax: z.boolean(),
  headTailRatio: z.number().min(0).max(1),
  observer: z.object({
    enabled: z.boolean(),
    intervalMs: z.number().positive(),
    maxSnapshotChars: z.number().positive(),
    maxMessagesPerTool: z.number().positive(),
    maxTotalLaunchedTools: z.number().positive(),
  }),
});

const mcpServerSchema = z.object({
  name: z.string(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});

const subAgentConfigSchema = z.object({
  enabled: z.boolean(),
  maxDepth: z.number().positive().max(10),
  maxConcurrent: z.number().positive().max(20),
  maxPerParent: z.number().positive().max(10),
  defaultModel: z.string().optional(),
});

const profileConfigSchema = z.object({
  key: z.string(),
  name: z.string(),
  primaryModelKey: z.string(),
  fallbackModelKeys: z.array(z.string()),
  systemPrompt: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxSteps: z.number().positive().optional(),
  maxRetries: z.number().nonnegative().optional(),
  useResponsesApi: z.boolean().optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
});

const systemPromptsConfigSchema = z.object({
  chat: z.string().optional(),
  plan: z.string().optional(),
  computerUse: z.string().optional(),
  taskPlan: z.string().optional(),
});

const titleGenerationConfigSchema = z.object({
  enabled: z.boolean(),
});

const fallbackConfigSchema = z.object({
  enabled: z.boolean(),
  modelKeys: z.array(z.string()),
});

const computerUseConfigSchema = z.object({
  enabled: z.boolean(),
  showStepLog: z.boolean(),
  toolSurface: computerUseToolSurfaceSchema,
  defaultSurface: computerUseSurfaceSchema,
  defaultTarget: computerUseTargetSchema,
  approvalModeDefault: computerUseApprovalModeSchema,
  idleTimeoutSec: z.number().positive(),
  postActionDelayMs: z.number().min(0).max(5000),
  maxSessionDurationMin: z.number().positive(),
  models: z.object({
    plannerModelKey: z.string().optional(),
    driverModelKey: z.string().optional(),
    verifierModelKey: z.string().optional(),
    recoveryModelKey: z.string().optional(),
  }),
  capture: z.object({
    maxDimension: z.number().positive(),
    jpegQuality: z.number().min(0.1).max(1),
    modelFrame: z.object({
      mode: z.enum(['native', 'canonical']),
      width: z.number().positive(),
      height: z.number().positive(),
    }),
  }),
  safety: z.object({
    pauseOnTerminal: z.boolean(),
    manualTakeoverPauses: z.boolean(),
  }),
  localMacos: z.object({
    autoRequestPermissions: z.boolean(),
    autoOpenPrivacySettings: z.boolean(),
    allowedDisplays: z.array(z.string()),
    captureExcludedApps: z.array(z.string()),
  }),
  overlay: z.object({
    enabled: z.boolean(),
    position: z.enum(['top', 'bottom']),
    heightPx: z.number().min(60).max(300),
    opacity: z.number().min(0.3).max(0.95),
  }),
});

const azureAudioConfigSchema = z.object({
  endpoint: z.string().optional(), // Custom TTS base URL (overrides region-based URL)
  region: z.string().optional(), // e.g. "eastus" — used to construct standard Azure endpoints
  subscriptionKey: z.string().optional(), // Ocp-Apim-Subscription-Key
  ttsVoice: z.string().optional(), // e.g. "en-US-JennyNeural"
  ttsOutputFormat: z.string().optional(), // e.g. "audio-24khz-48kbitrate-mono-mp3"
  ttsRate: z.number().min(0.5).max(3).optional(),
  sttLanguage: z.string().optional(), // e.g. "en-US"
  sttEndpoint: z.string().optional(), // Custom WebSocket endpoint for STT
});

/** OpenAI Realtime STT config — used by both dictation and composer STT. */
const openaiSttConfigSchema = z.object({
  baseUrl: z.string().optional(), // WebSocket base URL (default: "wss://api.openai.com")
  apiKey: z.string().optional(),
  model: z.string().optional(), // default: "gpt-realtime-whisper"
});

const sttConfigSchema = z.object({
  provider: z.enum(['azure', 'openai']).optional(), // default: follows audio.provider
  openai: openaiSttConfigSchema.optional(),
  livePartials: z.boolean().optional(), // Show live partial text in composer (default: true)
});

const audioConfigSchema = z.object({
  provider: z.enum(['native', 'azure']).optional(), // default: 'native'
  azure: azureAudioConfigSchema.optional(),
  stt: sttConfigSchema.optional(),
  tts: z.object({
    enabled: z.boolean(),
    voice: z.string().optional(),
    rate: z.number().min(0.5).max(3),
  }),
  recording: z.object({
    enabled: z.boolean(),
    language: z.string().optional(),
    continuous: z.boolean(),
    inputDeviceId: z.string().nullable().optional(),
  }),
});

const realtimeConfigSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(['openai', 'azure', 'custom']),
  openai: z
    .object({
      apiKey: z.string().optional(),
    })
    .optional(),
  azure: z
    .object({
      endpoint: z.string().optional(), // e.g. "https://myresource.openai.azure.com"
      apiKey: z.string().optional(),
      deploymentName: z.string().optional(), // e.g. "gpt-realtime-1.5"
      apiVersion: z.string().optional(), // e.g. "2024-10-01-preview"
    })
    .optional(),
  custom: z
    .object({
      baseUrl: z.string().optional(), // WebSocket base URL
      apiKey: z.string().optional(),
    })
    .optional(),
  model: z.string().optional(), // default: "gpt-4o-realtime-preview"
  voice: z.string().optional(), // default: "alloy"
  instructions: z.string().optional(), // system instructions for realtime session
  turnDetection: z
    .object({
      type: z.enum(['server_vad', 'none']).optional(),
      threshold: z.number().min(0).max(1).optional(),
      silenceDurationMs: z.number().positive().optional(),
    })
    .optional(),
  inputAudioTranscription: z.boolean().optional(),
  inputDeviceId: z.string().nullable().optional(),
  outputDeviceId: z.string().nullable().optional(),
  autoEndCall: z
    .object({
      enabled: z.boolean().optional(),
      silenceTimeoutSec: z.number().positive().optional(),
    })
    .optional(),
  memoryContext: z
    .object({
      enabled: z.boolean(),
      maxTokens: z.number().positive(),
      conversationHistory: z.object({
        enabled: z.boolean(),
        maxMessages: z.number().nonnegative(),
      }),
      workingMemory: z.object({ enabled: z.boolean() }),
      semanticRecall: z.object({
        enabled: z.boolean(),
        topK: z.number().positive(),
      }),
      observationalMemory: z.object({ enabled: z.boolean() }),
    })
    .optional(),
  computerUseUpdates: z
    .object({
      enabled: z.boolean(),
      throttleMs: z.number().min(1000).max(30000),
      onStepCompleted: z.boolean(),
      onStepFailed: z.boolean(),
      onCheckpoint: z.boolean(),
      onApprovalNeeded: z.boolean(),
      onGuidanceReceived: z.boolean(),
      onSessionCompleted: z.boolean(),
      onSessionFailed: z.boolean(),
    })
    .optional(),
});

const mediaGenProviderConfigSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(['openai', 'azure', 'custom']),
  openai: z
    .object({
      apiKey: z.string().optional(),
    })
    .optional(),
  azure: z
    .object({
      endpoint: z.string().optional(),
      apiKey: z.string().optional(),
      deploymentName: z.string().optional(),
      apiVersion: z.string().optional(),
    })
    .optional(),
  custom: z
    .object({
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
    })
    .optional(),
  model: z.string().optional(),
});

const imageGenerationConfigSchema = mediaGenProviderConfigSchema.extend({
  size: z.string().optional(),
  quality: z.string().optional(),
  style: z.string().optional(),
  outputFormat: z.string().optional(),
  timeout: z.number().positive().optional(),
});

const videoGenerationConfigSchema = mediaGenProviderConfigSchema.extend({
  size: z.string().optional(),
  duration: z.string().optional(),
  timeout: z.number().positive().optional(),
});

const pluginApprovalSchema = z.object({
  hash: z.string(),
  permissions: z.array(z.string()).optional(),
  approvedAt: z.string(),
});

const marketplaceInstalledPluginSchema = z.object({
  name: z.string(),
  repository: z.string(),
  version: z.string(),
  fileHash: z.string().optional(),
  permissions: z.array(z.string()).optional(),
  installedAt: z.string(),
  marketplaceUrl: z.string(),
});

const marketplaceConfigSchema = z.object({
  installedPlugins: z.record(z.string(), marketplaceInstalledPluginSchema),
});

const pluginSystemSchema = z
  .object({
    /** Controls behavior when a plugin's version/capability constraints don't match the host. */
    compatibilityMode: z.enum(['strict', 'warn']).default('warn'),
    /** Names of non-required plugins the user has disabled until they re-enable them. */
    disabledPlugins: z.array(z.string()).default([]),
  })
  .default({ compatibilityMode: 'warn', disabledPlugins: [] });

const cliToolSchema = z.object({
  name: z.string(),
  binary: z.string(),
  extraBinaries: z.array(z.string()).optional(),
  description: z.string(),
  prefix: z.string().optional(),
  enabled: z.boolean().optional(),
  builtIn: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Autopilot (Orchestrator)
// ---------------------------------------------------------------------------

/**
 * Default denylist for environment variables that agent processes may NOT override.
 * Glob patterns (`*` prefix/suffix) are supported. These guard against PATH/loader
 * hijacking and credential exfiltration via overridden API endpoints.
 */
export const DEFAULT_AGENT_ENV_DENYLIST = [
  'PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'DYLD_*',
  'LD_*',
  '*_BASE_URL',
  '*_API_KEY',
  // Config-root redirects — overriding these lets the agent point the CLI at
  // an attacker-controlled config file, bypassing the args denylist below.
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_CONFIG_DIR',
] as const;

/**
 * Default denylist for CLI arguments that agent processes may NOT receive via
 * `config.customArgs`. Glob patterns (`*` prefix/suffix) are supported. These
 * guard against permission-bypass flags and arbitrary code/config injection.
 */
export const DEFAULT_AGENT_ARGS_DENYLIST = [
  '--dangerously*',
  // Trailing `*` on long options also catches the `--opt=value` form.
  '--eval*',
  '--mcp-config*',
  '--config*',
  // Permission / sandbox override flags for claude-code and codex CLIs
  // (both camelCase and kebab-case aliases)
  '--permission-mode*',
  '--permissionMode*',
  '--sandbox*',
  '--ask-for-approval*',
  '--allowedTools*',
  '--allowed-tools*',
  '--add-dir*',
  // Short flags with attached values (-cfoo, -sfoo, -afoo, -efoo). Glob match
  // is exact-or-prefix so `-c*` matches `-c` AND `-csandbox_mode=...` but NOT
  // `--color` (different leading chars).
  '-c*',
  '-e*',
  '-s*',
  '-a*',
] as const;

const reviewPolicySchema = z.object({
  /** Minimum AI reviewers autopilot should assign. 0 = no AI review. */
  minReviewers: z.number().min(0).max(5).default(2),
  /** When all AI reviewers approve, skip human review and go directly to done. */
  skipHumanReviewOnApproval: z.boolean().default(false),
  /** When true, AI can override skipHumanReviewOnApproval for complex/untestable work. */
  aiCanRequireHumanReview: z.boolean().default(true),
  /** Max auto-retries before escalating to human review. */
  maxRetriesBeforeEscalation: z.number().min(1).max(10).default(3),
  /** Review mode: parallel (all at once) or sequential (stop on first rejection). */
  defaultReviewMode: z.enum(['parallel', 'sequential']).default('parallel'),
});

const unblockPolicySchema = z.object({
  /** Whether autopilot should attempt to resolve blocked tasks using AI. */
  enabled: z.boolean().default(true),
  /** Max AI unblock attempts per task before giving up. */
  maxAttempts: z.number().min(1).max(5).default(2),
});

const autopilotConfigSchema = z.object({
  enabled: z.boolean().default(false),
  intervalMs: z.number().min(5000).max(300000).default(30000),
  autoStart: z.boolean().default(true),
  maxConcurrentAgents: z.number().min(1).max(10).default(3),
  matchingStrategy: z.enum(['simple', 'ai-scored']).default('simple'),
  /** @deprecated Use reviewPolicy.skipHumanReviewOnApproval instead */
  requireHumanReview: z.boolean().default(true),
  /**
   * When true, agents spawned by autopilot run with --dangerously-skip-permissions
   * (Claude) or --dangerously-bypass-approvals-and-sandbox (Codex). When false,
   * agents run in interactive/approval mode. Requires user confirmation on first enable.
   */
  dangerousMode: z.boolean().default(false),
  /** Review policy — controls reviewer assignment, approval routing, and retries. */
  reviewPolicy: reviewPolicySchema.default({
    minReviewers: 2,
    skipHumanReviewOnApproval: false,
    aiCanRequireHumanReview: true,
    maxRetriesBeforeEscalation: 3,
    defaultReviewMode: 'parallel',
  }),
  /** Unblock policy — controls AI-powered task unblocking behavior. */
  unblockPolicy: unblockPolicySchema.default({
    enabled: true,
    maxAttempts: 2,
  }),
  /**
   * Env-var keys (glob `*` prefix/suffix supported) that agent `config.env` may NOT set.
   * Applied in startAgentRun before the env is handed to the PTY.
   */
  agentEnvDenylist: z.array(z.string()).default([...DEFAULT_AGENT_ENV_DENYLIST]),
  /**
   * If set and non-empty, agent `config.env` keys must ALSO match one of these patterns
   * (after surviving the denylist). Unset/empty = allow anything not denied.
   */
  agentEnvAllowlist: z.array(z.string()).optional(),
  /**
   * CLI args (glob `*` prefix/suffix supported) that agent `config.customArgs` may NOT contain.
   * Applied in startAgentRun before args are handed to the PTY.
   */
  agentArgsDenylist: z.array(z.string()).default([...DEFAULT_AGENT_ARGS_DENYLIST]),
  /**
   * If set and non-empty, agent `config.customArgs` entries must ALSO match one of these
   * patterns (after surviving the denylist). Unset/empty = allow anything not denied.
   */
  agentArgsAllowlist: z.array(z.string()).optional(),
});

export type AutopilotConfig = z.infer<typeof autopilotConfigSchema>;
export type ReviewPolicy = z.infer<typeof reviewPolicySchema>;
export type UnblockPolicy = z.infer<typeof unblockPolicySchema>;

// ---------------------------------------------------------------------------
// Agent runtime config
// ---------------------------------------------------------------------------

export type RuntimeIdConfig = 'mastra' | 'claude-agent-sdk' | 'codex-sdk';

const claudeAgentSdkConfigSchema = z.object({
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions']).optional(),
  maxTurns: z.number().positive().optional(),
  thinking: z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('adaptive') }),
      z.object({ type: z.literal('disabled') }),
      z.object({ type: z.literal('enabled'), budgetTokens: z.number().positive() }),
    ])
    .optional(),
  persistSession: z.boolean().optional(),
});

const codexSdkConfigSchema = z.object({
  approval: z.enum(['suggest', 'auto-edit', 'full-auto']).optional(),
});

const agentConfigSchema = z.object({
  runtime: z.string().default('auto'), // 'auto' | 'mastra' | 'claude-agent-sdk' | 'codex-sdk' | plugin runtime ids
  maxTurns: z.number().positive().optional(),
  autoContinueOnMaxTurns: z.boolean().optional(),
  claudeAgentSdk: claudeAgentSdkConfigSchema.optional(),
  codexSdk: codexSdkConfigSchema.optional(),
});

const webServerConfigSchema = z.object({
  enabled: z.boolean(),
  port: z.number().positive(),
  bindAddress: z.string(),
  tls: z.object({
    enabled: z.boolean(),
    mode: z.enum(['self-signed', 'custom']),
    certPath: z.string(),
    keyPath: z.string(),
  }),
  auth: z.object({
    mode: z.enum(['anonymous', 'password']),
    username: z.string(),
    password: z.string(),
  }),
});

// ── Workspace ─────────────────────────────────────────────────────────────

export const WORKSPACE_COLORS = [
  '#EF4444',
  '#F97316',
  '#F59E0B',
  '#22C55E',
  '#14B8A6',
  '#3B82F6',
  '#8B5CF6',
  '#EC4899',
] as const;

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  directory: z.string().min(1),
  color: z.string(),
  lastActiveAt: z.number(),
  createdAt: z.number(),
  lastActiveConversationId: z.string().nullable().default(null),
});

export type Workspace = z.infer<typeof workspaceSchema>;

const automationConditionSchema = z.object({
  path: z.string().default(''),
  op: z.enum(['equals', 'notEquals', 'contains', 'startsWith', 'endsWith', 'matches', 'in', 'exists', 'expression']),
  value: z.unknown().optional(),
  caseSensitive: z.boolean().default(false),
});

const automationConversationTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('per-invocation') }),
  z.object({ type: z.literal('singleton') }),
  z.object({ type: z.literal('existing'), conversationId: z.string() }),
]);

export type AutomationConversationTarget = z.infer<typeof automationConversationTargetSchema>;

const automationActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('agent'),
    mode: z.enum(['background', 'conversation']).default('background'),
    prompt: z.string(),
    modelKey: z.string().optional(),
    profileKey: z.string().optional(),
    tools: z.boolean().default(true),
    conversationTitle: z.string().optional(),
    conversationTarget: automationConversationTargetSchema.default({ type: 'per-invocation' }),
    includeHistory: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('plugin-action'),
    pluginName: z.string(),
    targetId: z.string(),
    action: z.string().default('automation'),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal('tool'),
    toolName: z.string(),
    input: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    type: z.literal('notification'),
    title: z.string(),
    body: z.string().optional(),
  }),
  z.object({
    type: z.literal('emit'),
    source: z.string(),
    event: z.string(),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal('runHookCommand'),
    command: z.string(),
    mode: z.enum(['observe', 'block', 'modify']).default('observe'),
    /** Glob against payload.toolName (PreToolUse / PostToolUse only). */
    matcher: z.string().optional(),
  }),
]);

export const automationRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().default(true),
  trigger: z.object({ source: z.string(), event: z.string() }),
  conditions: z.array(automationConditionSchema).default([]),
  conditionMode: z.enum(['all', 'any']).default('all'),
  actions: z.array(automationActionSchema).min(1),
  debounceMs: z.number().int().nonnegative().default(0),
  rateLimitPerMinute: z.number().int().positive().optional(),
});

const automationsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  rules: z.array(automationRuleSchema).default([]),
  log: z.object({ maxEntries: z.number().int().positive().default(200) }).default({ maxEntries: 200 }),
});

export type AutomationCondition = z.infer<typeof automationConditionSchema>;
export type AutomationAction = z.infer<typeof automationActionSchema>;
export type AutomationRule = z.infer<typeof automationRuleSchema>;
export type AutomationsConfig = z.infer<typeof automationsConfigSchema>;

const hooksConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().positive().default(5000),
  })
  .default({ enabled: true, timeoutMs: 5000 });

export type HooksConfig = z.infer<typeof hooksConfigSchema>;

/** Sidebar tab identifiers — scoped tabs filter by active workspace, global tabs show everything. */
export type SidebarTab = 'chats' | 'tasks' | 'messages' | 'agents' | 'plugins';

export const sidebarTabSchema = z.enum(['chats', 'tasks', 'messages', 'agents', 'plugins']);

export const appConfigSchema = z.object({
  agent: agentConfigSchema.optional(),
  models: modelsConfigSchema,
  memory: memoryConfigSchema,
  compaction: z.object({
    tool: toolCompactionSchema,
    conversation: conversationCompactionSchema,
  }),
  tools: z.object({
    shell: shellGuardrailsSchema,
    fileAccess: fileAccessSchema,
    diffTracking: diffTrackingSchema.default({
      enabled: true,
      snapshotFileLimit: 2000,
      snapshotTimeoutMs: 200,
      aiFallback: true,
    }),
    processStreaming: processStreamingSchema,
    subAgents: subAgentConfigSchema,
    executionMode: executionModeSchema.default('auto'),
    webFetch: z
      .object({
        enabled: z.boolean().default(true),
        timeout: z.number().positive().optional(),
        allowPrivateNetworks: z.boolean().default(false),
      })
      .optional(),
    webSearch: z
      .object({
        enabled: z.boolean().default(true),
        timeout: z.number().positive().optional(),
      })
      .optional(),
    artifacts: z
      .object({
        enabled: z.boolean().default(true),
      })
      .optional(),
  }),
  mcpServers: z.array(mcpServerSchema),
  skills: z.object({
    directory: z.string(),
    enabled: z.array(z.string()),
  }),
  systemPrompt: z.string(),
  systemPrompts: systemPromptsConfigSchema.optional(),
  titleGeneration: titleGenerationConfigSchema.optional(),
  plugins: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  pluginApprovals: z.record(z.string(), pluginApprovalSchema),
  pluginSystem: pluginSystemSchema,
  marketplace: marketplaceConfigSchema.optional(),
  launchAtLogin: z.boolean(),
  ui: z.object({
    theme: z.enum(['light', 'dark', 'system']),
    sidebarWidth: z.number().positive(),
    fullWidthContent: z.boolean().default(true),
    showPluginDockIcons: z.boolean().default(true),
    dockOrder: z
      .object({
        units: z.array(z.string()).default([]),
        plugins: z.array(z.string()).default([]),
      })
      .default({ units: [], plugins: [] }),
    pluginBubbleExpanded: z.boolean().default(true),
    /**
     * How dock notification badges render when their value is a word/string:
     * - 'dot': collapse to a corner dot; full text moves to the icon tooltip
     * - 'truncate': small pill capped with an ellipsis; full text in the tooltip
     * - 'full': show the full text in a constrained pill
     * Numeric badges always render as a count pill regardless of this setting.
     */
    dockBadgeStyle: z.enum(['dot', 'truncate', 'full']).default('dot'),
    splashBackground: z.enum(['random', 'matrix', 'constellations', 'hexagons', 'smokescreen']).default('random'),
    workspaces: z.array(workspaceSchema).default([]),
    activeWorkspaceId: z.string().nullable().default(null),
    composer: z
      .object({
        showModelProfileSelector: z.boolean(),
      })
      .default({ showModelProfileSelector: true }),
  }),
  webServer: webServerConfigSchema,
  audio: audioConfigSchema,
  realtime: realtimeConfigSchema,
  computerUse: computerUseConfigSchema,
  dictation: z
    .object({
      enabled: z.boolean(),
      provider: z.enum(['azure', 'openai']).optional(), // default: 'azure'
      openai: openaiSttConfigSchema.optional(), // Credentials for OpenAI Realtime STT
      hotkey: z.string(),
      mode: z.enum(['toggle', 'hold']),
      inputDeviceId: z.string().nullable().optional(),
      language: z.string().optional(),
      vadSilenceDurationMs: z.number().min(300).max(5000).optional(),
      finalCleanupEnabled: z.boolean().optional(),
      livePartials: z.boolean().optional(),
      partialTyping: z
        .object({
          ax: partialTypingStrategySchema.optional(),
          kb: partialTypingStrategySchema.optional(),
        })
        .optional(),
      debugLogging: z.boolean().optional(),
    })
    .optional(),
  appShots: z
    .object({
      enabled: z.boolean().default(false),
      hotkey: z.string().default('CommandOrControl+Shift+1'),
      captureMode: z.enum(['window', 'display']).default('window'),
      includeUiTree: z.boolean().default(true),
      includeSelectedText: z.boolean().default(true),
      uiTreeDepth: z.number().int().min(1).max(10).default(4),
      /** When true, also auto-attach to the active composer on capture (otherwise clipboard-only). */
      autoAttach: z.boolean().default(false),
    })
    .optional(),
  advanced: z.object({
    temperature: z.number().min(0).max(2),
    maxSteps: z.number().positive(),
    maxRetries: z.number().nonnegative(),
    useResponsesApi: z.boolean(),
  }),
  profiles: z.array(profileConfigSchema).optional(),
  defaultProfileKey: z.string().optional(),
  fallback: fallbackConfigSchema.optional(),
  imageGeneration: imageGenerationConfigSchema.optional(),
  videoGeneration: videoGenerationConfigSchema.optional(),
  cliTools: z.array(cliToolSchema).optional(),
  autopilot: autopilotConfigSchema.optional(),
  automations: automationsConfigSchema.default({ enabled: true, rules: [], log: { maxEntries: 200 } }),
  hooks: hooksConfigSchema,
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type CliToolConfig = z.infer<typeof cliToolSchema>;

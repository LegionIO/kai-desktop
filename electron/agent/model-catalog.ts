import type { AppConfig, PromptCachingConfig } from '../config/schema.js';
import type { ComputerUseSupport, ComputerUseTarget } from '../../shared/computer-use.js';

export type LLMProviderType = 'openai-compatible' | 'anthropic' | 'amazon-bedrock' | 'google';
export type ProviderToolConfig = Record<string, unknown>;

export type LLMModelConfig = {
  provider: LLMProviderType;
  endpoint: string;
  apiKey: string;
  apiVersion?: string;
  deploymentName?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  awsProfile?: string;
  roleArn?: string;
  modelName: string;
  maxInputTokens?: number;
  useResponsesApi?: boolean;
  extraHeaders?: Record<string, string>;
  providerTools?: ProviderToolConfig[];
  promptCaching?: PromptCachingConfig;
  temperature: number;
  maxSteps?: number;
  maxRetries?: number;
};

export type ModelCatalogEntry = {
  key: string;
  displayName: string;
  modelConfig: LLMModelConfig;
  computerUseSupport?: ComputerUseSupport;
  visionCapable?: boolean;
  preferredTarget?: ComputerUseTarget;
};

function normalizeProviderTools(
  ...toolSets: Array<ProviderToolConfig[] | undefined>
): ProviderToolConfig[] | undefined {
  const tools = toolSets
    .flatMap((toolSet) => toolSet ?? [])
    .filter((tool): tool is ProviderToolConfig => tool != null && typeof tool === 'object' && !Array.isArray(tool));

  return tools.length > 0 ? tools : undefined;
}

export function resolveModelCatalog(config: AppConfig): {
  entries: ModelCatalogEntry[];
  defaultEntry: ModelCatalogEntry | null;
  byKey: Map<string, ModelCatalogEntry>;
} {
  const entries: ModelCatalogEntry[] = [];
  const byKey = new Map<string, ModelCatalogEntry>();

  for (const model of config.models.catalog) {
    const providerConfig = config.models.providers[model.provider];
    if (!providerConfig) continue;
    if (providerConfig.enabled === false) continue;

    const modelConfig: LLMModelConfig = {
      provider: providerConfig.type,
      endpoint: providerConfig.endpoint ?? '',
      apiKey: providerConfig.apiKey ?? '',
      useResponsesApi: model.useResponsesApi ?? providerConfig.useResponsesApi,
      apiVersion: providerConfig.apiVersion,
      region: providerConfig.region,
      accessKeyId: providerConfig.accessKeyId,
      secretAccessKey: providerConfig.secretAccessKey,
      sessionToken: providerConfig.sessionToken,
      awsProfile: providerConfig.awsProfile,
      roleArn: providerConfig.roleArn,
      extraHeaders: providerConfig.extraHeaders,
      deploymentName: model.deploymentName,
      modelName: model.modelName,
      maxInputTokens: model.maxInputTokens,
      providerTools: normalizeProviderTools(providerConfig.providerTools, model.providerTools),
      promptCaching: model.promptCaching,
      temperature: config.advanced.temperature,
      maxSteps: config.advanced.maxSteps,
      maxRetries: config.advanced.maxRetries,
    };

    const entry: ModelCatalogEntry = {
      key: model.key,
      displayName: model.displayName,
      modelConfig,
      computerUseSupport: model.computerUseSupport,
      visionCapable: model.visionCapable,
      preferredTarget: model.preferredTarget,
    };

    entries.push(entry);
    byKey.set(model.key, entry);
  }

  const defaultEntry = byKey.get(config.models.defaultModelKey) ?? entries[0] ?? null;

  return { entries, defaultEntry, byKey };
}

export function resolveModelForThread(config: AppConfig, threadModelKey: string | null): ModelCatalogEntry | null {
  const catalog = resolveModelCatalog(config);
  if (threadModelKey && catalog.byKey.has(threadModelKey)) {
    return catalog.byKey.get(threadModelKey)!;
  }
  return catalog.defaultEntry;
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type ResolvedStreamConfig = {
  primaryModel: ModelCatalogEntry;
  fallbackModels: ModelCatalogEntry[];
  fallbackEnabled: boolean;
  systemPrompt: string;
  temperature: number;
  maxSteps: number;
  maxRetries: number;
  useResponsesApi: boolean;
  reasoningEffort?: ReasoningEffort;
  profileKey?: string;
};

export function resolveStreamConfig(
  config: AppConfig,
  opts: {
    threadModelKey: string | null;
    threadProfileKey: string | null;
    reasoningEffort?: ReasoningEffort;
    fallbackEnabled: boolean;
    threadOverrides?: {
      temperature?: number | null;
      systemPromptOverride?: string | null;
      maxSteps?: number | null;
      maxRetries?: number | null;
      runtimeOverride?: string | null;
    };
  },
): ResolvedStreamConfig | null {
  const catalog = resolveModelCatalog(config);

  // 1. Find active profile: conversation → global default → synthesize from defaultModelKey
  //    Special sentinel '__none__' means explicitly skip all profiles.
  const skipProfile = opts.threadProfileKey === '__none__';
  const profileKey = skipProfile ? null : (opts.threadProfileKey ?? config.defaultProfileKey ?? null);
  let profile = profileKey ? (config.profiles ?? []).find((p) => p.key === profileKey) : undefined;

  // If no profile resolved, synthesize an implicit one from the global defaultModelKey
  // so the resolution always flows through a profile path.
  if (!profile) {
    profile = {
      key: '__default__',
      name: 'Default',
      primaryModelKey: config.models.defaultModelKey,
      fallbackModelKeys: config.fallback?.modelKeys ?? [],
    };
  }

  // 2. Resolve primary model: manual override → profile's primary model
  const primaryModelKey = opts.threadModelKey ?? profile.primaryModelKey;
  const primaryModel = catalog.byKey.get(primaryModelKey) ?? catalog.defaultEntry;
  if (!primaryModel) return null;

  // 3. Resolve fallback chain from profile. Filter against the RESOLVED primary
  // key (primaryModel.key), not the requested key — when the requested key is
  // stale and we fell back to defaultEntry, filtering by the stale key could
  // leave the resolved primary sitting in its own fallback list.
  const fallbackKeys = profile.fallbackModelKeys;
  const fallbackModels = fallbackKeys
    .map((k) => catalog.byKey.get(k))
    .filter((e): e is ModelCatalogEntry => e != null)
    .filter((e) => e.key !== primaryModel.key);

  // 4. Merge parameters: thread overrides → profile overrides → global
  const threadOvr = opts.threadOverrides;
  const temperature = threadOvr?.temperature ?? profile.temperature ?? config.advanced.temperature;
  const maxSteps = threadOvr?.maxSteps ?? profile.maxSteps ?? config.advanced.maxSteps;
  const maxRetries = threadOvr?.maxRetries ?? profile.maxRetries ?? config.advanced.maxRetries;
  const profileUseResponsesApi = profile.useResponsesApi;
  const useResponsesApi =
    profileUseResponsesApi ?? primaryModel.modelConfig.useResponsesApi ?? config.advanced.useResponsesApi;
  const globalSystemPrompt = config.systemPrompts?.chat?.trim() || config.systemPrompt;
  const systemPrompt = threadOvr?.systemPromptOverride?.trim() || profile.systemPrompt?.trim() || globalSystemPrompt;
  const reasoningEffort = opts.reasoningEffort ?? (profile.reasoningEffort as ReasoningEffort | undefined);

  // 5. Apply merged parameters to model configs (cloned so we don't mutate catalog)
  // For useResponsesApi, precedence is: profile explicit > model/provider default > global default.
  const applyOverrides = (entry: ModelCatalogEntry): ModelCatalogEntry => ({
    key: entry.key,
    displayName: entry.displayName,
    modelConfig: {
      ...entry.modelConfig,
      temperature,
      maxSteps,
      maxRetries,
      useResponsesApi: profileUseResponsesApi ?? entry.modelConfig.useResponsesApi ?? config.advanced.useResponsesApi,
    },
  });

  return {
    primaryModel: applyOverrides(primaryModel),
    fallbackModels: fallbackModels.map(applyOverrides),
    fallbackEnabled: opts.fallbackEnabled && fallbackModels.length > 0,
    systemPrompt,
    temperature,
    maxSteps,
    maxRetries,
    useResponsesApi,
    reasoningEffort,
    profileKey: profile?.key,
  };
}

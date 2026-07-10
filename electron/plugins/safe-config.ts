import type { AppConfig } from '../config/schema.js';

/**
 * Plugin-safe view of provider config. Replaces all credential leaves
 * (apiKey, AWS access keys, session token, extra headers) with boolean
 * indicators so plugin hooks can detect "is a provider configured"
 * without ever seeing the raw secret.
 */
export type PluginSafeProviderConfig = Omit<
  AppConfig['models']['providers'][string],
  'apiKey' | 'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'extraHeaders'
> & {
  hasApiKey: boolean;
  hasAccessKeyId: boolean;
  hasSecretAccessKey: boolean;
  hasSessionToken: boolean;
  hasExtraHeaders: boolean;
};

/**
 * Plugin-safe view of an embedding/media/realtime provider sub-config
 * (the small `{ apiKey, endpoint, ... }` blocks used by openai/azure/custom
 * sub-providers throughout the schema).
 */
export type PluginSafeProviderCredentialBlock<T> = Omit<T, 'apiKey'> & {
  hasApiKey: boolean;
};

type AzureAudioConfig = NonNullable<AppConfig['audio']['azure']>;
type PluginSafeAzureAudioConfig = Omit<AzureAudioConfig, 'subscriptionKey'> & {
  hasSubscriptionKey: boolean;
};

type RealtimeConfig = AppConfig['realtime'];
type PluginSafeRealtimeConfig = Omit<RealtimeConfig, 'openai' | 'azure' | 'custom'> & {
  openai?: PluginSafeProviderCredentialBlock<NonNullable<RealtimeConfig['openai']>>;
  azure?: PluginSafeProviderCredentialBlock<NonNullable<RealtimeConfig['azure']>>;
  custom?: PluginSafeProviderCredentialBlock<NonNullable<RealtimeConfig['custom']>>;
};

type ImageGenerationConfig = NonNullable<AppConfig['imageGeneration']>;
type PluginSafeImageGenerationConfig = Omit<ImageGenerationConfig, 'openai' | 'azure' | 'custom'> & {
  openai?: PluginSafeProviderCredentialBlock<NonNullable<ImageGenerationConfig['openai']>>;
  azure?: PluginSafeProviderCredentialBlock<NonNullable<ImageGenerationConfig['azure']>>;
  custom?: PluginSafeProviderCredentialBlock<NonNullable<ImageGenerationConfig['custom']>>;
};

type VideoGenerationConfig = NonNullable<AppConfig['videoGeneration']>;
type PluginSafeVideoGenerationConfig = Omit<VideoGenerationConfig, 'openai' | 'azure' | 'custom'> & {
  openai?: PluginSafeProviderCredentialBlock<NonNullable<VideoGenerationConfig['openai']>>;
  azure?: PluginSafeProviderCredentialBlock<NonNullable<VideoGenerationConfig['azure']>>;
  custom?: PluginSafeProviderCredentialBlock<NonNullable<VideoGenerationConfig['custom']>>;
};

type EmbeddingProviderConfig = NonNullable<AppConfig['memory']['semanticRecall']['embeddingProvider']>;
type PluginSafeEmbeddingProviderConfig = Omit<EmbeddingProviderConfig, 'openai' | 'azure' | 'custom'> & {
  openai?: PluginSafeProviderCredentialBlock<NonNullable<EmbeddingProviderConfig['openai']>>;
  azure?: PluginSafeProviderCredentialBlock<NonNullable<EmbeddingProviderConfig['azure']>>;
  custom?: PluginSafeProviderCredentialBlock<NonNullable<EmbeddingProviderConfig['custom']>>;
};

type PluginSafeMemoryConfig = Omit<AppConfig['memory'], 'semanticRecall'> & {
  semanticRecall: Omit<AppConfig['memory']['semanticRecall'], 'embeddingProvider'> & {
    embeddingProvider?: PluginSafeEmbeddingProviderConfig;
  };
};

type McpServer = AppConfig['mcpServers'][number];
type PluginSafeMcpServer = Omit<McpServer, 'env'> & {
  envKeys: string[];
  hasEnv: boolean;
};

type PluginSafeAudioConfig = Omit<AppConfig['audio'], 'azure' | 'stt'> & {
  azure?: PluginSafeAzureAudioConfig;
  stt?: PluginSafeSttConfig;
};

/** STT sub-config with the OpenAI Realtime apiKey redacted. */
type PluginSafeSttConfig = Omit<NonNullable<AppConfig['audio']['stt']>, 'openai'> & {
  openai?: PluginSafeProviderCredentialBlock<NonNullable<NonNullable<AppConfig['audio']['stt']>['openai']>>;
};

/** Dictation config with the OpenAI Realtime apiKey redacted. */
type PluginSafeDictationConfig = Omit<NonNullable<AppConfig['dictation']>, 'openai'> & {
  openai?: PluginSafeProviderCredentialBlock<NonNullable<NonNullable<AppConfig['dictation']>['openai']>>;
};

type PluginSafeWebServerConfig = Omit<AppConfig['webServer'], 'tls' | 'auth'> & {
  tls: Omit<AppConfig['webServer']['tls'], 'keyPath'> & {
    hasKeyPath: boolean;
  };
  auth: Omit<AppConfig['webServer']['auth'], 'password'> & {
    hasPassword: boolean;
  };
};

/**
 * A structural subset of `AppConfig` safe to pass to third-party plugin
 * hooks. All credential-bearing leaves (API keys, AWS access keys, session
 * tokens, MCP server env vars, web server passwords, TLS private key paths,
 * Azure subscription keys, extra HTTP headers) are either omitted or
 * replaced with boolean / key-list indicators so a plugin can still detect
 * which providers are configured without ever seeing the secret value.
 *
 * Build instances with {@link toPluginSafeConfig}.
 */
export type PluginSafeConfig = Omit<
  AppConfig,
  | 'models'
  | 'memory'
  | 'mcpServers'
  | 'webServer'
  | 'audio'
  | 'realtime'
  | 'imageGeneration'
  | 'videoGeneration'
  | 'dictation'
> & {
  models: Omit<AppConfig['models'], 'providers'> & {
    providers: Record<string, PluginSafeProviderConfig>;
  };
  memory: PluginSafeMemoryConfig;
  mcpServers: PluginSafeMcpServer[];
  webServer: PluginSafeWebServerConfig;
  audio: PluginSafeAudioConfig;
  realtime: PluginSafeRealtimeConfig;
  imageGeneration?: PluginSafeImageGenerationConfig;
  videoGeneration?: PluginSafeVideoGenerationConfig;
  dictation?: PluginSafeDictationConfig;
};

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function redactProviderCredentialBlock<T extends { apiKey?: string }>(
  block: T | undefined,
): PluginSafeProviderCredentialBlock<T> | undefined {
  if (!block) return undefined;
  const { apiKey, ...rest } = block;
  return {
    ...(rest as Omit<T, 'apiKey'>),
    hasApiKey: hasNonEmptyString(apiKey),
  };
}

function redactProvider(provider: AppConfig['models']['providers'][string]): PluginSafeProviderConfig {
  const { apiKey, accessKeyId, secretAccessKey, sessionToken, extraHeaders, ...rest } = provider;
  return {
    ...rest,
    hasApiKey: hasNonEmptyString(apiKey),
    hasAccessKeyId: hasNonEmptyString(accessKeyId),
    hasSecretAccessKey: hasNonEmptyString(secretAccessKey),
    hasSessionToken: hasNonEmptyString(sessionToken),
    hasExtraHeaders: !!extraHeaders && Object.keys(extraHeaders).length > 0,
  };
}

/**
 * Strip credential-bearing fields from an {@link AppConfig} so it can be
 * safely passed to plugin hooks. The returned object is deep-cloned — the
 * caller cannot use mutations to leak data back into the source config.
 *
 * Plugins already run with full Node.js access in the main process, so
 * this is a principle-of-least-privilege fix rather than a sandbox
 * boundary: it prevents accidental credential leaks through plugin logs,
 * crash reports, or hostile/buggy hook implementations without changing
 * the threat model.
 */
export function toPluginSafeConfig(config: AppConfig): PluginSafeConfig {
  // Start from a structured clone so caller mutations on nested objects
  // never reach back into `config`. We then overwrite the credential
  // sections with redacted versions.
  const cloned = structuredClone(config);

  const safeProviders: Record<string, PluginSafeProviderConfig> = {};
  for (const [name, provider] of Object.entries(cloned.models.providers)) {
    safeProviders[name] = redactProvider(provider);
  }

  const safeMcpServers: PluginSafeMcpServer[] = cloned.mcpServers.map((server) => {
    const { env, ...rest } = server;
    return {
      ...rest,
      envKeys: env ? Object.keys(env) : [],
      hasEnv: !!env && Object.keys(env).length > 0,
    };
  });

  const embeddingProvider = cloned.memory.semanticRecall.embeddingProvider;
  const safeEmbeddingProvider: PluginSafeEmbeddingProviderConfig | undefined = embeddingProvider
    ? {
        ...embeddingProvider,
        openai: redactProviderCredentialBlock(embeddingProvider.openai),
        azure: redactProviderCredentialBlock(embeddingProvider.azure),
        custom: redactProviderCredentialBlock(embeddingProvider.custom),
      }
    : undefined;

  const safeMemory: PluginSafeMemoryConfig = {
    ...cloned.memory,
    semanticRecall: {
      ...cloned.memory.semanticRecall,
      embeddingProvider: safeEmbeddingProvider,
    },
  };

  const safeAudio: PluginSafeAudioConfig = {
    ...cloned.audio,
    azure: cloned.audio.azure
      ? (() => {
          const { subscriptionKey, ...rest } = cloned.audio.azure!;
          return {
            ...rest,
            hasSubscriptionKey: hasNonEmptyString(subscriptionKey),
          };
        })()
      : undefined,
    stt: cloned.audio.stt
      ? { ...cloned.audio.stt, openai: redactProviderCredentialBlock(cloned.audio.stt.openai) }
      : undefined,
  };

  const safeDictation: PluginSafeDictationConfig | undefined = cloned.dictation
    ? { ...cloned.dictation, openai: redactProviderCredentialBlock(cloned.dictation.openai) }
    : undefined;

  const safeRealtime: PluginSafeRealtimeConfig = {
    ...cloned.realtime,
    openai: redactProviderCredentialBlock(cloned.realtime.openai),
    azure: redactProviderCredentialBlock(cloned.realtime.azure),
    custom: redactProviderCredentialBlock(cloned.realtime.custom),
  };

  const safeImageGeneration: PluginSafeImageGenerationConfig | undefined = cloned.imageGeneration
    ? {
        ...cloned.imageGeneration,
        openai: redactProviderCredentialBlock(cloned.imageGeneration.openai),
        azure: redactProviderCredentialBlock(cloned.imageGeneration.azure),
        custom: redactProviderCredentialBlock(cloned.imageGeneration.custom),
      }
    : undefined;

  const safeVideoGeneration: PluginSafeVideoGenerationConfig | undefined = cloned.videoGeneration
    ? {
        ...cloned.videoGeneration,
        openai: redactProviderCredentialBlock(cloned.videoGeneration.openai),
        azure: redactProviderCredentialBlock(cloned.videoGeneration.azure),
        custom: redactProviderCredentialBlock(cloned.videoGeneration.custom),
      }
    : undefined;

  const { keyPath: tlsKeyPath, ...safeTlsRest } = cloned.webServer.tls;
  const { password, ...safeAuthRest } = cloned.webServer.auth;
  const safeWebServer: PluginSafeWebServerConfig = {
    ...cloned.webServer,
    tls: {
      ...safeTlsRest,
      hasKeyPath: hasNonEmptyString(tlsKeyPath),
    },
    auth: {
      ...safeAuthRest,
      hasPassword: hasNonEmptyString(password),
    },
  };

  // Destructure to drop the original credential-bearing branches before
  // spreading the rest; this keeps the returned type honest.
  const {
    models: _models,
    memory: _memory,
    mcpServers: _mcpServers,
    webServer: _webServer,
    audio: _audio,
    realtime: _realtime,
    imageGeneration: _imageGeneration,
    videoGeneration: _videoGeneration,
    dictation: _dictation,
    ...remaining
  } = cloned;

  return {
    ...remaining,
    models: {
      ...cloned.models,
      providers: safeProviders,
    },
    memory: safeMemory,
    mcpServers: safeMcpServers,
    webServer: safeWebServer,
    audio: safeAudio,
    realtime: safeRealtime,
    imageGeneration: safeImageGeneration,
    videoGeneration: safeVideoGeneration,
    dictation: safeDictation,
  };
}

/**
 * Resolve which view of the app config a plugin sees based on the
 * permissions declared in its manifest.
 *
 * - Plugins that declared `'config:read-secrets'` receive the full
 *   {@link AppConfig} including credentials.
 * - All other plugins receive a redacted {@link PluginSafeConfig} with
 *   API keys, AWS secrets, MCP env vars, web server password, TLS
 *   private key paths, and Azure subscription keys stripped or replaced
 *   with boolean / key-list indicators.
 *
 * Centralising the gate keeps `PluginAPI.config.get()` and the
 * `onConfigChanged` dispatch path in `PluginManager` in lockstep and
 * gives us a single place to test the policy.
 *
 * The caller is responsible for actually invoking the permission check
 * that guards the read itself (`config:read`); this helper only decides
 * the shape of the returned value once the read has been authorised.
 */
export function resolvePluginConfigView(
  config: AppConfig,
  permissions: readonly string[],
): AppConfig | PluginSafeConfig {
  if (permissions.includes('config:read-secrets')) {
    return config;
  }
  return toPluginSafeConfig(config);
}

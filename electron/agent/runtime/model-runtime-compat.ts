/**
 * Model-to-runtime compatibility resolver.
 *
 * Determines the best runtime for a given model based on its provider type,
 * and resolves Anthropic-compatible credentials when the Claude Code runtime
 * is selected.
 *
 * Design:
 *   - In "auto" mode, Kai picks the best runtime for the model's provider type.
 *   - In explicit mode, Kai validates compatibility and warns on mismatch.
 *   - For Claude Code, model + endpoint + API key are always resolved explicitly
 *     so Kai is in full control (no silent fallback to ~/.claude/settings.json).
 */

import type { AppConfig } from '../../config/schema.js';
import type { ModelCatalogEntry, LLMProviderType } from '../model-catalog.js';
import { resolveModelCatalog } from '../model-catalog.js';
import type { RuntimeId } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelAuth = {
  modelName: string;
  baseUrl: string;
  apiKey: string;
};

export type RuntimeResolution = {
  /** The runtime to use (built-in RuntimeId) */
  runtimeId: string;
  /** For Claude Code: resolved Anthropic-compatible credentials */
  modelAuth?: ModelAuth;
  /** For incompatible explicit-runtime selections */
  warning?: string;
  /**
   * When a non-built-in runtime is selected but the model belongs to a different
   * provider, override the model's endpoint to route through that provider.
   * Contains the provider key to look up in config.models.providers.
   */
  providerOverride?: string;
  /**
   * Identifies the inference provider context even when the concrete streaming
   * runtime is Mastra. Used to locate a plugin inference provider before
   * falling back to OpenAI-compatible provider routing.
   */
  inferenceProviderRuntimeId?: string;
  /**
   * Non-blocking notice shown in chat when the preferred runtime is unavailable
   * and inference is falling back to the standard pipeline.
   */
  fallbackNotice?: string;
};

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the best runtime + credentials for a given model.
 *
 * @param model          The resolved model catalog entry (null = use defaults)
 * @param config         Full app config (needed for catalog cross-referencing)
 * @param preferred      The user's runtime preference ('auto' or explicit ID)
 * @param available      Set of runtime IDs that are currently available
 */
export function resolveRuntimeForModel(
  model: ModelCatalogEntry | null,
  config: AppConfig,
  preferred: RuntimeId | 'auto',
  available: Set<string>,
): RuntimeResolution {
  const providerType: LLMProviderType | null = model?.modelConfig?.provider ?? null;

  if (preferred === 'auto') {
    return resolveAutoMode(model, providerType, config, available);
  }

  return resolveExplicitMode(model, providerType, config, preferred, available);
}

// ---------------------------------------------------------------------------
// Auto mode: pick the best runtime for the model's provider
// ---------------------------------------------------------------------------

function resolveAutoMode(
  model: ModelCatalogEntry | null,
  providerType: LLMProviderType | null,
  config: AppConfig,
  available: Set<string>,
): RuntimeResolution {
  // No model or no provider info — fall back to default behavior (Claude Code → Mastra)
  if (!model || !providerType) {
    if (available.has('claude-agent-sdk')) {
      return { runtimeId: 'claude-agent-sdk' };
    }
    return { runtimeId: 'mastra' };
  }

  switch (providerType) {
    case 'anthropic':
    case 'amazon-bedrock': {
      // Native Claude Code compatibility
      if (available.has('claude-agent-sdk')) {
        return {
          runtimeId: 'claude-agent-sdk',
          modelAuth: extractModelAuth(model),
        };
      }
      return { runtimeId: 'mastra' };
    }

    case 'openai-compatible': {
      // Check if the same model is available under an Anthropic/Bedrock provider
      // with a claude-* model name (SDK validates names client-side).
      const crossRef = crossReferenceAnthropicProvider(model.modelConfig.modelName, config);
      if (crossRef && crossRef.modelName.toLowerCase().startsWith('claude') && available.has('claude-agent-sdk')) {
        return {
          runtimeId: 'claude-agent-sdk',
          modelAuth: crossRef,
        };
      }
      // Genuinely non-Claude model — use Codex (native OpenAI) or Mastra (universal)
      if (available.has('codex-sdk')) {
        return { runtimeId: 'codex-sdk', modelAuth: extractModelAuth(model) };
      }
      return { runtimeId: 'mastra' };
    }

    case 'google': {
      // Only Mastra supports Google/Gemini models
      return { runtimeId: 'mastra' };
    }

    default:
      return { runtimeId: 'mastra' };
  }
}

// ---------------------------------------------------------------------------
// Explicit mode: validate compatibility, warn on mismatch
// ---------------------------------------------------------------------------

function resolveExplicitMode(
  model: ModelCatalogEntry | null,
  providerType: LLMProviderType | null,
  config: AppConfig,
  preferred: RuntimeId,
  available: Set<string>,
): RuntimeResolution {
  // Runtime not available.
  if (!available.has(preferred)) {
    const isBuiltInRuntime = preferred === 'mastra' || preferred === 'claude-agent-sdk' || preferred === 'codex-sdk';
    if (!isBuiltInRuntime) {
      // Before falling back, check whether a native provider key exists that
      // matches this runtime ID (e.g. runtime 'legion' → provider 'legionio').
      // If so, route through Mastra using that provider.
      const nativeProviderKey = Object.keys(config.models.providers).find(
        (key) => key.startsWith(preferred) || key === preferred,
      );
      if (nativeProviderKey) {
        return {
          runtimeId: 'mastra',
          providerOverride: nativeProviderKey,
        };
      }
    }
    return { runtimeId: 'mastra' };
  }

  // No model info.
  if (!model || !providerType) {
    const isBuiltInRuntime = preferred === 'mastra' || preferred === 'claude-agent-sdk' || preferred === 'codex-sdk';
    if (!isBuiltInRuntime) {
      // Same native-provider fallback: if a provider key exists for this runtime,
      // route through Mastra rather than a missing plugin.
      const nativeProviderKey = Object.keys(config.models.providers).find(
        (key) => key.startsWith(preferred) || key === preferred,
      );
      if (nativeProviderKey) {
        return { runtimeId: 'mastra', providerOverride: nativeProviderKey };
      }
      return { runtimeId: 'mastra', inferenceProviderRuntimeId: preferred };
    }
    return { runtimeId: preferred };
  }

  switch (preferred) {
    case 'claude-agent-sdk': {
      if (providerType === 'anthropic' || providerType === 'amazon-bedrock') {
        return {
          runtimeId: 'claude-agent-sdk',
          modelAuth: extractModelAuth(model),
        };
      }
      // OpenAI model — try cross-reference to find an Anthropic-compatible endpoint
      if (providerType === 'openai-compatible') {
        const crossRef = crossReferenceAnthropicProvider(model.modelConfig.modelName, config);
        if (crossRef) {
          // The Claude Code SDK validates model names client-side and only accepts
          // names starting with 'claude'. If the model isn't aliased with a claude-
          // prefix on the gateway, warn the user rather than letting it fail silently.
          if (!crossRef.modelName.toLowerCase().startsWith('claude')) {
            return {
              runtimeId: 'claude-agent-sdk',
              warning: `The selected model (${model.displayName}) cannot be used with the Claude Code runtime because its model ID ("${crossRef.modelName}") is not a Claude model name.`,
            };
          }
          return {
            runtimeId: 'claude-agent-sdk',
            modelAuth: crossRef,
          };
        }
      }
      // Plugin-owned model (e.g. a model contributed by a runtime plugin whose
      // provider key is not a built-in Anthropic/Bedrock entry). The plugin's
      // inference provider has already been bypassed by the explicit runtime
      // override, so show a clear incompatibility warning rather than silently
      // failing inside the Claude Code runtime.
      const rawEntry = config.models.catalog.find((m) => m.key === model.key);
      const providerKey = rawEntry?.provider ?? '';
      const isBuiltInProvider =
        providerKey === 'anthropic' ||
        providerKey === 'amazon-bedrock' ||
        providerKey === 'openai' ||
        providerKey === 'google' ||
        providerKey === 'gemini' ||
        providerKey === 'ollama' ||
        providerKey === 'bedrock';
      if (!isBuiltInProvider) {
        return {
          runtimeId: 'claude-agent-sdk',
          warning: `The selected model (${model.displayName}) is not compatible with the Claude Code runtime. Claude Code only supports Claude models. Switch to Auto runtime or select a Claude model.`,
        };
      }
      // Incompatible built-in model
      return {
        runtimeId: 'claude-agent-sdk',
        warning: `The selected model (${model.displayName}) is from ${providerTypeLabel(providerType)} provider, which is not supported by the Claude Code runtime. Switch to Auto runtime in Settings → Agent Runtime, or select a model from an Anthropic provider.`,
      };
    }

    case 'codex-sdk': {
      if (providerType === 'openai-compatible') {
        return { runtimeId: 'codex-sdk', modelAuth: extractModelAuth(model) };
      }
      // Incompatible
      return {
        runtimeId: 'codex-sdk',
        warning: `The selected model (${model.displayName}) is from ${providerTypeLabel(providerType)} provider, which is not supported by the Codex runtime. Switch to Auto runtime in Settings → Agent Runtime, or select a model from an OpenAI-compatible provider.`,
      };
    }

    case 'mastra':
    default:
      // Mastra handles everything
      return { runtimeId: 'mastra' };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract Claude-compatible auth from a model entry that's already under
 * an Anthropic or Bedrock provider.
 */
function extractModelAuth(model: ModelCatalogEntry): ModelAuth {
  return {
    modelName: model.modelConfig.modelName,
    baseUrl: stripV1Suffix(model.modelConfig.endpoint),
    apiKey: model.modelConfig.apiKey,
  };
}

/**
 * Cross-reference the model catalog to find the same modelName under an
 * Anthropic or Bedrock provider. This handles the enterprise gateway case
 * where the same model is registered under both OpenAI and Anthropic endpoints.
 */
function crossReferenceAnthropicProvider(modelName: string, config: AppConfig): ModelAuth | null {
  const catalog = resolveModelCatalog(config);

  const isAnthropicMatch = (entry: (typeof catalog.entries)[number]): boolean =>
    entry.modelConfig.modelName === modelName &&
    (entry.modelConfig.provider === 'anthropic' || entry.modelConfig.provider === 'amazon-bedrock');

  // `modelName` is provider-scoped, not globally unique — two Anthropic/Bedrock
  // providers can expose the same `claude-*` name. Prefer a match that actually
  // carries a credential so a keyless duplicate entry can't shadow a configured
  // one (which would route to an endpoint with no key). Catalog order is the
  // tiebreaker among usable matches. Key + endpoint always stay paired from the
  // SAME entry (no cross-provider credential mixing).
  const usable = catalog.entries.find((e) => isAnthropicMatch(e) && !!e.modelConfig.apiKey);
  const entry = usable ?? catalog.entries.find(isAnthropicMatch);
  if (!entry) return null;
  return {
    modelName: entry.modelConfig.modelName,
    baseUrl: stripV1Suffix(entry.modelConfig.endpoint),
    apiKey: entry.modelConfig.apiKey,
  };
}

/**
 * Strip a trailing `/v1` (with optional trailing slash) from an endpoint URL.
 *
 * The Claude Code SDK sets `ANTHROPIC_BASE_URL` and appends `/v1/messages`
 * itself.  Kai's Anthropic-type providers store endpoints with `/v1`
 * (the standard Anthropic Messages API convention), so passing the raw
 * endpoint would produce a double-path like `.../v1/v1/messages`.
 */
function stripV1Suffix(url: string): string {
  return url.replace(/\/v1\/?$/, '');
}

function providerTypeLabel(type: LLMProviderType): string {
  switch (type) {
    case 'openai-compatible':
      return 'an OpenAI-compatible';
    case 'anthropic':
      return 'an Anthropic';
    case 'amazon-bedrock':
      return 'an Amazon Bedrock';
    case 'google':
      return 'a Google';
    default:
      return `a ${type}`;
  }
}

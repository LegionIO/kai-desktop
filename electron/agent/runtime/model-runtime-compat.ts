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

export type ClaudeAuth = {
  modelName: string;
  baseUrl: string;
  apiKey: string;
};

export type RuntimeResolution = {
  /** The runtime to use (built-in RuntimeId or plugin-contributed runtime ID) */
  runtimeId: string;
  /** For Claude Code: resolved Anthropic-compatible credentials */
  claudeAuth?: ClaudeAuth;
  /** For incompatible explicit-runtime selections */
  warning?: string;
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

  // Check if this model belongs to a plugin-contributed runtime.
  // Plugin models use provider keys that start with or match their runtime ID
  // (e.g., provider key 'legionio' or 'legionio_anthropic' → runtime 'legion').
  const rawCatalogEntry = config.models.catalog.find((m) => m.key === model.key);
  if (rawCatalogEntry) {
    const providerKey = rawCatalogEntry.provider;
    // Check each available runtime to see if the provider key indicates plugin ownership
    for (const runtimeId of available) {
      // Skip built-in runtimes — they don't own provider keys
      if (runtimeId === 'mastra' || runtimeId === 'claude-agent-sdk' || runtimeId === 'codex-sdk') continue;
      // Match: provider key starts with the plugin runtime ID (e.g., 'legionio' starts with 'legion')
      if (providerKey.startsWith(runtimeId) || runtimeId.startsWith(providerKey.split('_')[0])) {
        return { runtimeId };
      }
    }
  }

  switch (providerType) {
    case 'anthropic':
    case 'amazon-bedrock': {
      // Native Claude Code compatibility
      if (available.has('claude-agent-sdk')) {
        return {
          runtimeId: 'claude-agent-sdk',
          claudeAuth: extractClaudeAuth(model),
        };
      }
      return { runtimeId: 'mastra' };
    }

    case 'openai-compatible': {
      // Check if the same model is available under an Anthropic/Bedrock provider
      const crossRef = crossReferenceAnthropicProvider(model.modelConfig.modelName, config);
      if (crossRef && available.has('claude-agent-sdk')) {
        return {
          runtimeId: 'claude-agent-sdk',
          claudeAuth: crossRef,
        };
      }
      // Genuinely non-Claude model — use Codex (native OpenAI) or Mastra (universal)
      if (available.has('codex-sdk')) {
        return { runtimeId: 'codex-sdk' };
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
  // Runtime not available — fall back to Mastra with no warning (existing behavior)
  if (!available.has(preferred)) {
    return { runtimeId: 'mastra' };
  }

  // No model info — just use the preferred runtime
  if (!model || !providerType) {
    return { runtimeId: preferred };
  }

  switch (preferred) {
    case 'claude-agent-sdk': {
      if (providerType === 'anthropic' || providerType === 'amazon-bedrock') {
        return {
          runtimeId: 'claude-agent-sdk',
          claudeAuth: extractClaudeAuth(model),
        };
      }
      // OpenAI model — try cross-reference
      if (providerType === 'openai-compatible') {
        const crossRef = crossReferenceAnthropicProvider(model.modelConfig.modelName, config);
        if (crossRef) {
          return {
            runtimeId: 'claude-agent-sdk',
            claudeAuth: crossRef,
          };
        }
      }
      // Incompatible
      return {
        runtimeId: 'claude-agent-sdk',
        warning: `The selected model (${model.displayName}) is from ${providerTypeLabel(providerType)} provider, which is not supported by the Claude Code runtime. Switch to Auto runtime in Settings → Agent Runtime, or select a model from an Anthropic provider.`,
      };
    }

    case 'codex-sdk': {
      if (providerType === 'openai-compatible') {
        return { runtimeId: 'codex-sdk' };
      }
      // Incompatible
      return {
        runtimeId: 'codex-sdk',
        warning: `The selected model (${model.displayName}) is from ${providerTypeLabel(providerType)} provider, which is not supported by the Codex runtime. Switch to Auto runtime in Settings → Agent Runtime, or select a model from an OpenAI-compatible provider.`,
      };
    }

    case 'mastra':
    default:
      // If this is a known plugin runtime (not a built-in), pass it through directly.
      // Plugin runtimes handle their own model routing via the inference provider.
      if (preferred !== 'mastra' && available.has(preferred)) {
        return { runtimeId: preferred };
      }
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
function extractClaudeAuth(model: ModelCatalogEntry): ClaudeAuth {
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
function crossReferenceAnthropicProvider(
  modelName: string,
  config: AppConfig,
): ClaudeAuth | null {
  const catalog = resolveModelCatalog(config);

  for (const entry of catalog.entries) {
    if (
      entry.modelConfig.modelName === modelName &&
      (entry.modelConfig.provider === 'anthropic' || entry.modelConfig.provider === 'amazon-bedrock')
    ) {
      return {
        modelName: entry.modelConfig.modelName,
        baseUrl: stripV1Suffix(entry.modelConfig.endpoint),
        apiKey: entry.modelConfig.apiKey,
      };
    }
  }

  return null;
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
    case 'openai-compatible': return 'an OpenAI-compatible';
    case 'anthropic': return 'an Anthropic';
    case 'amazon-bedrock': return 'an Amazon Bedrock';
    case 'google': return 'a Google';
    default: return `a ${type}`;
  }
}

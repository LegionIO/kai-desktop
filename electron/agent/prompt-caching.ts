import type { LLMModelConfig } from './model-catalog.js';
import type { PromptCachingConfig } from '../config/schema.js';

type MessageLike = {
  role?: string;
  content?: unknown;
  providerOptions?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

/** True when the model is Anthropic-direct or a Claude model on Bedrock. */
export function isAnthropicFamily(modelConfig: Pick<LLMModelConfig, 'provider' | 'modelName'>): boolean {
  return (
    modelConfig.provider === 'anthropic' ||
    (modelConfig.provider === 'amazon-bedrock' && /anthropic|claude/i.test(modelConfig.modelName))
  );
}

/**
 * Resolve the effective prompt-caching config for a model, applying provider
 * defaults when the catalog entry has no explicit `promptCaching` override.
 *
 * Defaults:
 * - Anthropic (direct + Bedrock Claude): enabled
 * - OpenAI-compatible: enabled=false (server handles caching automatically for
 *   prompts >1024 tokens; no request markers needed)
 * - Google: enabled=false (implicit context caching — TODO: explicit caching
 *   via `cachedContent` once the Gemini provider path lands)
 */
export function resolvePromptCaching(modelConfig: LLMModelConfig): PromptCachingConfig {
  if (modelConfig.promptCaching) return modelConfig.promptCaching;
  return { enabled: isAnthropicFamily(modelConfig) };
}

/**
 * Build the request-level Anthropic `cacheControl` provider option. The AI SDK
 * Anthropic provider maps this to a top-level `cache_control` on the Messages
 * API request, which activates Anthropic's automatic breakpoint placement
 * (system prompt, tool defs, and the trailing message are all covered without
 * manual per-part annotation).
 */
export function buildAnthropicCacheControl(
  modelConfig: LLMModelConfig,
): { type: 'ephemeral'; ttl?: '5m' | '1h' } | undefined {
  if (modelConfig.provider !== 'anthropic') return undefined;
  const caching = resolvePromptCaching(modelConfig);
  if (!caching.enabled) return undefined;
  return caching.ttl ? { type: 'ephemeral', ttl: caching.ttl } : { type: 'ephemeral' };
}

/**
 * Inject message-level cache markers for providers that don't support a
 * request-level cache flag. Currently only Bedrock Converse (`cachePoint`)
 * needs this — the AI SDK Bedrock adapter reads
 * `message.providerOptions.bedrock.cachePoint` and appends a cachePoint block
 * after that message's content.
 *
 * We mark the last message *before* the current user turn so the stable
 * conversation prefix (history + prior tool results) is cached across the
 * agentic loop. System prompt and tool definitions are not annotated here —
 * the Bedrock AI SDK adapter has no hook for tool-level cachePoints, and
 * Mastra owns the system message via `instructions`.
 */
export function applyPromptCachingToMessages(messages: unknown[], modelConfig: LLMModelConfig): unknown[] {
  const caching = resolvePromptCaching(modelConfig);
  if (!caching.enabled) return messages;

  // Anthropic-direct uses request-level cacheControl (see buildAnthropicCacheControl);
  // OpenAI caches automatically server-side; Google is implicit-only for now.
  if (modelConfig.provider !== 'amazon-bedrock') return messages;
  if (!isAnthropicFamily(modelConfig)) return messages;
  if (messages.length < 2) return messages;

  // Find the last message before the trailing user turn.
  let markIndex = messages.length - 1;
  while (markIndex > 0 && (messages[markIndex] as MessageLike | undefined)?.role === 'user') {
    markIndex -= 1;
  }
  const target = messages[markIndex] as MessageLike | undefined;
  if (!target || typeof target !== 'object') return messages;

  const next = messages.slice();
  next[markIndex] = {
    ...target,
    providerOptions: {
      ...(target.providerOptions ?? {}),
      bedrock: {
        ...(target.providerOptions?.bedrock ?? {}),
        cachePoint: { type: 'default' },
      },
    },
  };
  return next;
}

import type { ModelCatalogEntry } from './model-catalog.js';

/** Pattern that identifies Claude / Anthropic model names regardless of provider. */
const CLAUDE_MODEL_PATTERN = /claude|anthropic/i;

/** Pattern that identifies OpenAI GPT / o-series model names. */
const GPT_MODEL_PATTERN = /^(gpt|o[1-4]|chatgpt)/i;

/**
 * Resolves which agent backend key should be used for a given model catalog entry.
 *
 * When the entry's `agentBackend` is explicitly set (and not 'auto'), that value wins.
 * When 'auto' or unset, the backend is inferred from the model's provider/name:
 *   - Anthropic provider, or any provider with Claude/Anthropic model names → 'claude-code'
 *   - OpenAI-compatible with GPT/o-series model names → 'codex'
 *   - Everything else → 'mastra'
 */
export function resolveAgentBackendKey(entry: ModelCatalogEntry): string {
  const explicit = entry.agentBackend;
  if (explicit && explicit !== 'auto') return explicit;

  const { provider, modelName } = entry.modelConfig;

  // Anthropic direct
  if (provider === 'anthropic') return 'claude-code';

  // Claude models on any provider (Bedrock, OpenAI-compatible gateways, etc.)
  if (CLAUDE_MODEL_PATTERN.test(modelName)) return 'claude-code';

  // OpenAI-compatible with GPT / o-series / chatgpt model names
  if (provider === 'openai-compatible' && GPT_MODEL_PATTERN.test(modelName)) {
    return 'codex';
  }

  return 'mastra';
}

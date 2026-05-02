/**
 * Shared title generation logic used by both chat and task title generators.
 *
 * Supports plugin inference providers, Mastra Agent fallback, retry with backoff,
 * and configurable prompts/word limits for different use cases.
 */

import { resolveModelCatalog, resolveModelForThread, type ModelCatalogEntry } from './model-catalog.js';
import { createLanguageModelFromConfig } from './language-model.js';
import type { AppConfig } from '../config/schema.js';
import type { PluginInferenceProvider } from '../plugins/types.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface TitleGenerationOptions {
  /** System prompt instructing the model how to generate the title. */
  systemPrompt: string;
  /** Maximum number of words in the final title (default: 4). */
  maxWords?: number;
  /** Maximum character length of the final title (default: 80). */
  maxChars?: number;
  /** The user-facing input to generate a title from. */
  input: string;
  /** Resolved app config. */
  config: AppConfig;
  /** Optional model key to prefer (e.g. the thread's model). */
  modelKey?: string | null;
  /** Optional plugin inference provider (tried first before Mastra fallback). */
  inferenceProvider?: PluginInferenceProvider | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the best model for title generation — prefers Haiku for speed,
 * falls back to the thread's model or catalog default.
 */
export function resolveTitleModel(
  config: AppConfig,
  threadModelKey: string | null,
): ModelCatalogEntry | null {
  const catalog = resolveModelCatalog(config);
  const threadEntry = resolveModelForThread(config, threadModelKey);

  const matchingHaiku = catalog.entries.find((entry) => {
    const modelName = entry.modelConfig.modelName.toLowerCase();
    return modelName.includes('haiku');
  });

  if (matchingHaiku) return matchingHaiku;
  return threadEntry;
}

/**
 * Clean up a raw title string — strip quotes, prefixes, and cap length.
 */
export function normalizeGeneratedTitle(
  rawTitle: string | null,
  maxWords = 4,
  maxChars = 80,
): string | null {
  if (!rawTitle) return null;

  const cleaned = rawTitle
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^(title|summary)\s*:\s*/i, '')
    .replace(/\s+/g, ' ');

  if (!cleaned) return null;

  return cleaned
    .split(/\s+/)
    .slice(0, maxWords)
    .join(' ')
    .slice(0, maxChars);
}

/**
 * Check whether an error is a transient provider issue worth retrying.
 */
export function isRetryableTitleGenerationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const maybeError = error as { statusCode?: number; isRetryable?: boolean; data?: { message?: string } };
  if (maybeError.statusCode === 503 || maybeError.isRetryable === true) return true;
  // Catch generic "unable to process" messages from gateways/providers
  const msg = maybeError.data?.message?.toLowerCase() ?? '';
  return msg.includes('unable to process') || msg.includes('service unavailable');
}

// ── Main entry point ─────────────────────────────────────────────────────

/**
 * Generate a short title from the given input text.
 *
 * Tries the plugin inference provider first (if available), then falls back
 * to a Mastra Agent with retry logic on transient errors.
 */
export async function generateTitle(opts: TitleGenerationOptions): Promise<string | null> {
  const { systemPrompt, input, config, inferenceProvider } = opts;
  const maxWords = opts.maxWords ?? 4;
  const maxChars = opts.maxChars ?? 80;

  if (!input) return null;

  const modelEntry = resolveTitleModel(config, opts.modelKey ?? null);
  if (!modelEntry) return null;

  // ── Try plugin inference provider first ──────────────────────────────
  if (inferenceProvider) {
    try {
      let titleText = '';
      const providerStream = inferenceProvider.stream({
        conversationId: `title-gen-${Date.now()}`,
        messages: [{ role: 'user', content: input }],
        modelKey: modelEntry.key,
        systemPrompt,
        abortSignal: undefined,
      });

      for await (const event of providerStream) {
        if (event.type === 'text-delta' && event.text) {
          titleText += event.text;
        }
        if (event.type === 'done' || event.type === 'error') break;
      }

      const title = normalizeGeneratedTitle(titleText, maxWords, maxChars);
      if (title) return title;
    } catch (error) {
      console.warn('[TitleGen] Plugin inference provider failed, falling back to Mastra:', error);
    }
  }

  // ── Mastra Agent fallback with retry ────────────────────────────────
  try {
    const { Agent } = await import('@mastra/core/agent');
    const model = await createLanguageModelFromConfig(modelEntry.modelConfig);
    type AgentConfig = ConstructorParameters<typeof Agent>[0];

    const agent = new Agent({
      id: `title-gen-${Date.now()}`,
      name: 'title-generator',
      instructions: systemPrompt,
      model: model as AgentConfig['model'],
    });

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await agent.generate(input, { maxSteps: 1 });
        const rawTitle = typeof result.text === 'string' ? result.text : null;
        return normalizeGeneratedTitle(rawTitle, maxWords, maxChars);
      } catch (error) {
        lastError = error;
        if (!isRetryableTitleGenerationError(error) || attempt === 2) {
          throw error;
        }
        await sleep(600 * (attempt + 1));
      }
    }

    throw lastError;
  } catch (error) {
    if (isRetryableTitleGenerationError(error)) {
      console.warn('[TitleGen] Skipped after retryable provider error.');
    } else {
      console.error('[TitleGen] Title generation failed:', error);
    }
    return null;
  }
}

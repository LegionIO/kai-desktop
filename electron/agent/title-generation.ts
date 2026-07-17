/**
 * Shared title generation logic used by both chat and task title generators.
 *
 * Makes a direct language model call — bypasses all runtimes entirely.
 * Title generation is a simple single-turn completion; it doesn't need
 * tools, memory, or streaming.
 *
 * Fallback order: haiku-class model → thread model → first catalog entry.
 */

import { resolveModelCatalog, resolveModelForThread, type ModelCatalogEntry } from './model-catalog.js';
import { runWithModelFallback, resolveAuxModelChain } from './generate-fallback.js';
import type { AppConfig } from '../config/schema.js';
import { generateText } from 'ai';
import { stripDisplayUnsafeChars } from './display-safe.js';

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
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Resolve the best model for title generation.
 *
 * Priority: haiku-class model → thread model → first catalog entry.
 */
export function resolveTitleModel(config: AppConfig, threadModelKey: string | null): ModelCatalogEntry | null {
  const catalog = resolveModelCatalog(config);

  const haiku = catalog.entries.find((e) => e.modelConfig.modelName.toLowerCase().includes('haiku'));
  if (haiku) return haiku;

  const threadEntry = resolveModelForThread(config, threadModelKey);
  if (threadEntry) return threadEntry;

  return catalog.entries[0] ?? null;
}

/**
 * Clean up a raw title string — strip quotes, prefixes, and cap length.
 */
export function normalizeGeneratedTitle(rawTitle: string | null, maxWords = 4, maxChars = 80): string | null {
  if (!rawTitle) return null;
  // Guard against non-positive / non-finite limits (would yield an empty title).
  const words = Number.isFinite(maxWords) && maxWords > 0 ? Math.floor(maxWords) : 4;
  const chars = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 80;

  const cleaned = stripDisplayUnsafeChars(rawTitle.trim())
    .replace(/^["']|["']$/g, '')
    .replace(/^(title|summary)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;

  const clipped = cleaned.split(/\s+/).slice(0, words).join(' ');
  // Truncate by CODE POINT, not UTF-16 unit, so an emoji/surrogate pair at the
  // boundary isn't split into a lone surrogate (which renders as �).
  const cp = Array.from(clipped);
  const truncated = (cp.length > chars ? cp.slice(0, chars).join('') : clipped).trim();
  return truncated || null;
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
 * Calls the language model directly via the Vercel AI SDK — no runtime,
 * no inference provider, no memory, no tools. Works identically regardless
 * of which agent runtime is active for the conversation.
 */
export async function generateTitle(opts: TitleGenerationOptions): Promise<string | null> {
  const { systemPrompt, input, config } = opts;
  const maxWords = opts.maxWords ?? 4;
  const maxChars = opts.maxChars ?? 80;

  if (!input) return null;

  const modelEntry = resolveTitleModel(config, opts.modelKey ?? null);
  if (!modelEntry) return null;

  // Title model as primary, then the configured fallback chain (deduped) so a
  // transient provider blip on the title model falls over instead of skipping.
  const chain = [modelEntry, ...resolveAuxModelChain(config, { modelKey: opts.modelKey ?? null })].filter(
    (e, i, arr) => arr.findIndex((x) => x.key === e.key) === i,
  );

  try {
    const result = await runWithModelFallback(
      chain,
      (model) =>
        generateText({
          model,
          system: systemPrompt,
          prompt: input,
          maxOutputTokens: 30,
        }),
      { maxRetriesPerModel: 2, label: 'title-gen' },
    );
    const rawTitle = typeof result.text === 'string' ? result.text : null;
    return normalizeGeneratedTitle(rawTitle, maxWords, maxChars);
  } catch (error) {
    if (isRetryableTitleGenerationError(error)) {
      console.warn('[TitleGen] Skipped after retryable provider error.');
    } else {
      console.error('[TitleGen] Title generation failed:', error);
    }
    return null;
  }
}

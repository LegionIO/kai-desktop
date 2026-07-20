/**
 * Model-fallback for auxiliary (non-primary-turn) LLM calls — title generation,
 * review scoring, task analysis, compaction, etc. These historically either
 * hardcoded a single provider/model (ignoring the user's config) or tried a
 * single configured model with no fallback. This helper gives them the same
 * resilience the primary agent turn has: try a chain of models, retrying a
 * transient error on the same model then advancing to the next.
 *
 * Deliberately small: aux calls don't stream, don't carry tools, and degrade
 * gracefully in their callers (title → null, scoring → heuristic). The helper
 * only changes HOW the underlying model call is attempted.
 */
import type { LanguageModel } from 'ai';
import { generateText } from 'ai';
import type { AppConfig } from '../config/schema.js';
import { classifyError, calculateDelay, isSameModelRetryable } from './retry.js';
import { createLanguageModelFromConfig } from './language-model.js';
import { resolveStreamConfig, type ModelCatalogEntry } from './model-catalog.js';

/**
 * Read the ambient app config WITHOUT importing `../ipc/config.js` at module
 * load — that module transitively pulls the child_process/shell-env graph, which
 * breaks unit tests of unrelated modules (e.g. dictation-manager) that import
 * this helper but partially mock node:child_process. Lazy dynamic import keeps
 * generate-fallback.ts cheap to import.
 */
export async function readAmbientConfig(): Promise<AppConfig | null> {
  try {
    const [{ readEffectiveConfig }, { getAppHome }] = await Promise.all([
      import('../ipc/config.js'),
      import('../local-bridge/paths.js'),
    ]);
    return readEffectiveConfig(getAppHome());
  } catch {
    return null;
  }
}

/**
 * Build the model chain (primary + fallbacks) for an auxiliary call from the
 * app config. Falls back through the profile chain when a profile is active,
 * else the resolved model + the profile's/global fallbacks. Returns [] when no
 * model resolves (caller should skip its LLM step).
 */
export function resolveAuxModelChain(
  config: AppConfig,
  opts?: { modelKey?: string | null; profileKey?: string | null },
): ModelCatalogEntry[] {
  const streamConfig = resolveStreamConfig(config, {
    threadModelKey: opts?.modelKey ?? null,
    threadProfileKey: opts?.profileKey ?? null,
    fallbackEnabled: true,
  });
  if (!streamConfig?.primaryModel) return [];
  return [streamConfig.primaryModel, ...streamConfig.fallbackModels];
}

/**
 * Build a chain whose PRIMARY is a specific already-resolved `LLMModelConfig`
 * (e.g. a caller that was handed a modelConfig, like compaction), followed by
 * the configured fallback chain (deduped by modelName). `config` is required
 * (callers in an async context should pass `await readAmbientConfig()`); when
 * omitted this returns primary-only.
 */
export function auxChainWithPrimary(
  primary: ModelCatalogEntry['modelConfig'],
  opts?: { config?: AppConfig },
): ModelCatalogEntry[] {
  const primaryEntry: ModelCatalogEntry = {
    key: `__aux_primary__:${primary.modelName}`,
    displayName: primary.modelName,
    modelConfig: primary,
  } as ModelCatalogEntry;
  if (!opts?.config) return [primaryEntry];
  // Dedupe only TRULY EQUIVALENT connections. Two entries with the same
  // provider/endpoint/model can still be distinct availability fallbacks when
  // they differ by API key, Azure deployment, Bedrock region/profile/role, or
  // API version — keep those. Key on the full connection tuple.
  const identity = (c: ModelCatalogEntry['modelConfig']): string => {
    const x = c as {
      endpoint?: string;
      apiKey?: string;
      apiVersion?: string;
      deploymentName?: string;
      region?: string;
      accessKeyId?: string;
      awsProfile?: string;
      roleArn?: string;
    };
    return [
      c.provider,
      x.endpoint ?? '',
      c.modelName,
      x.deploymentName ?? '',
      x.apiVersion ?? '',
      x.region ?? '',
      x.awsProfile ?? '',
      x.roleArn ?? '',
      x.accessKeyId ?? '',
      x.apiKey ?? '',
    ].join('|');
  };
  const primaryId = identity(primary);
  const rest = resolveAuxModelChain(opts.config).filter((e) => identity(e.modelConfig) !== primaryId);
  return [primaryEntry, ...rest];
}

export type AuxFallbackOpts = {
  /** Same-model retries on a transient error before advancing (default 1). */
  maxRetriesPerModel?: number;
  abortSignal?: AbortSignal;
  /** Notified when advancing from one model to the next (telemetry/logging). */
  onFallback?: (fromKey: string, toKey: string, error: string) => void;
  /** Short label for logs. */
  label?: string;
};

/** Sleep for `ms`, resolving early to `true` if `signal` aborts (else `false`). */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `fn(model)` against each entry in `chain`, retrying a transient error on
 * the same model up to `maxRetriesPerModel`, then advancing to the next entry.
 * A non-transient error throws immediately (the caller's own catch handles
 * graceful degradation). A user abort throws without further attempts. Throws
 * the last error if the whole chain is exhausted.
 */
export async function runWithModelFallback<T>(
  chain: ModelCatalogEntry[],
  fn: (model: LanguageModel, entry: ModelCatalogEntry) => Promise<T>,
  opts?: AuxFallbackOpts,
): Promise<T> {
  if (chain.length === 0) throw new Error('runWithModelFallback: empty model chain');
  const maxRetries = Math.max(0, opts?.maxRetriesPerModel ?? 1);
  let lastError: unknown = new Error('runWithModelFallback: no attempt ran');

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    let model: LanguageModel;
    try {
      model = await createLanguageModelFromConfig(entry.modelConfig);
    } catch (err) {
      // Can't even construct this model (bad provider config) — treat like a
      // failed attempt and try the next entry.
      lastError = err;
      if (i < chain.length - 1) {
        opts?.onFallback?.(entry.key, chain[i + 1].key, err instanceof Error ? err.message : String(err));
      }
      continue;
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (opts?.abortSignal?.aborted) throw new Error('aborted');
      try {
        return await fn(model, entry);
      } catch (error) {
        lastError = error;
        if (opts?.abortSignal?.aborted) throw error;
        const info = classifyError(error);
        // Retry the SAME model while retries remain — after an (abortable)
        // backoff so a brief 429/503/Retry-After outage can clear instead of
        // burning all retries instantly. Quota (402) is NOT same-model-retryable
        // (retrying a depleted account can't help) — it falls straight through.
        if (isSameModelRetryable(info) && attempt < maxRetries) {
          const delay = calculateDelay(attempt, info, 500, 8000);
          if (delay > 0) {
            const aborted = await abortableSleep(delay, opts?.abortSignal);
            if (aborted) throw error;
          }
          continue;
        }
        // Transient but out of same-model retries → advance to the next model.
        // Non-transient → do NOT fall back (it'd fail the same way); rethrow.
        if (info.isTransient && i < chain.length - 1) {
          opts?.onFallback?.(entry.key, chain[i + 1].key, error instanceof Error ? error.message : String(error));
          break;
        }
        throw error;
      }
    }
  }
  throw lastError;
}

type GenerateTextArgs = Omit<Parameters<typeof generateText>[0], 'model'>;

/**
 * Convenience wrapper for config-less auxiliary utilities (task scoring,
 * unblock assessment, reviewer selection, completion summary, …). Resolves the
 * configured default model + fallback chain from the ambient app config and
 * runs `generateText` across it with transient-error fallback.
 *
 * Returns `{ text }` on success, or `null` when no model is configured (the
 * caller degrades gracefully, exactly as the old `if (!ANTHROPIC_API_KEY)`
 * guards did — but now provider-agnostic and with fallback).
 */
export async function auxGenerateText(
  build: GenerateTextArgs,
  opts?: AuxFallbackOpts & { config?: AppConfig; modelKey?: string | null; profileKey?: string | null },
): Promise<{ text: string } | null> {
  const config = opts?.config ?? (await readAmbientConfig());
  if (!config) return null;
  const chain = resolveAuxModelChain(config, { modelKey: opts?.modelKey, profileKey: opts?.profileKey });
  if (chain.length === 0) return null;
  const result = await runWithModelFallback(
    chain,
    async (model) =>
      generateText({
        ...build,
        model,
        // Forward the abort signal into the provider request so an in-flight
        // call is actually cancelled at the deadline (not just between attempts).
        ...(opts?.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      } as Parameters<typeof generateText>[0]),
    opts,
  );
  return { text: typeof result.text === 'string' ? result.text : '' };
}

/**
 * Fallback wrapper for Mastra `Agent.generate` aux calls (compaction, tool
 * observer, runtime-switch summary, prompt synthesis, realtime tool
 * compaction). The Agent binds a single model, so we rebuild it per model
 * inside the chain loop via `buildAgent(model)`. Returns the generate result's
 * text, or null when no model is configured (caller degrades gracefully).
 */
export async function auxAgentGenerate(
  buildAgent: (model: LanguageModel) => { generate: (prompt: string, opts?: unknown) => Promise<{ text?: unknown }> },
  prompt: string,
  generateOpts?: unknown,
  opts?: AuxFallbackOpts & {
    config?: AppConfig;
    modelKey?: string | null;
    profileKey?: string | null;
    chain?: ModelCatalogEntry[];
    /** Primary = this concrete modelConfig, then ambient config fallbacks. */
    primaryModelConfig?: ModelCatalogEntry['modelConfig'];
  },
): Promise<{ text: string } | null> {
  let chain = opts?.chain;
  if (!chain && opts?.primaryModelConfig) {
    const config = opts?.config ?? (await readAmbientConfig());
    chain = auxChainWithPrimary(opts.primaryModelConfig, { config: config ?? undefined });
  }
  if (!chain) {
    const config = opts?.config ?? (await readAmbientConfig());
    if (!config) return null;
    chain = resolveAuxModelChain(config, { modelKey: opts?.modelKey, profileKey: opts?.profileKey });
  }
  if (chain.length === 0) return null;
  const result = await runWithModelFallback(
    chain,
    async (model) => buildAgent(model).generate(prompt, generateOpts),
    opts,
  );
  return { text: typeof result.text === 'string' ? result.text : '' };
}

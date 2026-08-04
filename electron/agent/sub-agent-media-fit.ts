/**
 * Shared budget-aware media fitter for sub-agent tool results.
 *
 * Both the INITIAL sub-agent runner (sub-agent-runner.ts) and the COMPLETED-agent
 * RESUME path (tools/sub-agent.ts) attach `_modelContent` media to tool results.
 * Sub-agents have no reactive overflow recovery, so a large image kept under the
 * downstream 5 MiB sanitizer limit can still overflow a small model's context
 * window. This factory gives both paths the SAME proactive fit (downscale/drop to
 * the remaining budget), with its own serialized accumulators so concurrent tool
 * results commit atomically.
 */
import { fitModelContentToBudget, stripBranchMediaForCount, type MediaFitConfig } from './media-fit.js';
import {
  resolveConversationTokenization,
  sumBranchTokensForGate,
  encodeCappedWith,
  encodeCappedWithAsync,
  serializeForTokenCounting,
} from './tokenization.js';
import { traceDiagnostic } from '../diagnostics/debug-trace.js';
import type { LLMModelConfig } from './model-catalog.js';

export type SubAgentMediaFitterOptions = {
  /** The `compaction.media` config (null/disabled → the fitter is a pass-through). */
  mediaConfig: MediaFitConfig | undefined;
  /** Models the turn may run on (primary + fallbacks when enabled); budget uses the
   *  tightest window/tokenizer across them. */
  eligibleModels: Array<{ modelConfig: LLMModelConfig }>;
  /** Optional context-window override (compaction.conversation.contextWindowTokens). */
  windowOverride: number | undefined;
  /** Static per-request input tokens (system prompt + tool schemas + allowance) for
   *  the INITIAL model. */
  staticInputTokens: number;
  /** Optional recompute of the static input for a DIFFERENT model — used on a
   *  cross-provider fallback (a Claude fallback tokenizes a GPT-primary's prompt/
   *  schemas differently). Called by reset(modelName). */
  computeStaticInputTokens?: (modelName: string) => number;
  /** The turn-initial branch, for the branch-token sum. */
  messages: unknown[];
  /** Optional accessor for the sub-agent's assistant text streamed BEFORE this tool
   *  call this turn — it goes to the next model step but isn't in the branch/args/
   *  results, so charge it against the budget (parity with the parent fitter). */
  getAccumulatedText?: () => string;
  /** Abort signal so a cancelled sub-agent turn stops doing sharp decodes mid-fit. */
  signal?: AbortSignal;
  /** For the drop diagnostic. */
  conversationId?: string;
};

/**
 * Returns `fit(result)`: serialized (mutex-chained) so concurrent tool results
 * read/commit the shared same-turn accumulators atomically. Mirrors the parent
 * turn's media budget (per-eligible-model min window − branch − committed − static
 * − reserve). A pass-through when media fitting is disabled.
 */
export type SubAgentMediaFitter = {
  /** Budget-fit a tool result's `_modelContent` media (mutex-serialized). */
  fit: (result: unknown, toolCallId?: string, args?: unknown) => Promise<unknown>;
  /** Charge a tool call's arguments against the same-turn budget once per id.
   *  Call at tool-execution START so a parallel call's media isn't fit before a
   *  sibling call's (large) args are counted. */
  chargeArgs: (toolCallId: string | undefined, args: unknown) => void;
  /** Re-charge the DELTA when a PreToolUse hook rewrote an already-charged call's
   *  args to a LARGER payload — the initial chargeArgs reflected the pre-rewrite
   *  args, and under-charging would retain near-budget media that then overflows. */
  rechargeArgs: (toolCallId: string | undefined, newArgs: unknown) => void;
  /** Reset the same-turn committed accumulators + charged-arg ids. Call on a
   *  sub-agent model-fallback: streamWithFallback restarts the next model from the
   *  original messages, so the discarded attempt's charges are phantom context.
   *  Pass the fallback model ENTRY to also (a) recompute the static-input estimate
   *  under its tokenizer and (b) narrow the fit window to it (the now-active model). */
  reset: (fallbackModel?: { modelConfig: LLMModelConfig }) => void;
};

export function createSubAgentMediaFitter(opts: SubAgentMediaFitterOptions): SubAgentMediaFitter {
  const { mediaConfig, windowOverride, messages, conversationId, getAccumulatedText } = opts;
  // Fit against the CURRENTLY-ACTIVE model only (parity with the parent fitter):
  // fallback restarts from the original messages + reset() re-frees the budget, so
  // budgeting against the min of ALL eligible models would needlessly shrink media
  // that fits the active model when no fallback occurs. Mutable — reset() narrows it
  // to the fallback model. Seed with the FIRST eligible model (the primary).
  let eligibleModels: SubAgentMediaFitterOptions['eligibleModels'] = opts.eligibleModels.slice(0, 1);
  // Mutable so a cross-provider fallback can recompute it under the new tokenizer.
  let staticInputTokens = opts.staticInputTokens;
  let committedMediaTokens = 0;
  // Cumulative kept media BYTES this sub-agent turn — seeds fitModelContentToBudget so
  // its 12 MiB aggregate cap is per-TURN, not reset per result (see agent.ts).
  let committedMediaBytes = 0;
  let committedNonMediaTokens = 0;
  // Memoized EXACT branch-token count per canonical-tokenizer base. The sub-agent
  // `messages` are freshly built WITHOUT cached tokenCount, so sumBranchTokensForGate
  // would charge the UTF-8 byte ceiling (~4× over) for a recognized model — over-
  // shrinking media on a long branch. For a canonical (o200k) model, compute the
  // exact whole-branch count ONCE (branch is fixed per turn) and reuse it.
  const exactBranchTokensCache = new Map<string, number>();
  // Media-stripped projection of the branch + its native media token estimate,
  // computed ONCE (branch is fixed per turn). The sub-agent branch stores each tool
  // result's `_modelContent` base64 verbatim; counting that as TEXT over-counts a 1
  // MiB screenshot as ~1.4M tokens and wrongly drops new media. Strip media out of the
  // text sum and add the NATIVE estimate instead — parity with the parent turn.
  let strippedBranchMemo: { stripped: unknown[]; nativeMediaTokens: number; retainedMediaBytes: number } | null = null;
  const getStrippedBranch = async (): Promise<{ stripped: unknown[]; nativeMediaTokens: number; retainedMediaBytes: number }> => {
    if (!strippedBranchMemo) strippedBranchMemo = await stripBranchMediaForCount(messages as unknown[], opts.signal);
    return strippedBranchMemo;
  };
  // Tool-call arguments generated this turn also go to the next model step
  // (assistant tool-call message); count them once per id (bytes as a conservative
  // token proxy) so a large argument followed by an image doesn't retain media that
  // overflows a small model.
  const committedArgIds = new Set<string>();
  // Bytes charged per id so a PreToolUse hook that ENLARGES args can be re-charged by
  // delta (same as the parent turn — under-charging retains near-budget media that
  // then overflows a small model).
  const chargedArgBytesById = new Map<string, number>();
  let chain: Promise<unknown> = Promise.resolve();

  const argBytesOf = (args: unknown): number => {
    if (args === undefined) return 0;
    try {
      return Buffer.byteLength(JSON.stringify(args) ?? '', 'utf8');
    } catch {
      return 0;
    }
  };

  const chargeArgs = (toolCallId: string | undefined, args: unknown): void => {
    if (!toolCallId || committedArgIds.has(toolCallId) || args === undefined) return;
    committedArgIds.add(toolCallId);
    const bytes = argBytesOf(args);
    chargedArgBytesById.set(toolCallId, bytes);
    committedNonMediaTokens += bytes;
  };

  // Re-charge the DELTA when a PreToolUse hook rewrote an already-charged call's args.
  const rechargeArgs = (toolCallId: string | undefined, newArgs: unknown): void => {
    if (!toolCallId || !committedArgIds.has(toolCallId)) return;
    const prev = chargedArgBytesById.get(toolCallId) ?? 0;
    const next = argBytesOf(newArgs);
    if (next > prev) {
      committedNonMediaTokens += next - prev;
      chargedArgBytesById.set(toolCallId, next);
    }
  };

  const inner = async (result: unknown, toolCallId?: string, args?: unknown): Promise<unknown> => {
    if (!mediaConfig?.enabled) return result;
    // Fallback (idempotent) — primary charge is at execution START via chargeArgs.
    chargeArgs(toolCallId, args);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      // Account for non-media (string/array) output too (same-turn budget).
      if (typeof result === 'string') committedNonMediaTokens += Buffer.byteLength(result, 'utf8');
      else if (Array.isArray(result)) {
        try {
          committedNonMediaTokens += Buffer.byteLength(JSON.stringify(result) ?? '', 'utf8');
        } catch {
          /* skip */
        }
      }
      return result;
    }
    const obj = result as Record<string, unknown>;
    const parts = obj._modelContent;
    if (!Array.isArray(parts) || parts.length === 0) {
      try {
        committedNonMediaTokens += Buffer.byteLength(JSON.stringify(obj) ?? '', 'utf8');
      } catch {
        /* skip */
      }
      return result;
    }
    // Remaining budget: min over eligible models (tightest window/tokenizer).
    // Count the MEDIA-STRIPPED branch as text and ADD the native media estimate — the
    // raw branch stores tool-result base64 verbatim, which would count a screenshot as
    // ~1.4M text tokens and wrongly drop new media.
    const {
      stripped: strippedBranch,
      nativeMediaTokens: branchNativeMediaTokens,
      retainedMediaBytes: branchRetainedMediaBytes,
    } = await getStrippedBranch();
    let remaining = Infinity;
    for (const entry of eligibleModels) {
      const t = resolveConversationTokenization(
        entry.modelConfig.modelName,
        windowOverride ?? entry.modelConfig.maxInputTokens,
      );
      if (!t.contextWindowTokens) continue;
      // Prefer the EXACT count for a recognized (non-fallback) encoder — the sub-
      // agent branch has no cached tokenCount, so sumBranchTokensForGate would use
      // the ~4×-inflated byte ceiling. Cache per encoder base (branch is fixed).
      let branchTokens: number;
      if (t.encoding && !t.isFallbackEncoding) {
        const key = t.encodingBaseName ?? entry.modelConfig.modelName;
        let cached = exactBranchTokensCache.get(key);
        if (cached === undefined) {
          // Count OFF the main thread (worker-backed) so a long branch's tiktoken
          // encode doesn't stall Electron's event loop / IPC / streaming. Falls back to
          // the byte ceiling internally only above its sync cap. Cache the awaited result.
          const exact = await encodeCappedWithAsync(serializeForTokenCounting(strippedBranch), t, opts.signal);
          cached = exact + branchNativeMediaTokens;
          exactBranchTokensCache.set(key, cached);
        }
        branchTokens = cached;
      } else {
        branchTokens =
          sumBranchTokensForGate(strippedBranch as Parameters<typeof sumBranchTokensForGate>[0], t) +
          branchNativeMediaTokens;
      }
      const modelRemaining = t.contextWindowTokens - branchTokens;
      if (modelRemaining < remaining) remaining = modelRemaining;
    }
    if (!Number.isFinite(remaining)) return result;
    // Assistant text streamed before this tool call this turn is sent to the next
    // step but isn't in the branch/args/results — charge it (bytes as a conservative
    // proxy), parity with the parent fitter.
    let preToolTextBytes = 0;
    try {
      preToolTextBytes = Buffer.byteLength(getAccumulatedText?.() ?? '', 'utf8');
    } catch {
      /* skip */
    }
    remaining = Math.max(
      0,
      remaining -
        staticInputTokens -
        committedMediaTokens -
        committedNonMediaTokens -
        preToolTextBytes -
        Math.max(0, mediaConfig.reserveTokens),
    );
    // This result's own cleaned (non-media) text also goes to the model.
    try {
      const { _modelContent, ...rest } = obj;
      void _modelContent;
      const cleanedBytes = Buffer.byteLength(JSON.stringify(rest) ?? '', 'utf8');
      remaining = Math.max(0, remaining - cleanedBytes);
      committedNonMediaTokens += cleanedBytes;
    } catch {
      /* skip */
    }
    const fit = await fitModelContentToBudget(
      parts as Parameters<typeof fitModelContentToBudget>[0],
      remaining,
      mediaConfig,
      opts.signal,
      // Seed the whole-request ceiling with the sanitizer-RETAINED branch media bytes
      // (media the provider actually receives) + this turn's kept media (parity with
      // the parent turn), so a long sub-agent branch's accumulated media can't bloat
      // the provider request past the ceiling — without over-counting media the
      // sanitizer would drop.
      branchRetainedMediaBytes + committedMediaBytes,
    );
    committedMediaTokens += fit.keptTokens;
    committedMediaBytes += fit.keptMediaBytes;
    if (fit.dropped) {
      try {
        traceDiagnostic({
          scope: 'agent',
          event: 'subagent.media.dropped',
          level: 'warn',
          conversationId: conversationId ?? undefined,
          fields: { note: fit.note ?? '' },
        });
      } catch {
        /* best-effort diagnostic */
      }
    }
    return fit.changed ? { ...obj, _modelContent: fit.parts } : result;
  };

  const fit = (result: unknown, toolCallId?: string, args?: unknown): Promise<unknown> => {
    const run = chain.then(() => inner(result, toolCallId, args));
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const reset = (fallbackModel?: { modelConfig: LLMModelConfig }): void => {
    committedMediaTokens = 0;
    committedMediaBytes = 0;
    committedNonMediaTokens = 0;
    committedArgIds.clear();
    if (fallbackModel) {
      // Narrow the fit window to the now-active fallback model + recompute the
      // static estimate under its tokenizer.
      eligibleModels = [fallbackModel];
      if (opts.computeStaticInputTokens) {
        try {
          staticInputTokens = opts.computeStaticInputTokens(fallbackModel.modelConfig.modelName);
        } catch {
          /* keep prior estimate */
        }
      }
    }
  };

  return { fit, chargeArgs, rechargeArgs, reset };
}

/**
 * Shared token estimate for a sub-agent's static per-request input (system prompt
 * + tool schemas as z.toJSONSchema + a flat workspace/provider allowance). Returns
 * TOKENS via the model's EXACT tokenizer (o200k encode; UTF-8 byte ceiling when no
 * encoder is available — a true upper bound, never an under-count). `zToJSONSchema`
 * is injected so this module stays free of a direct zod import.
 */
export function estimateSubAgentStaticTokens(
  systemPrompt: string,
  tools: readonly unknown[],
  zToJSONSchema: (schema: unknown) => unknown,
  allowanceTokens: number,
  modelName?: string,
): number {
  let schemaText = '';
  try {
    const schemas = tools.map((t) => {
      const tool = t as { name?: unknown; description?: unknown; inputSchema?: unknown };
      let parameters: unknown = tool.inputSchema;
      try {
        if (tool.inputSchema) parameters = zToJSONSchema(tool.inputSchema);
      } catch {
        /* keep the raw schema reference */
      }
      return { name: tool.name, description: tool.description, parameters };
    });
    schemaText = JSON.stringify(schemas) ?? '';
  } catch {
    /* best-effort */
  }
  const text = `${systemPrompt ?? ''}\n${schemaText}`;
  let staticTokens: number;
  const tk = modelName ? resolveConversationTokenization(modelName) : undefined;
  if (tk?.encoding && !tk.isFallbackEncoding) {
    // CANONICAL (o200k) encoder → exact count.
    staticTokens = encodeCappedWith(text, tk.encoding);
  } else {
    // No encoder, OR only the FALLBACK encoder (Claude/Gemini/etc., which can
    // under-count the provider) → UTF-8 byte ceiling (a true upper bound).
    staticTokens = Buffer.byteLength(text, 'utf8');
  }
  return staticTokens + Math.max(0, allowanceTokens);
}

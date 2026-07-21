import { randomUUID } from 'crypto';
import {
  countBranchTokensCached,
  estimateSerializedTokens,
  resolveConversationTokenization,
  serializeForTokenCounting,
} from './tokenization.js';
import type { LLMModelConfig } from './model-catalog.js';
import { auxAgentGenerate } from './generate-fallback.js';
import { COMPACTION_SYSTEM_PROMPT } from './prompts.js';

export type ChatMessage = {
  id?: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | unknown[];
  tool_calls?: Array<{ id: string; [key: string]: unknown }>;
  tool_call_id?: string;
};

function extractToolCallIds(message: ChatMessage): Set<string> {
  const ids = new Set<string>();
  for (const tc of message.tool_calls ?? []) {
    if (tc.id) ids.add(tc.id);
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part.type === 'tool-call' && part.toolCallId) ids.add(part.toolCallId);
      if (part.type === 'tool-result' && part.toolCallId) ids.add(part.toolCallId);
    }
  }
  return ids;
}

/**
 * Tool-CALL ids this message ISSUES (assistant): legacy `tool_calls[].id` plus
 * content-part `{type:'tool-call', toolCallId}`. Excludes tool-RESULT parts (a
 * result references a call but doesn't issue one) — used to locate the call that
 * a retained result depends on.
 */
function extractCallIds(message: ChatMessage): Set<string> {
  const ids = new Set<string>();
  for (const tc of message.tool_calls ?? []) {
    if (tc.id) ids.add(tc.id);
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part.type === 'tool-call' && part.toolCallId) ids.add(part.toolCallId);
    }
  }
  return ids;
}

/**
 * Tool-RESULT ids this message CARRIES: legacy `{role:'tool', tool_call_id}` plus
 * content-part `{type:'tool-result', toolCallId}`. Used to detect a result whose
 * matching call would otherwise be compacted away, leaving an orphan result in
 * the kept suffix.
 */
function extractResultIds(message: ChatMessage): Set<string> {
  const ids = new Set<string>();
  if (message.role === 'tool' && message.tool_call_id) ids.add(message.tool_call_id);
  if (Array.isArray(message.content)) {
    for (const part of message.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part.type === 'tool-result' && part.toolCallId) ids.add(part.toolCallId);
    }
  }
  return ids;
}

export function selectProtectedTail(
  messages: ChatMessage[],
  ignoreRecentUser: number,
  ignoreRecentAssistant: number,
): { boundaryIndex: number; protectedIds: Set<number>; protectedToolCallIds: Set<string> } {
  const protectedIds = new Set<number>();
  const protectedToolCallIds = new Set<string>();
  let remainingUsers = Math.max(0, ignoreRecentUser);
  let remainingAssistants = Math.max(0, ignoreRecentAssistant);

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && remainingUsers > 0) {
      protectedIds.add(i);
      remainingUsers--;
    } else if (msg.role === 'assistant' && remainingAssistants > 0) {
      protectedIds.add(i);
      remainingAssistants--;
      for (const id of extractToolCallIds(msg)) protectedToolCallIds.add(id);
    } else if (remainingUsers <= 0 && remainingAssistants <= 0) break;
  }

  // Protect a tool-RESULT for any protected call — in BOTH shapes: the legacy
  // `{role:'tool', tool_call_id}` message AND the content-part
  // `{type:'tool-result', toolCallId}` form (which the earlier version missed).
  for (let i = 0; i < messages.length; i++) {
    for (const rid of extractResultIds(messages[i])) {
      if (protectedToolCallIds.has(rid)) {
        protectedIds.add(i);
        break;
      }
    }
  }

  let boundaryIndex = protectedIds.size > 0 ? Math.min(...protectedIds) : messages.length;

  // Pair-integrity across the boundary: a tool-RESULT kept in the suffix
  // (index >= boundaryIndex) whose matching CALL sits in the prefix (compacted
  // away) would leave an ORPHAN result with no call in the model context. This
  // is reachable when a result is positioned after the protected-tail boundary
  // but its call is older (e.g. plugin-mutated history with a standalone result).
  // Walk the suffix; for any result whose call index is before the boundary,
  // pull the boundary back to that call so the whole pair stays in the suffix.
  // Iterate to a fixed point (extending the boundary can expose earlier results).
  const callIndexById = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    for (const cid of extractCallIds(messages[i])) {
      if (!callIndexById.has(cid)) callIndexById.set(cid, i);
    }
  }
  for (;;) {
    let earliestCall = boundaryIndex;
    for (let i = boundaryIndex; i < messages.length; i++) {
      for (const rid of extractResultIds(messages[i])) {
        const callIdx = callIndexById.get(rid);
        if (callIdx !== undefined && callIdx < earliestCall) earliestCall = callIdx;
      }
    }
    if (earliestCall >= boundaryIndex) break; // no straddling pair — done
    boundaryIndex = earliestCall; // keep the call (and everything after) in the suffix
  }

  return { boundaryIndex, protectedIds, protectedToolCallIds };
}

export function shouldCompact(
  messages: ChatMessage[],
  modelName: string,
  triggerPercent: number,
  contextWindowOverride?: number,
): { shouldCompact: boolean; usedTokens: number; contextWindowTokens: number } {
  const tokenization = resolveConversationTokenization(modelName, contextWindowOverride);
  if (!tokenization.encoding || !tokenization.contextWindowTokens) {
    return { shouldCompact: false, usedTokens: 0, contextWindowTokens: 0 };
  }
  const triggerTokens = Math.floor(tokenization.contextWindowTokens * triggerPercent);

  // Cheap pre-check: an over-biased estimate from serialized length (no WASM).
  // Because the estimate is >= the true token count, if even it is below the
  // trigger the exact count must be too — skip tiktoken entirely. This is the
  // common case every turn on a normal-length chat and keeps the expensive
  // encode off the hot send path. Only when the estimate reaches the trigger do
  // we pay for the exact count (memoized per branch).
  const estimatedTokens = estimateSerializedTokens(messages);
  if (estimatedTokens < triggerTokens) {
    return {
      shouldCompact: false,
      // Report the estimate for context-usage telemetry; it's an upper bound.
      usedTokens: estimatedTokens,
      contextWindowTokens: tokenization.contextWindowTokens,
    };
  }

  const lastMessageId = messages.length > 0 ? messages[messages.length - 1]?.id : undefined;
  const usedTokens = countBranchTokensCached(messages, tokenization, lastMessageId) ?? 0;
  return {
    shouldCompact: usedTokens >= triggerTokens,
    usedTokens,
    contextWindowTokens: tokenization.contextWindowTokens,
  };
}

export type CompactionResult = {
  compactedMessages: ChatMessage[] | null;
  summaryText: string | null;
  compactionId: string | null;
  compactedMessageIds: string[];
};

/**
 * True if `ids` is an ordered prefix of `branchIds` (same values, same order,
 * starting at index 0). Used to decide whether a stored compaction record still
 * applies to the current active branch: after a fork/rewind/variant/edit the
 * leading message ids change, the prefix check fails, and the caller recomputes
 * instead of reusing a stale summary. Fail-safe: any mismatch ⇒ false ⇒ recompute.
 */
export function isStrictPrefix(ids: readonly string[], branchIds: readonly string[]): boolean {
  if (ids.length === 0 || ids.length > branchIds.length) return false;
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== branchIds[i]) return false;
  }
  return true;
}

export async function compactConversationPrefix(
  messages: ChatMessage[],
  modelConfig: LLMModelConfig,
  config: {
    triggerPercent: number;
    ignoreRecentUserMessages: number;
    ignoreRecentAssistantMessages: number;
    outputMaxTokens: number;
    promptReserveTokens: number;
    contextWindowTokens?: number;
  },
): Promise<CompactionResult> {
  const tokenization = resolveConversationTokenization(
    modelConfig.modelName,
    config.contextWindowTokens ?? modelConfig.maxInputTokens,
  );

  if (!tokenization.encoding || !tokenization.contextWindowTokens) {
    return { compactedMessages: null, summaryText: null, compactionId: null, compactedMessageIds: [] };
  }

  const { boundaryIndex } = selectProtectedTail(
    messages,
    config.ignoreRecentUserMessages,
    config.ignoreRecentAssistantMessages,
  );

  const prefix = messages.slice(0, boundaryIndex);
  const suffix = messages.slice(boundaryIndex);
  if (prefix.length === 0) {
    return { compactedMessages: null, summaryText: null, compactionId: null, compactedMessageIds: [] };
  }

  // Budget the compaction prompt input to avoid exceeding the context window.
  // Mirrors maelstrom-agent: contextWindow - outputMaxTokens - promptReserveTokens
  const promptInputBudget = Math.floor(
    tokenization.contextWindowTokens - Math.max(0, config.outputMaxTokens) - Math.max(0, config.promptReserveTokens),
  );
  if (promptInputBudget <= 0) {
    return { compactedMessages: null, summaryText: null, compactionId: null, compactedMessageIds: [] };
  }

  // Fit prefix to the input budget by dropping oldest messages until it fits.
  // If we would have to DROP any prefix message to fit, fail safe: a dropped
  // message is neither summarized nor kept, so it would be silently lost from
  // the conversation. Returning a null result leaves the history uncompacted
  // (the turn proceeds on the full context) rather than losing content.
  const fittedPrefix = [...prefix];
  let droppedForBudget = false;
  while (fittedPrefix.length > 0) {
    const candidatePromptText = serializeForTokenCounting(fittedPrefix);
    const candidateTokens = tokenization.encoding.encode(candidatePromptText).length;
    if (candidateTokens <= promptInputBudget) break;
    fittedPrefix.shift();
    droppedForBudget = true;
  }

  if (fittedPrefix.length === 0 || droppedForBudget) {
    return { compactedMessages: null, summaryText: null, compactionId: null, compactedMessageIds: [] };
  }

  // Generate summary
  const { Agent } = await import('@mastra/core/agent');
  type AgentConfig = ConstructorParameters<typeof Agent>[0];

  const prompt = [
    'Summarize the conversation prefix for future continuation.',
    'Keep durable constraints, decisions, requirements, unresolved TODOs, IDs, names, and references.',
    '',
    'Conversation prefix (JSON):',
    serializeForTokenCounting(fittedPrefix),
  ].join('\n');

  // Fail safe if the summarizer LLM call throws (network/API error): compaction
  // is best-effort and runs mid-turn, so an uncaught throw here would fail the
  // whole user turn. Return a null result to keep the uncompacted history and
  // let the turn proceed (mirrors aiExtractRelevantInfo's try/catch contract).
  let summaryText: string | null = null;
  try {
    const gen = await auxAgentGenerate(
      (model) =>
        new Agent({
          id: `compaction-${Date.now()}`,
          name: 'compaction-agent',
          instructions: COMPACTION_SYSTEM_PROMPT,
          model: model as AgentConfig['model'],
        }),
      prompt,
      { maxSteps: 1 },
      { primaryModelConfig: modelConfig, label: 'compaction' },
    );
    summaryText = gen ? gen.text.trim() || null : null;
  } catch (err) {
    console.warn('[compaction] Summarizer generate failed — skipping compaction for this turn:', err);
    return { compactedMessages: null, summaryText: null, compactionId: null, compactedMessageIds: [] };
  }
  if (!summaryText) {
    return { compactedMessages: null, summaryText: null, compactionId: null, compactedMessageIds: [] };
  }

  // Enforce outputMaxTokens on the generated summary. The prompt budget reserves
  // outputMaxTokens for the summary but nothing constrained the model's actual
  // output, so a runaway summary could push the compacted request back over the
  // context window. Bound it with the same head/tail truncator used for tool
  // results (a summary is prose, so headRatio favors the front where the durable
  // constraints/decisions live).
  if (config.outputMaxTokens > 0) {
    summaryText = truncateToTokenBudget(
      summaryText,
      config.outputMaxTokens,
      { minChars: 200, headRatio: 0.7, minTailChars: 200 },
      modelConfig.modelName,
    );
  }

  const compactionId = randomUUID();
  const summaryMessage: ChatMessage = {
    id: `compaction-summary-${compactionId}`,
    role: 'assistant',
    content: summaryText,
  };

  // Only the messages actually included in the summary (fittedPrefix) are
  // represented in it. Messages shifted out to fit the budget are NOT summarized,
  // so don't report them as compacted — mislabeling them as preserved hides
  // real context loss from callers/telemetry.
  //
  // For REUSE, compactedMessageIds.length is used as the count of prefix messages
  // the summary replaces (messages.slice(length)). That's only correct if EVERY
  // fittedPrefix message has a stable id — otherwise a filtered-out id-less message
  // would make the count too short and a later reuse would reintroduce an
  // already-summarized message. So require a complete 1:1 id mapping; if any
  // prefix message lacks an id, emit an EMPTY compactedMessageIds (the record is
  // then non-reusable — isStrictPrefix([]) is false — and the turn still gets the
  // in-memory compaction, just no persisted reuse).
  const fittedPrefixIds = fittedPrefix
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const compactedMessageIds = fittedPrefixIds.length === fittedPrefix.length ? fittedPrefixIds : [];

  const compactedMessages: ChatMessage[] = [summaryMessage, ...suffix];

  // Final safety: verify the compacted request actually fits the input budget.
  // Even a bounded summary plus the suffix could exceed promptInputBudget if the
  // suffix is large; shipping an over-budget request would defeat the point (and
  // risk a provider hard-limit error). If it still doesn't fit, return the null
  // no-op — the turn proceeds on the full (uncompacted) context, preserving the
  // "null ⇒ no message loss" contract.
  const compactedTokens = tokenization.encoding.encode(serializeForTokenCounting(compactedMessages)).length;
  if (compactedTokens > promptInputBudget) {
    return { compactedMessages: null, summaryText: null, compactionId: null, compactedMessageIds: [] };
  }

  return {
    compactedMessages,
    summaryText,
    compactionId,
    compactedMessageIds,
  };
}

/* ── Tool Result Compaction ── */
/* Ported from maelstrom-agent/packages/agent-sdk/src/core/tool-extraction.ts */

export type ToolCompactionConfig = {
  enabled: boolean;
  useAI: boolean;
  triggerTokens: number;
  outputMaxTokens: number;
  truncateMinChars: number;
  truncateHeadRatio: number;
  truncateMinTailChars: number;
};

export type ToolCompactionResult = {
  content: string;
  wasCompacted: boolean;
  extractionDurationMs?: number;
};

/**
 * Estimate token count from a string. Uses the model-aware tokenizer when
 * available, otherwise falls back to a rough chars/4 heuristic.
 */
export function estimateToolTokens(text: string, modelName?: string): number {
  if (modelName) {
    const tokenization = resolveConversationTokenization(modelName);
    if (tokenization.encoding) {
      return tokenization.encoding.encode(text).length;
    }
  }
  return Math.ceil(text.length / 4);
}

/**
 * Truncate content to fit within a token budget using head/tail ratio.
 * Mirrors maelstrom's truncateToTokenBudget.
 */
function truncateToTokenBudget(
  content: string,
  maxTokens: number,
  options: { minChars: number; headRatio: number; minTailChars: number },
  modelName?: string,
): string {
  if (!content) return content;
  const totalTokens = estimateToolTokens(content, modelName);
  if (totalTokens <= maxTokens) return content;

  const ratio = Math.max(0.05, maxTokens / totalTokens);
  const keepChars = Math.max(options.minChars, Math.floor(content.length * ratio));
  const headChars = Math.floor(keepChars * options.headRatio);
  const tailChars = Math.max(options.minTailChars, keepChars - headChars);

  const marker = '\n\n...[tool output truncated for size]...\n\n';
  let head = headChars;
  let tail = tailChars;
  let out = content.slice(0, head) + marker + content.slice(-tail);

  // The minChars / minTailChars floors above can push the result BACK over
  // maxTokens (a floor is a lower bound on chars, not tokens). Re-tokenize and
  // shrink head+tail proportionally until the output actually fits, ignoring the
  // floors on this pass — a slightly-too-small slice is correct behavior when
  // the budget genuinely can't hold the floors.
  for (let i = 0; i < 12 && estimateToolTokens(out, modelName) > maxTokens; i++) {
    head = Math.floor(head * 0.7);
    tail = Math.floor(tail * 0.7);
    if (head <= 0 && tail <= 0) {
      out = marker;
      break;
    }
    out = content.slice(0, Math.max(0, head)) + marker + (tail > 0 ? content.slice(-tail) : '');
  }
  return out;
}

/**
 * Use an AI model to extract relevant information from a large tool result.
 */
async function aiExtractRelevantInfo(
  content: string,
  toolName: string,
  userQuery: string,
  maxOutputTokens: number,
  modelConfig: LLMModelConfig,
): Promise<string | null> {
  try {
    const { Agent } = await import('@mastra/core/agent');
    type AgentConfig = ConstructorParameters<typeof Agent>[0];

    const prompt = [
      `User request: ${userQuery || '(none provided)'}`,
      `Tool: ${toolName}`,
      '',
      'Tool output:',
      content,
    ].join('\n');

    const gen = await auxAgentGenerate(
      (model) =>
        new Agent({
          id: `tool-compact-${Date.now()}`,
          name: 'tool-compaction-agent',
          instructions:
            'Summarize only the information needed to answer the user request. Keep important IDs, names, and values. Omit boilerplate and repeated metadata. If output is JSON-like, preserve key fields in compact form.',
          model: model as AgentConfig['model'],
        }),
      prompt,
      { maxSteps: 1 },
      { primaryModelConfig: modelConfig, label: 'tool-compaction' },
    );
    return gen ? gen.text.trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * Split a tool result's compaction-exempt fields off the compactable body.
 *
 * Two reserved fields must NOT be fed to the text token-estimator / truncator /
 * AI summarizer:
 *  - `_diffTracking`: inline diff metadata (a build that prints a lot AND touches
 *    a lockfile still needs its stdout shrunk without losing the diff).
 *  - `_modelContent`: native model-visible media (base64 images/files). Slicing
 *    or summarizing this string corrupts the base64 / drops the attachment.
 *
 * Returns the body to compact (`resultForCompaction`, with those keys removed)
 * plus a `reattach(value)` that restores them onto the compacted output —
 * handling both the object-result and bare-string-result (shell-shaped) cases.
 * Pure, so the preservation contract is unit-tested.
 */
export function splitPreservedFields(result: unknown): {
  resultForCompaction: unknown;
  reattach: (value: unknown) => unknown;
} {
  let preservedDiffTracking: unknown;
  let preservedModelContent: unknown;
  let resultForCompaction = result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    const dt = r._diffTracking as { diffs?: unknown[] } | undefined;
    if (dt && Array.isArray(dt.diffs) && dt.diffs.length > 0) {
      preservedDiffTracking = dt;
    }
    if (Array.isArray(r._modelContent) && r._modelContent.length > 0) {
      preservedModelContent = r._modelContent;
    }
    if (preservedDiffTracking !== undefined || preservedModelContent !== undefined) {
      const { _diffTracking, _modelContent, ...rest } = r;
      void _diffTracking;
      void _modelContent;
      resultForCompaction = rest;
    }
  }
  const reattach = (value: unknown): unknown => {
    if (preservedDiffTracking === undefined && preservedModelContent === undefined) return value;
    const extra = {
      ...(preservedDiffTracking !== undefined ? { _diffTracking: preservedDiffTracking } : {}),
      ...(preservedModelContent !== undefined ? { _modelContent: preservedModelContent } : {}),
    };
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ...(value as Record<string, unknown>), ...extra };
    }
    // Compaction produced a bare string. The shell renderer recognizes
    // { stdout } — reattach as a shell-shaped object to keep the output view
    // working (wrapping as { value } would render as "No output").
    return { stdout: String(value ?? ''), ...extra };
  };
  return { resultForCompaction, reattach };
}

/**
 * Compact a tool result if it exceeds the configured token threshold.
 *
 * Strategy (matching maelstrom):
 *  1. If disabled or under triggerTokens, return as-is
 *  2. If useAI, try AI extraction → then bound to outputMaxTokens via truncation
 *  3. Fallback: head/tail truncation to outputMaxTokens
 */
export async function compactToolResult(
  content: string,
  toolName: string,
  userQuery: string,
  settings: ToolCompactionConfig,
  modelConfig?: LLMModelConfig,
  modelName?: string,
): Promise<ToolCompactionResult> {
  const started = Date.now();

  if (!settings.enabled) {
    return { content, wasCompacted: false };
  }

  if (estimateToolTokens(content, modelName) <= settings.triggerTokens) {
    return { content, wasCompacted: false };
  }

  const truncateOpts = {
    minChars: settings.truncateMinChars,
    headRatio: settings.truncateHeadRatio,
    minTailChars: settings.truncateMinTailChars,
  };

  // Try AI extraction first
  if (settings.useAI && modelConfig) {
    const extracted = await aiExtractRelevantInfo(content, toolName, userQuery, settings.outputMaxTokens, modelConfig);
    if (extracted) {
      // Bound AI output to outputMaxTokens in case the model went over
      const bounded = truncateToTokenBudget(extracted, settings.outputMaxTokens, truncateOpts, modelName);
      return {
        content: bounded,
        wasCompacted: bounded !== content,
        extractionDurationMs: Date.now() - started,
      };
    }
  }

  // Fallback: head/tail truncation
  const fallback = truncateToTokenBudget(content, settings.outputMaxTokens, truncateOpts, modelName);
  return {
    content: fallback,
    wasCompacted: fallback !== content,
    extractionDurationMs: Date.now() - started,
  };
}

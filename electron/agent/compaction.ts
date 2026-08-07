import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import {
  countBranchTokensCached,
  countBranchTokensCachedAsync,
  resolveConversationTokenization,
  serializeForTokenCounting,
  sumBranchTokensForGate,
  encodeCappedWith,
  encodeCappedWithAsync,
  type ConversationTokenizationInfo,
} from './tokenization.js';
import type { LLMModelConfig, ModelCatalogEntry } from './model-catalog.js';
import { auxAgentGenerate } from './generate-fallback.js';
import {
  estimateNativeMediaTokens,
  estimateImageTokensFromBytes,
  estimateFileTokensFromBytes,
  isSanitizerRetainableMedia,
} from './media-fit.js';
import { COMPACTION_SYSTEM_PROMPT } from './prompts.js';

// Cap on CONCURRENT outstanding summarizer generates. An aborted/timed-out compaction
// stops AWAITING its generate (Promise.race) but can't force-cancel a provider that
// ignores abortSignal — the request keeps running with its prompt/agent state alive. Under
// repeated abort+retry (a flapping provider, tight /compact timeouts) these would otherwise
// accumulate unbounded (OOM / provider request exhaustion). The slot is held until the
// generate actually SETTLES (not when the race resolves), so abandoned-but-running requests
// keep occupying it; a new compaction that can't get a slot bails (returns null → history
// stays uncompacted, reactive recovery / the next turn retries) rather than piling on.
const MAX_CONCURRENT_SUMMARIZER_GENERATES = 4;
let outstandingSummarizerGenerates = 0;

// Canonical BOUNDED content signature for a single message. Detects that a covered
// message's CONTENT (not just its id) changed between when a compaction was computed
// and when its record is persisted/reused. Includes tool_calls / tool_call_id so a
// same-id edit that only rewrites the tool payload is still caught. Returns a fixed-
// width SHA1 hash, NOT the raw content: covered messages can carry large tool results
// or retained base64 media, and these signatures are (a) transmitted inside the
// `compaction` stream event — raw content would blow the 8 MiB local-bridge/CLI frame
// limit and destroy the socket — and (b) compared on every `conversations:put`, where
// concatenating raw content for a media-heavy branch would allocate history-sized
// strings and risk OOMing the main process. Lives here (not stream-persistence) so the
// agent, conversations, and stream-persistence layers can all import it without a cycle.
export function messageContentSignature(
  m: { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown } | null | undefined,
): string {
  if (!m) return '';
  const extra = m as { tool_calls?: unknown; tool_call_id?: unknown };
  // Sign the MODEL-VISIBLE content: normalize away user-message `file` parts flagged
  // `displayOnly` (the renderer keeps them for the attachment chip but their content is
  // already inlined as a sibling text part and they're never sent to the provider). The
  // compaction PRODUCERS sign the already-displayOnly-stripped in-memory branch, while
  // the PERSISTENCE consumers recompute from RAW disk — without this normalization those
  // two hashes disagree for a message carrying a displayOnly part, and a valid compaction
  // is repeatedly false-rejected (re-summarized + rebilled). Stripping here makes the
  // signature identical whether the caller passes raw or pre-stripped messages, and a
  // displayOnly change (which never affects the model) correctly does NOT count as drift.
  let content = m.content;
  if (m.role === 'user' && Array.isArray(content)) {
    const filtered = (content as Array<{ type?: unknown; displayOnly?: unknown } | null | undefined>).filter(
      (p) => !(p && typeof p === 'object' && p.type === 'file' && p.displayOnly === true),
    );
    // Mirror stripDisplayOnlyParts: keep the original if stripping empties the content.
    if (filtered.length !== (content as unknown[]).length && filtered.length > 0) content = filtered;
  }
  let composed: string;
  try {
    composed = `${m.role ?? ''}:${JSON.stringify(content) ?? ''}:${
      extra.tool_calls !== undefined ? JSON.stringify(extra.tool_calls) : ''
    }:${extra.tool_call_id !== undefined ? String(extra.tool_call_id) : ''}`;
  } catch {
    // JSON.stringify can throw on a circular/exotic content object. A stable sentinel
    // keyed by role/id keeps the signature deterministic (two unserializable-but-equal
    // messages compare equal) without leaking the raw structure — the callers only need
    // drift DETECTION, and an unserializable message is treated as "changed if anything
    // else about it changed" via role + tool_call_id.
    composed = `unserializable:${m.role ?? ''}:${
      extra.tool_call_id !== undefined ? String(extra.tool_call_id) : ''
    }`;
  }
  return createHash('sha1').update(composed).digest('hex');
}

export type ChatMessage = {
  id?: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | unknown[];
  tool_calls?: Array<{ id: string; [key: string]: unknown }>;
  tool_call_id?: string;
  /**
   * Cached per-message token count carried from the stored tree node (see
   * StoredTreeMessage). When present AND its signature still matches the content,
   * `shouldCompact` sums these instead of serializing the whole history each turn.
   * Optional — missing/mismatched counts fall back to a safe over-biased estimate.
   */
  tokenCount?: number;
  /** Content signature validating {@link tokenCount} (see messageContentSig). */
  tokenCountSig?: number;
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
  // LIVE proactive/recovery/reuse compaction must NEVER summarize away the CURRENT turn's
  // newest user message — otherwise, with both ignoreRecent* set to 0 on a first turn, a
  // large-attachment user message would be entirely compactable and the media-stripped
  // summarizer would replace it with a placeholder, so the model never sees the user's
  // media. When true, the boundary is clamped to at most the newest user message's index.
  // (Left false for on-demand /compact, which is user-initiated over historical content.)
  alwaysProtectNewestUser = false,
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

  // Clamp so the newest user message is always in the SUFFIX (protected) for live
  // proactive/recovery/reuse compaction — never summarize away the current user turn
  // (which could drop its just-attached media behind a summary placeholder).
  if (alwaysProtectNewestUser) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        if (i < boundaryIndex) boundaryIndex = i;
        break;
      }
    }
  }

  return { boundaryIndex, protectedIds, protectedToolCallIds };
}

export type ShouldCompactResult = { shouldCompact: boolean; usedTokens: number; contextWindowTokens: number };

/**
 * Shared cheap gate for {@link shouldCompact}/{@link shouldCompactAsync}. Runs
 * everything that must stay SYNCHRONOUS on the caller thread — resolve
 * tokenization, the byte-ceiling/cached-sum pre-check, and the fallback-encoding
 * short-circuit — WITHOUT ever touching tiktoken's whole-branch encode.
 *
 * Returns `{ decided }` with a final result when the decision is settled without
 * an exact recount (under trigger, or a non-canonical tokenizer where the byte
 * ceiling is authoritative). Returns `{ decided: null, tokenization, triggerTokens }`
 * when the exact whole-branch recount is still needed — which the sync path runs
 * inline and the async path runs off-thread. This is the ONLY expensive step, and
 * it's reached only when the cheap gate already tripped.
 */
function shouldCompactGate(
  messages: ChatMessage[],
  modelName: string,
  triggerPercent: number,
  contextWindowOverride?: number,
  extraMediaTokens = 0,
):
  | { decided: ShouldCompactResult }
  | { decided: null; tokenization: ConversationTokenizationInfo; triggerTokens: number; extraMediaTokens: number } {
  const tokenization = resolveConversationTokenization(modelName, contextWindowOverride);
  if (!tokenization.encoding || !tokenization.contextWindowTokens) {
    return { decided: { shouldCompact: false, usedTokens: 0, contextWindowTokens: 0 } };
  }
  const triggerTokens = Math.floor(tokenization.contextWindowTokens * triggerPercent);
  // Native-media tokens added by the caller (see shouldCompactAsync's extraMediaTokens):
  // when `messages` has had media base64 stripped to its dimension-based native
  // estimate, that estimate is counted here rather than as raw base64 text. A
  // non-negative floor guards against a bad caller value.
  const extra = Math.max(0, extraMediaTokens);

  // Cheap pre-check: a tokenizer-SAFE sum over the branch (integer add of cached
  // counts when the target model shares the canonical o200k tokenizer; a
  // model-independent UTF-8 byte ceiling otherwise, so an o200k-cached count can't
  // under-count for a cl100k model and skip a needed compaction). Missing counts
  // fall back to an over-biased estimate. If even this safe sum is below the
  // trigger, the exact count must be too → skip tiktoken entirely (the common,
  // hot-path case). Only when it reaches the trigger do we pay the exact count.
  const summedTokens = sumBranchTokensForGate(messages, tokenization) + extra;
  if (summedTokens < triggerTokens) {
    return {
      decided: {
        shouldCompact: false,
        // Report the sum for context-usage telemetry; it's an upper bound.
        usedTokens: summedTokens,
        contextWindowTokens: tokenization.contextWindowTokens,
      },
    };
  }

  // For a model tiktoken does NOT recognize (Claude/Gemini/Bedrock/etc.), the only
  // local encoder is the o200k fallback — the WRONG tokenizer. Its exact count would
  // neither be authoritative (can undercount the provider and skip a needed
  // compaction) nor cheap (a whole-history encode every send). So for these the
  // byte-ceiling gate sum (a true upper bound, no encode) IS the authoritative
  // value: decide from it directly, never o200k-recount. A RECOGNIZED model of ANY
  // base has its CORRECT encoder, so it falls through to the exact recount.
  if (tokenization.isFallbackEncoding) {
    return {
      decided: {
        shouldCompact: summedTokens >= triggerTokens,
        usedTokens: summedTokens,
        contextWindowTokens: tokenization.contextWindowTokens,
      },
    };
  }

  return { decided: null, tokenization, triggerTokens, extraMediaTokens: extra };
}

/**
 * Synchronous compaction gate. Kept for non-async callers and tests. The exact
 * whole-branch recount (when reached) runs inline on the caller thread; on the
 * main thread prefer {@link shouldCompactAsync} so that step goes off-thread.
 */
export function shouldCompact(
  messages: ChatMessage[],
  modelName: string,
  triggerPercent: number,
  contextWindowOverride?: number,
  extraMediaTokens = 0,
): ShouldCompactResult {
  const gate = shouldCompactGate(messages, modelName, triggerPercent, contextWindowOverride, extraMediaTokens);
  if (gate.decided) return gate.decided;

  const { tokenization, triggerTokens, extraMediaTokens: extra } = gate;
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1]?.id : undefined;
  const usedTokens = (countBranchTokensCached(messages, tokenization, lastMessageId) ?? 0) + extra;
  return {
    shouldCompact: usedTokens >= triggerTokens,
    usedTokens,
    contextWindowTokens: tokenization.contextWindowTokens ?? 0,
  };
}

/**
 * Off-main-thread compaction gate. The cheap gate above stays synchronous and
 * short-circuits BEFORE any tiktoken work — so the common under-trigger case and
 * the fallback-tokenizer case never await anything. Only when the exact
 * whole-branch recount is genuinely needed does this await the tokenizer worker
 * (see tokenizer-worker.ts): the main thread's event loop stays live while the
 * CPU-bound encode runs off-thread, and a worker timeout/crash byte-ceilings
 * rather than freezing the send path. Same numeric result as {@link shouldCompact}.
 *
 * `extraMediaTokens` is added to the used-token total (and factored into the cheap
 * pre-check). Callers that pass media-STRIPPED messages (base64 replaced with a
 * dimension-based native estimate) supply that estimate here so retained media is
 * charged its real native cost instead of its raw base64 length — the same
 * projection the final compaction fit + branch-sum gate use. Without it, a
 * protected-tail image would count as hundreds of thousands of "text" tokens and
 * re-trigger paid summarization every turn.
 */
export async function shouldCompactAsync(
  messages: ChatMessage[],
  modelName: string,
  triggerPercent: number,
  contextWindowOverride?: number,
  signal?: AbortSignal,
  extraMediaTokens = 0,
): Promise<ShouldCompactResult> {
  const gate = shouldCompactGate(messages, modelName, triggerPercent, contextWindowOverride, extraMediaTokens);
  if (gate.decided) return gate.decided;

  const { tokenization, triggerTokens, extraMediaTokens: extra } = gate;
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1]?.id : undefined;
  const usedTokens =
    ((await countBranchTokensCachedAsync(messages, tokenization, lastMessageId, signal)) ?? 0) + extra;
  return {
    shouldCompact: usedTokens >= triggerTokens,
    usedTokens,
    contextWindowTokens: tokenization.contextWindowTokens ?? 0,
  };
}

export type CompactionResult = {
  compactedMessages: ChatMessage[] | null;
  summaryText: string | null;
  compactionId: string | null;
  compactedMessageIds: string[];
};

/**
 * Media-aware {@link shouldCompactAsync}: strips `_modelContent`/native media base64
 * from the branch (folding its native token estimate in via `extraMediaTokens`)
 * before gating, so a retained protected-tail image is charged its real (small)
 * native cost instead of its raw base64 length. Without this a single screenshot
 * counts as hundreds of thousands of "text" tokens and falsely trips the trigger.
 * This is the same projection the send-path reuse check applies; exported so the
 * on-demand `/compact` handler can gate identically.
 */
export async function shouldCompactBranchMediaAware(
  messages: ChatMessage[],
  modelName: string,
  triggerPercent: number,
  contextWindowOverride?: number,
  signal?: AbortSignal,
): Promise<ShouldCompactResult> {
  const { messages: stripped, mediaTokens } = await stripMediaForSerialization(messages, { signal });
  return shouldCompactAsync(stripped, modelName, triggerPercent, contextWindowOverride, signal, mediaTokens);
}

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

/**
 * Split `messages` for compaction token-counting into (a) a COPY whose native
 * media base64 is removed from the JSON projection (with `_modelContent` TEXT
 * parts PRESERVED — they're real model context to summarize), and (b) the total
 * NATIVE token cost of that media. Originals are untouched (callers keep the real
 * media in their prefix/suffix).
 *
 * Media is sent NATIVELY, so serializing its base64 as TEXT over-counts a few-MB
 * image at ~500k tokens (defeating the fit); counting it as ZERO under-counts (the
 * final safety re-check could pass while the real request is still over-window).
 * So the base64 is removed from the serialized text AND its byte-based native
 * estimate is returned to be ADDED to the token count. Byte-based (not fixed) so a
 * high-res image is charged proportionally; byte estimate is a safe over-estimate.
 */
async function stripMediaForSerialization(
  messages: ChatMessage[],
  options: { countMedia?: boolean; signal?: AbortSignal } = {},
): Promise<{ messages: ChatMessage[]; mediaTokens: number }> {
  // Collect media payloads to estimate by DIMENSIONS (via estimateNativeMediaTokens
  // — sharp header probe, cached), not compressed bytes: bytes/2 charges a 1 MiB
  // image ~524k tokens vs a real native cost of a few thousand, which would wrongly
  // null-out compaction for a normal recent screenshot.
  // `countMedia` (default true): when false, only STRIP the media (no sharp probes)
  // — callers that discard mediaTokens (the summarized prefix, whose media is
  // dropped entirely) avoid decoding a media-heavy history for a number they throw
  // away.
  const countMedia = options.countMedia !== false;
  const mediaToEstimate: Array<{ data: string; isImage: boolean; mediaType?: string }> = [];
  const out = messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) return m;
    let touched = false;
    const cleaned = content.map((part) => {
      if (!part || typeof part !== 'object') return part;
      const p = part as Record<string, unknown>;
      // Native user image/file content part → drop payload, queue native estimate.
      // Leave a TEXT placeholder so the summarizer (which never sees the payload)
      // still KNOWS the media existed and can reference it in the summary — else a
      // bare image with no accompanying text vanishes silently from future context.
      if ((p.type === 'image' || p.type === 'file') && typeof (p.data ?? p.image) === 'string') {
        touched = true;
        mediaToEstimate.push({ data: (p.data ?? p.image) as string, isImage: p.type === 'image', mediaType: (p.mimeType ?? p.mediaType) as string | undefined });
        const label = p.type === 'image' ? 'image' : 'file';
        const name = typeof p.filename === 'string' && p.filename ? ` "${p.filename}"` : '';
        return { type: 'text', text: `[${label}${name} attachment omitted from summary]` };
      }
      // Tool-result `_modelContent`: strip image/file base64 (queue estimates), but
      // KEEP text parts inline (they're model-visible context to summarize). Stripped
      // image/file parts leave a short placeholder so the summarizer knows they were
      // present (a pure-image result would otherwise summarize to nothing).
      const res = p.result as Record<string, unknown> | undefined;
      if (res && typeof res === 'object' && !Array.isArray(res) && Array.isArray(res._modelContent)) {
        touched = true;
        const keptText: string[] = [];
        // Mirror extractModelContent's per-result retention (5 MiB per-part, 12 MiB
        // per-result, 64-part cap, validity) so a media part the sanitizer DROPS isn't
        // charged native tokens — it becomes an omission note provider-side, not sent.
        const MC_MAX_PART_BYTES = 5 * 1024 * 1024;
        const MC_MAX_TOTAL_BYTES = 12 * 1024 * 1024;
        const MC_MAX_PARTS = 64;
        let mcPartCount = 0;
        let mcTotalBytes = 0;
        for (const mc of res._modelContent as unknown[]) {
          if (mcPartCount >= MC_MAX_PARTS) break;
          if (!mc || typeof mc !== 'object') continue;
          const mcp = mc as Record<string, unknown>;
          if (mcp.type === 'text' && typeof mcp.text === 'string') {
            mcPartCount += 1;
            keptText.push(mcp.text);
          } else if ((mcp.type === 'image' || mcp.type === 'file') && isSanitizerRetainableMedia(mcp)) {
            // Decoded byte estimate (base64 → ~3/4), strip any data-URL prefix first.
            const raw = (mcp.data as string).replace(/^data:[^;,]*(?:;[^,]*)?,/, '');
            const bytes = Math.floor((raw.length * 3) / 4);
            if (bytes > MC_MAX_PART_BYTES || mcTotalBytes + bytes > MC_MAX_TOTAL_BYTES) {
              // Sanitizer drops → omission note (not counted here, but the provider
              // WILL see this note, so its projected length must match the canonical
              // note the sanitizer emits at tool-model-content.ts:120 exactly (same
              // label + MB size, no filename) — otherwise the counted length drifts
              // from what's sent.
              const label = mcp.type === 'image' ? 'image' : 'file';
              keptText.push(`[${label} omitted: ${(bytes / (1024 * 1024)).toFixed(1)} MB exceeds the per-result media limit]`);
              mcPartCount += 1;
              continue;
            }
            mcPartCount += 1;
            mcTotalBytes += bytes;
            mediaToEstimate.push({ data: mcp.data as string, isImage: mcp.type === 'image', mediaType: mcp.mediaType as string });
            const name = typeof mcp.filename === 'string' && mcp.filename ? ` "${mcp.filename}"` : '';
            keptText.push(`[${mcp.type === 'image' ? 'image' : 'file'}${name} attachment omitted from summary]`);
          }
        }
        const { _modelContent, ...restResult } = res;
        void _modelContent;
        // Drop the UI-only originalResult/compaction backup (see below) too.
        const { originalResult: _or2, compactionMeta: _cm2, compactionPhase: _cp2, ...pNoBackup } = p;
        void _or2;
        void _cm2;
        void _cp2;
        return {
          ...pNoBackup,
          result: keptText.length > 0 ? { ...restResult, _modelContentText: keptText.join('\n') } : restResult,
        };
      }
      // A COMPACTED tool-call part keeps its pre-compaction body in `originalResult`
      // purely for UI restoration; only `result` is sent to the provider. The
      // summarizer's prefix/final-fit token checks must NOT count that potentially
      // huge backup (nor the UI-only compaction metadata) — counting it would reject
      // otherwise-valid compactions or discard a paid summary while the real model
      // context would fit. This mirrors the compaction gate's projection (agent.ts).
      if (Object.hasOwn(p, 'originalResult')) {
        touched = true;
        const { originalResult: _or, compactionMeta: _cm, compactionPhase: _cp, ...restPart } = p;
        void _or;
        void _cm;
        void _cp;
        return restPart;
      }
      return part;
    });
    if (!touched) return m;
    // Content was rewritten (media stripped / backups removed) → any cached tokenCount /
    // tokenCountSig (computed over the ORIGINAL base64-bearing content) is now stale. The
    // cheap canonical-model gate would otherwise TRUST that inflated count and could reject
    // an otherwise-valid candidate after already paying the summarizer. Drop both so the
    // count is recomputed against the stripped content (mirrors stripBranchMediaForCount).
    const { tokenCount: _tc, tokenCountSig: _ts, ...mNoCache } = m as Record<string, unknown>;
    void _tc;
    void _ts;
    return { ...mNoCache, content: cleaned } as ChatMessage;
  });
  // The prefix caller discards mediaTokens (prefix media is summarized away), so
  // skip the sharp probes entirely for it.
  if (!countMedia) return { messages: out, mediaTokens: 0 };
  // Estimate media (dimension-based, bounded concurrency to avoid decoding a
  // media-heavy branch all at once). A hard cap bounds worst-case work per call
  // (a pathological media-heavy history could otherwise stall the turn); media
  // beyond it is charged the cheap byte estimate (never zero). Abort promptly if
  // the run was cancelled during the probes.
  let mediaTokens = 0;
  const CONCURRENCY = 4;
  const MEDIA_ESTIMATE_MAX = 128;
  const toProbe = mediaToEstimate.slice(0, MEDIA_ESTIMATE_MAX);
  for (const item of mediaToEstimate.slice(MEDIA_ESTIMATE_MAX)) {
    mediaTokens += item.isImage ? estimateImageTokensFromBytes(item.data) : estimateFileTokensFromBytes(item.data, item.mediaType);
  }
  for (let i = 0; i < toProbe.length; i += CONCURRENCY) {
    if (options.signal?.aborted) break;
    const batch = toProbe.slice(i, i + CONCURRENCY);
    const ests = await Promise.all(batch.map((x) => estimateNativeMediaTokens(x.data, x.isImage, x.mediaType)));
    for (const e of ests) mediaTokens += e;
  }
  return { messages: out, mediaTokens };
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
  signal?: AbortSignal,
  options?: {
    /** Suppress the ambient default fallback chain for the summarizer (run the
     *  given model ONLY). Set when the caller routes through a provider override
     *  (plugin/enterprise gateway): falling back to the ambient chain would send
     *  the full transcript to the model's ORIGINAL (e.g. public) provider,
     *  defeating the override's data-routing guarantee. */
    disableAmbientFallback?: boolean;
    /** Override the summarizer's system prompt (defaults to COMPACTION_SYSTEM_PROMPT).
     *  Set when a UserPromptSubmit DLP/guardrail hook rewrote the compaction prompt
     *  — the summarizer request must honor that rewrite (parity with a normal turn). */
    systemPromptOverride?: string;
    /** Tokens by which the NEXT REAL TURN's static input (chat system prompt +
     *  tool schemas) exceeds `promptReserveTokens`. The summary must fit BOTH the
     *  summarizer request (this fn's own prompt excess) AND the next turn's request
     *  (this value). They are SEPARATE requests, so the window must be reduced by the
     *  MAXIMUM of the two excesses, not their sum. Callers pass the RAW window here
     *  and this excess (instead of pre-reducing the window themselves — which would
     *  double-subtract when both prompts exceed the reserve and reject valid
     *  compaction). Defaults to 0 (summarizer request is the only constraint). */
    externalPromptOverReserve?: number;
    /** LIVE proactive/recovery compaction: never summarize away the CURRENT turn's newest
     *  user message (clamps the boundary), so a first-turn large attachment can't be
     *  replaced by a summary placeholder the model never sees behind. Leave false for
     *  on-demand /compact over historical content. */
    protectNewestUser?: boolean;
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
    options?.protectNewestUser ?? false,
  );

  const prefix = messages.slice(0, boundaryIndex);
  const suffix = messages.slice(boundaryIndex);
  if (prefix.length === 0) {
    return { compactedMessages: null, summaryText: null, compactionId: null, compactedMessageIds: [] };
  }

  // Budget the compaction prompt input to avoid exceeding the context window.
  // Mirrors maelstrom-agent: contextWindow - outputMaxTokens - promptReserveTokens.
  // ALSO subtract the amount the ACTUAL summarizer system prompt exceeds the reserve
  // — a hook may rewrite COMPACTION_SYSTEM_PROMPT to something large, which the
  // reserve alone might not cover, otherwise the summarizer request itself overflows.
  const summarizerPrompt = options?.systemPromptOverride ?? COMPACTION_SYSTEM_PROMPT;
  // Count with the model's EXACT tokenizer only for a canonical (o200k) model; for a
  // model unknown to tiktoken (Claude/Gemini/…), `tokenization.encoding` is the GPT
  // FALLBACK, which can under-count a large hook-rewritten prompt and let the
  // summarizer request itself overflow. Use the UTF-8 byte ceiling in that case —
  // the SAME conservative estimator the rest of the compaction budget uses for
  // fallback-encoding models (conversations.ts / media-fit static budget).
  const promptTokens =
    tokenization.encoding && !tokenization.isFallbackEncoding
      ? encodeCappedWith(summarizerPrompt, tokenization.encoding)
      : Buffer.byteLength(summarizerPrompt, 'utf8');
  const promptOverReserve = Math.max(0, promptTokens - Math.max(0, config.promptReserveTokens));
  // The summarizer USER message wraps the serialized prefix in fixed framing lines
  // (see `prompt` below) — those tokens are part of the summarizer request, reserve them.
  const SUMMARIZER_FRAMING = 'Summarize the conversation prefix for future continuation.\nKeep durable constraints, decisions, requirements, unresolved TODOs, IDs, names, and references.\n\nConversation prefix (JSON):\n';
  const framingTokens =
    tokenization.encoding && !tokenization.isFallbackEncoding
      ? encodeCappedWith(SUMMARIZER_FRAMING, tokenization.encoding)
      : Buffer.byteLength(SUMMARIZER_FRAMING, 'utf8');
  // TWO DISTINCT budgets for TWO DISTINCT requests (do NOT combine — combining via a
  // single max can reject a prefix that fits the summarizer, or discard a summary that
  // fits the next turn):
  //  (1) SUMMARIZER-INPUT budget — governs the PREFIX we send to the summarizer this
  //      turn. Reduced by the summarizer's OWN prompt excess + the fixed framing.
  //  (2) NEXT-TURN budget — governs the compacted SUMMARY's fit in the NEXT real turn.
  //      Reduced by that turn's static excess (externalPromptOverReserve). No framing
  //      (the summary is a normal assistant message, not wrapped by the summarizer prompt).
  const baseBudget = tokenization.contextWindowTokens - Math.max(0, config.outputMaxTokens) - Math.max(0, config.promptReserveTokens);
  const summarizerInputBudget = Math.floor(baseBudget - promptOverReserve - framingTokens);
  const nextTurnBudget = Math.floor(baseBudget - Math.max(0, options?.externalPromptOverReserve ?? 0));
  if (summarizerInputBudget <= 0 || nextTurnBudget <= 0) {
    return { compactedMessages: null, summaryText: null, compactionId: null, compactedMessageIds: [] };
  }

  // Fit prefix to the input budget. Fail safe: dropping any prefix message would
  // silently lose it (it's neither summarized nor kept), so we NEVER drop — a
  // prefix that doesn't fit whole yields the null no-op (history stays
  // uncompacted, the turn proceeds on full context). Because dropping is never
  // acceptable, there's no fitting LOOP: encode the whole prefix ONCE and bail if
  // it's over budget. (Looping-then-shifting would be pure wasted O(n²)
  // serialization + repeated worker encodes, since the shifted result is rejected
  // anyway.)
  // Count the summarizer BODY the same way its prompt is counted: EXACT o200k only for
  // a canonical model; the UTF-8 BYTE ceiling for a fallback-encoding model (an unknown
  // alias backed by e.g. cl100k tokenizes denser than o200k — encodeCappedWithAsync
  // would use o200k and UNDER-count, letting the summarizer request itself overflow).
  const countBody = async (text: string): Promise<number> =>
    tokenization.isFallbackEncoding
      ? Buffer.byteLength(text, 'utf8')
      : encodeCappedWithAsync(text, tokenization, signal);

  // Fit the prefix to the SUMMARIZER-INPUT budget. We NEVER DROP a message (dropping would
  // silently lose it — neither summarized nor kept). But an eligible prefix LARGER than the
  // summarizer budget (e.g. a 140K history on a 128K model) must not be all-or-nothing
  // rejected — that leaves the conversation permanently unrecoverable. Instead summarize the
  // OLDEST FITTING SUBSET (prefix[0..k)); the newer, still-uncovered prefix messages
  // (prefix[k..]) STAY in the branch (placed after the summary, before the suffix) to be
  // compacted on a future turn. Shrink from the TAIL of the prefix (drop the newest prefix
  // message toward the boundary) until it fits, requiring at least 2 messages summarized
  // (a 1-message "summary" isn't worth a paid call + placeholder). Bounded: at most
  // prefix.length probes, and only when the whole prefix is over budget (the common case
  // encodes ONCE and fits).
  const MIN_SUMMARIZED = 2;
  // Count the summarizer BODY for the oldest `k` prefix messages (strip media → serialize →
  // tokenize once per probe). Aborts short-circuit to Infinity so the search bails.
  const countForLength = async (k: number): Promise<number> => {
    if (signal?.aborted) return Number.POSITIVE_INFINITY;
    const stripped = (await stripMediaForSerialization(prefix.slice(0, k), { countMedia: false, signal })).messages;
    return countBody(serializeForTokenCounting(stripped));
  };
  // Fast path: the WHOLE prefix usually fits — one probe, no search.
  let fittedLen = prefix.length;
  let candidateTokens = await countForLength(fittedLen);
  if (!signal?.aborted && candidateTokens > summarizerInputBudget) {
    // BINARY SEARCH for the largest k in [MIN_SUMMARIZED, prefix.length] that fits — O(log n)
    // probes, not O(n). (The linear one-at-a-time shrink re-tokenized the whole remaining
    // prefix each step → quadratic → could exhaust /compact's 285s window on a long history.)
    // Monotonic: a shorter oldest-prefix is never larger, so binary search is valid.
    let lo = MIN_SUMMARIZED;
    let hi = prefix.length - 1;
    fittedLen = 0; // nothing fits unless a probe proves otherwise
    candidateTokens = Number.POSITIVE_INFINITY;
    while (lo <= hi && !signal?.aborted) {
      const mid = (lo + hi) >> 1;
      const t = await countForLength(mid);
      if (t <= summarizerInputBudget) {
        fittedLen = mid;
        candidateTokens = t;
        lo = mid + 1; // try to summarize MORE of the oldest prefix
      } else {
        hi = mid - 1;
      }
    }
  }
  const fittedPrefix = fittedLen >= MIN_SUMMARIZED ? prefix.slice(0, fittedLen) : [];
  // The prefix's images are summarized AWAY (replaced by the text summary), not sent — so the
  // summarizer budget counts only the stripped-text placeholders (see stripMediaForSerialization),
  // NOT the prefix media's native tokens (adding those would over-charge ~524k for a 1MB image
  // and wrongly null-out compaction for exactly the media-heavy histories this most needs).
  // Cancelled during an (off-thread) encode, or even the oldest MIN_SUMMARIZED messages don't
  // fit the SUMMARIZER-INPUT budget → null no-op (no message loss, no wasted retries).
  if (signal?.aborted || fittedPrefix.length < MIN_SUMMARIZED || candidateTokens > summarizerInputBudget) {
    return { compactedMessages: null, summaryText: null, compactionId: null, compactedMessageIds: [] };
  }
  // Messages shifted out of fittedPrefix to fit the budget are NOT summarized — keep them
  // in the branch (after the summary) so they're neither lost nor mislabeled as compacted.
  const uncoveredPrefix = prefix.slice(fittedPrefix.length);

  // Generate summary
  const { Agent } = await import('@mastra/core/agent');
  type AgentConfig = ConstructorParameters<typeof Agent>[0];

  // The budget-fit loop above can await the off-thread tokenizer; if the run was
  // cancelled/superseded during that await, bail BEFORE issuing (and billing) the
  // summarizer LLM request. Returning a null result leaves the history
  // uncompacted, matching every other early-out here.
  if (signal?.aborted) {
    return { compactedMessages: null, summaryText: null, compactionId: null, compactedMessageIds: [] };
  }

  // Media-strip the FINAL fittedPrefix for the summarizer prompt body (the binary search
  // above tokenized candidate lengths but didn't retain the stripped messages).
  const { messages: serializablePrefix } = await stripMediaForSerialization(fittedPrefix, {
    countMedia: false,
    signal,
  });
  if (signal?.aborted) {
    return { compactedMessages: null, summaryText: null, compactionId: null, compactedMessageIds: [] };
  }
  const prompt = `${SUMMARIZER_FRAMING}${serializeForTokenCounting(serializablePrefix)}`;

  // Refuse to issue another summarizer generate if too many prior ones are still
  // outstanding (abandoned by aborts but not force-cancellable). Bail as a no-op — the
  // history stays uncompacted and reactive recovery / the next turn retries once slots free.
  if (outstandingSummarizerGenerates >= MAX_CONCURRENT_SUMMARIZER_GENERATES) {
    console.warn('[compaction] too many outstanding summarizer requests — skipping compaction for this turn');
    return { compactedMessages: null, summaryText: null, compactionId: null, compactedMessageIds: [] };
  }

  // Fail safe if the summarizer LLM call throws (network/API error): compaction
  // is best-effort and runs mid-turn, so an uncaught throw here would fail the
  // whole user turn. Return a null result to keep the uncompacted history and
  // let the turn proceed (mirrors aiExtractRelevantInfo's try/catch contract).
  let summaryText: string | null = null;
  try {
    // Race the summarizer generate against the abort signal so this function stops
    // AWAITING (and releases the prefix/transcript it holds) promptly on cancel even if
    // the provider ignores abortSignal — otherwise the abandoned inner stack keeps the
    // whole transcript alive after the caller's lock/turn released, and repeated hung
    // requests accumulate transcript copies. The losing promise's late rejection is
    // swallowed. abortSignal is still forwarded so a well-behaved provider cancels too.
    const genPromise = auxAgentGenerate(
      (model) =>
        new Agent({
          id: `compaction-${Date.now()}`,
          name: 'compaction-agent',
          instructions: options?.systemPromptOverride ?? COMPACTION_SYSTEM_PROMPT,
          model: model as AgentConfig['model'],
        }),
      prompt,
      { maxSteps: 1, abortSignal: signal },
      options?.disableAmbientFallback
        ? // Route through the override model ONLY — no ambient fallback that would
          // leak the transcript to the model's original provider.
          {
            chain: [
              {
                key: `__compaction_override__:${modelConfig.modelName}`,
                displayName: modelConfig.modelName,
                modelConfig,
              } as ModelCatalogEntry,
            ],
            label: 'compaction',
            abortSignal: signal,
          }
        : { primaryModelConfig: modelConfig, label: 'compaction', abortSignal: signal },
    );
    // Occupy a concurrency slot until the generate actually SETTLES — so an abandoned
    // (aborted-but-still-running) request keeps its slot, capping accumulation. Decrement
    // on settle regardless of who wins the race below.
    outstandingSummarizerGenerates += 1;
    genPromise.then(
      () => {
        outstandingSummarizerGenerates = Math.max(0, outstandingSummarizerGenerates - 1);
      },
      () => {
        outstandingSummarizerGenerates = Math.max(0, outstandingSummarizerGenerates - 1);
      },
    );
    const gen = signal
      ? await Promise.race([
          genPromise,
          new Promise<null>((resolve) => {
            if (signal.aborted) return resolve(null);
            signal.addEventListener('abort', () => resolve(null), { once: true });
          }),
        ])
      : await genPromise;
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

  // The summary represents fittedPrefix (the OLDEST k messages). Any prefix messages shifted
  // out to fit the budget (uncoveredPrefix, the NEWER prefix) stay in the branch AFTER the
  // summary and BEFORE the suffix — neither lost nor double-counted. When the whole prefix
  // fit, uncoveredPrefix is empty and this is the usual [summary, ...suffix].
  const compactedMessages: ChatMessage[] = [summaryMessage, ...uncoveredPrefix, ...suffix];

  // Final safety: verify the compacted request (summary + retained suffix) fits the
  // NEXT-TURN budget (reduced by that turn's static excess, not the summarizer's). Even
  // a bounded summary plus a large suffix could exceed it; shipping an over-budget
  // request would defeat the point. If it still doesn't fit, return the null no-op —
  // the turn proceeds on the full (uncompacted) context ("null ⇒ no message loss").
  const { messages: serializableCompacted, mediaTokens: compactedMediaTokens } =
    await stripMediaForSerialization(compactedMessages, { signal });
  const compactedTokens =
    (await countBody(serializeForTokenCounting(serializableCompacted))) + compactedMediaTokens;
  if (compactedTokens > nextTurnBudget) {
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
      return encodeCappedWith(text, tokenization.encoding);
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

import { encoding_for_model } from 'tiktoken';

type ModelEncoding = ReturnType<typeof encoding_for_model>;
export type { ModelEncoding };

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-5': 272000,
  'gpt-5.4': 272000,
  'gpt-5.4-pro': 272000,
  'gpt-5.5': 272000,
  'gpt-5.5-pro': 272000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4.1': 1048576,
  'gpt-4.1-mini': 1048576,
  // OpenAI reasoning models (recognized in usage-pricing.ts). Without these,
  // adding one without an explicit maxInputTokens leaves contextWindowTokens
  // null and compaction never triggers.
  o3: 200000,
  'o3-mini': 200000,
  'o4-mini': 200000,
};

const MODEL_ENCODING_ALIASES: Record<string, string> = {
  'gpt-5.4': 'gpt-5',
  'gpt-5.4-pro': 'gpt-5',
  'gpt-5.5': 'gpt-5',
  'gpt-5.5-pro': 'gpt-5',
};

const MODEL_NORMALIZATION_RULES: Array<{ pattern: RegExp; normalized: string }> = [
  { pattern: /^gpt-5\.5-pro(?:[.-].+)?$/, normalized: 'gpt-5.5-pro' },
  { pattern: /^gpt-5\.5(?:[.-].+)?$/, normalized: 'gpt-5.5' },
  { pattern: /^gpt-5\.4-pro(?:[.-].+)?$/, normalized: 'gpt-5.4-pro' },
  { pattern: /^gpt-5\.4(?:[.-].+)?$/, normalized: 'gpt-5.4' },
  { pattern: /^gpt-5(?:[.-].+)?$/, normalized: 'gpt-5' },
  { pattern: /^gpt-4o-mini(?:-.+)?$/, normalized: 'gpt-4o-mini' },
  { pattern: /^gpt-4o(?:-.+)?$/, normalized: 'gpt-4o' },
  { pattern: /^gpt-4\.1-mini(?:-.+)?$/, normalized: 'gpt-4.1-mini' },
  { pattern: /^gpt-4\.1(?:-.+)?$/, normalized: 'gpt-4.1' },
  // Reasoning models — most-specific first so o4-mini/o3-mini win over o3.
  { pattern: /^o4-mini(?:-.+)?$/, normalized: 'o4-mini' },
  { pattern: /^o3-mini(?:-.+)?$/, normalized: 'o3-mini' },
  { pattern: /^o3(?:-.+)?$/, normalized: 'o3' },
];

const encodingCache = new Map<string, ModelEncoding>();

/**
 * Conservative context window used when a model is not in
 * {@link MODEL_CONTEXT_WINDOWS} and the caller gave no explicit override. Without
 * this, an unknown model (e.g. a newly-added `gpt-5.5` before its entry existed)
 * resolves to a `null` window, which makes `shouldCompact` bail early and
 * DISABLES compaction — so the history grows unbounded and eventually freezes the
 * main thread on the token count. A conservative default keeps compaction working
 * for any model; a real entry or `maxInputTokens` override always takes priority.
 */
const DEFAULT_UNKNOWN_CONTEXT_WINDOW = 128000;

function normalizeModelBaseName(modelName: string): string {
  const trimmed = modelName.trim().toLowerCase();
  const cleaned = trimmed
    .replace(/^azure[:/]/, '')
    .replace(/^openai[:/]/, '')
    .replace(/^models[:/]/, '')
    .replace(/[_\s]+/g, '-')
    .replace(/-latest$/, '');

  if (cleaned.includes(':') && !cleaned.includes('.')) {
    const tail = cleaned.split(':').slice(1).join(':');
    return tail || cleaned;
  }
  return cleaned;
}

export function normalizeConversationModelName(modelName: string): string {
  const base = normalizeModelBaseName(modelName);
  for (const rule of MODEL_NORMALIZATION_RULES) {
    if (rule.pattern.test(base)) return rule.normalized;
  }
  return base;
}

export function resolveEncodingForModel(modelName: string): ModelEncoding | null {
  const cached = encodingCache.get(modelName);
  if (cached) return cached;

  try {
    const encoding = encoding_for_model(modelName as Parameters<typeof encoding_for_model>[0]);
    if (encoding) {
      encodingCache.set(modelName, encoding);
      return encoding;
    }
  } catch {
    // Fall back to gpt-5
  }
  try {
    const fallback = encoding_for_model('gpt-5' as Parameters<typeof encoding_for_model>[0]);
    encodingCache.set(modelName, fallback);
    return fallback;
  } catch {
    return null;
  }
}

export type ConversationTokenizationInfo = {
  normalizedModelName: string;
  contextWindowTokens: number | null;
  encodingModelName: string | null;
  encoding: ModelEncoding | null;
};

export function resolveConversationTokenization(
  modelName: string,
  contextWindowOverride?: number,
): ConversationTokenizationInfo {
  const normalizedModelName = normalizeConversationModelName(modelName);
  const contextWindowTokens =
    typeof contextWindowOverride === 'number' && Number.isFinite(contextWindowOverride) && contextWindowOverride > 0
      ? Math.floor(contextWindowOverride)
      : (MODEL_CONTEXT_WINDOWS[normalizedModelName] ?? DEFAULT_UNKNOWN_CONTEXT_WINDOW);

  const encodingModelName = MODEL_ENCODING_ALIASES[normalizedModelName] ?? normalizedModelName;
  const encoding = resolveEncodingForModel(encodingModelName);

  return {
    normalizedModelName,
    contextWindowTokens,
    encodingModelName: encoding ? encodingModelName : null,
    encoding,
  };
}

export function serializeForTokenCounting(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Hard cap (in characters of the serialized string) above which we must NOT call
 * the synchronous WASM `tiktoken.encode()` on the main thread — a backstop so a
 * PATHOLOGICAL history can never freeze the UI. It must sit ABOVE the largest
 * legitimate context window's char-equivalent, or a valid in-window prefix would
 * be over-estimated by the ceiling and compaction's budget-fit would wrongly
 * no-op. The biggest current window is GPT-4.1 at 1,048,576 tokens ≈ ~4M chars
 * of English; 8M chars (≈2M tokens) clears every real window, so only a truly
 * pathological >8M-char history hits the ceiling. Encoding an ~8MB string once is
 * bounded and rare — and the per-message accumulator means the whole-history
 * exact encode is only reached when a branch genuinely nears the window.
 */
export const MAX_SYNC_ENCODE_CHARS = 8_000_000;

/**
 * Exact token count of a serialized string via tiktoken, UNLESS the string is
 * larger than {@link MAX_SYNC_ENCODE_CHARS}, in which case fall back to a
 * char-based estimate rather than blocking the main thread. Returns the count.
 *
 * The over-cap fallback is a TRUE UPPER BOUND: `length` (1 token/char). The
 * cheaper `length / 3` estimate used elsewhere assumes ~English density and is
 * NOT a ceiling — CJK / high-entropy text can approach one token per character,
 * so `length/3` could UNDER-count and let compaction's budget-fit accept an
 * over-window prefix. The UTF-8 BYTE length is the true ceiling: these encodings
 * are byte-level BPE, so the token count can never exceed the number of UTF-8
 * bytes (worst case one token per byte). JS string `.length` (UTF-16 code units)
 * is NOT safe — a rare-Unicode code unit can be multiple UTF-8 bytes / tokens. So
 * this is safe for both the shouldCompact gate (over-estimate → maybe run the
 * exact check, never skip it) and budget-fit (over-estimate → drop more, never
 * ship an over-limit request).
 */
function encodeCapped(serialized: string, encoding: ModelEncoding): number {
  if (serialized.length > MAX_SYNC_ENCODE_CHARS) {
    return Buffer.byteLength(serialized, 'utf8'); // UTF-8 bytes — a true token ceiling
  }
  return encoding.encode(serialized).length;
}

/**
 * Public capped-encode for callers that hold an encoding directly (e.g. the
 * compaction budget-fit loop and final safety re-encode). Encodes `serialized`
 * unless it exceeds {@link MAX_SYNC_ENCODE_CHARS}, in which case it returns the
 * over-biased char estimate instead of blocking the main thread.
 */
export function encodeCappedWith(serialized: string, encoding: ModelEncoding): number {
  return encodeCapped(serialized, encoding);
}

/**
 * Lower bound on chars-per-token for the cl100k/o200k-family encodings used
 * here. Real English + JSON structural punctuation averages ~4 chars/token;
 * using a *smaller* divisor makes {@link estimateSerializedTokens} an
 * intentional OVER-estimate of the true token count. That direction is the
 * safe one: the estimate gates whether we run the exact (expensive) encode, and
 * an over-estimate can only cause us to run the real check when we might have
 * skipped it — never the reverse (never skip a check that should have fired).
 */
const MIN_CHARS_PER_TOKEN = 3;

/**
 * Cheap, allocation-light token estimate from serialized character length.
 * No tiktoken/WASM call — just `length / MIN_CHARS_PER_TOKEN`. Deliberately
 * biased HIGH (see {@link MIN_CHARS_PER_TOKEN}) so it can be used as a fast
 * pre-check gate before the exact {@link countSerializedTokens}.
 */
export function estimateSerializedTokens(value: unknown): number {
  return Math.ceil(serializeForTokenCounting(value).length / MIN_CHARS_PER_TOKEN);
}

export function countSerializedTokens(value: unknown, tokenization: ConversationTokenizationInfo): number | null {
  if (!tokenization.encoding) return null;
  return encodeCapped(serializeForTokenCounting(value), tokenization.encoding);
}

/**
 * Sum of per-message cached token counts over a branch, SIGNATURE-VALIDATED. A
 * cached `tokenCount` is trusted only when the message's current projection
 * signature matches the stored `tokenCountSig`; otherwise (missing count, or
 * content changed under a stable id — a hook rewrite, redaction, or same-id
 * plugin upsert) it falls back to the over-biased char estimate. This makes the
 * accumulator self-validating: a stale count can never under-count and slip under
 * the compaction gate, and no explicit invalidation is needed at mutation sites.
 *
 * Unchanged messages (the common case) sum as integers with no whole-array
 * serialization — the accumulator's O(1)-per-turn benefit. The signature check
 * itself serializes only the small projection of a message that LACKS a valid
 * cached count, not the whole history.
 *
 * The sum is intentionally allowed to run slightly HIGH vs a single whole-array
 * `encode()` (per-message counts don't share BPE merges across `},{` delimiters,
 * and the estimate is over-biased): the value only gates whether the exact path
 * runs, and an over-count can only cause an unnecessary exact check, never skip a
 * needed one.
 */
export function sumBranchTokenCounts(
  messages: Array<{ tokenCount?: number; tokenCountSig?: number; role?: unknown; content?: unknown }>,
): number {
  let sum = 0;
  for (const msg of messages) {
    const count = msg?.tokenCount;
    const sig = msg?.tokenCountSig;
    if (
      typeof count === 'number' &&
      Number.isFinite(count) &&
      count >= 0 &&
      typeof sig === 'number' &&
      sig === messageProjectionSig(msg ?? {})
    ) {
      sum += count;
    } else {
      // Missing/invalid count OR signature mismatch (content changed) → estimate.
      sum += estimateSerializedTokens(messageTokenProjection(msg ?? {}));
    }
  }
  return sum;
}

/**
 * Exact token count for a SINGLE message, for populating a message's cached
 * `tokenCount` at creation time. Cheap (one small message, not the whole
 * history). Returns null when no encoding is available.
 */
export function countMessageTokens(message: unknown, tokenization: ConversationTokenizationInfo): number | null {
  if (!tokenization.encoding) return null;
  return encodeCapped(serializeForTokenCounting(message), tokenization.encoding);
}

/**
 * Canonical per-message token count used by the storage layer, which has no
 * model name at append time. All mapped models alias to the gpt-5 (o200k)
 * encoding and `resolveEncodingForModel` falls back to it for anything else, so
 * a single canonical encoding is what every count effectively uses for GATING
 * purposes.
 *
 * Counts the token-bearing PROJECTION `{ role, content }` — NOT the whole tree
 * node — so the value is stable across storage shape (a node carries id /
 * parentId / createdAt tree bookkeeping that isn't sent to the model) and is
 * directly comparable to the fallback estimate, which projects the same fields.
 * Cheap (one small message). Returns undefined (not stored) when no encoding is
 * available.
 */
let canonicalEncoding: ModelEncoding | null | undefined;
export function messageTokenProjection(message: { role?: unknown; content?: unknown }): { role: unknown; content: unknown } {
  return { role: message?.role, content: message?.content };
}

/**
 * Cheap content SIGNATURE of a message's token-bearing projection — the char
 * length of `serializeForTokenCounting({role,content})`. A cached `tokenCount`
 * is only trustworthy while this signature is unchanged: if a hook, redaction, or
 * same-id plugin upsert rewrites content, the projection length changes, the
 * signature no longer matches, and `sumBranchTokenCounts` transparently ignores
 * the stale count and re-estimates. This makes the count self-validating — no
 * scattered explicit invalidation is needed at every mutation site, and a stale
 * low count can never sneak under the compaction gate.
 */
export function messageProjectionSig(message: { role?: unknown; content?: unknown }): number {
  return serializeForTokenCounting(messageTokenProjection(message)).length;
}

/**
 * Canonical per-message exact count + its content signature, for the storage
 * layer (no model name at append time; all mapped models alias to the gpt-5
 * o200k encoding, which `resolveEncodingForModel` also falls back to). Counts the
 * `{role,content}` projection only (stable across tree bookkeeping). Returns
 * `{count: undefined}` when no encoding is available; `sig` is always returned so
 * the caller can still store/compare it.
 */
export function computeMessageCount(message: { role?: unknown; content?: unknown }): {
  count: number | undefined;
  sig: number;
} {
  const sig = messageProjectionSig(message);
  if (canonicalEncoding === undefined) {
    canonicalEncoding = resolveEncodingForModel('gpt-5');
  }
  if (!canonicalEncoding) return { count: undefined, sig };
  return { count: encodeCapped(serializeForTokenCounting(messageTokenProjection(message)), canonicalEncoding), sig };
}

/** Back-compat: just the canonical count (see {@link computeMessageCount}). */
export function countMessageTokensCanonical(message: { role?: unknown; content?: unknown }): number | undefined {
  return computeMessageCount(message).count;
}

/**
 * Memoized exact token count for a message array, keyed by a cheap signature.
 *
 * The compaction pre-check runs on EVERY turn; re-encoding the whole history
 * through tiktoken (WASM, synchronous, main-thread) each time dominates the
 * send-path CPU and freezes the UI on long conversations. When the exact count
 * IS needed (the cheap estimate is near the trigger), memoize it so an
 * unchanged branch — or the common case of the same branch re-checked within a
 * turn — reuses the result instead of re-encoding.
 *
 * The cache is keyed by `(encodingModelName, serialized length, message count,
 * last message id)`. Length + count + tail id change whenever the branch
 * content changes in any way that matters for token counting; a collision would
 * require identical length AND count AND tail id with different interior bytes,
 * which does not occur for an append-only/edited conversation branch. The cache
 * is bounded (LRU-ish via insertion-order eviction) so it can't grow unbounded
 * across many conversations.
 */
const EXACT_TOKEN_CACHE_MAX = 256;
const exactTokenCache = new Map<string, number>();

function branchSignature(
  serialized: string,
  messageCount: number,
  lastMessageId: string | undefined,
  encodingModelName: string,
): string {
  return `${encodingModelName} ${serialized.length} ${messageCount} ${lastMessageId ?? ''}`;
}

/**
 * Exact token count for `messages` with per-branch memoization. `lastMessageId`
 * is an optional stable id of the final message in the branch; when present it
 * strengthens the cache key against distinct branches that share a length +
 * count. Falls back to a one-shot exact count (no caching) when the encoding is
 * unavailable.
 */
export function countBranchTokensCached(
  messages: unknown[],
  tokenization: ConversationTokenizationInfo,
  lastMessageId?: string,
): number | null {
  if (!tokenization.encoding) return null;
  const serialized = serializeForTokenCounting(messages);
  const key = branchSignature(
    serialized,
    messages.length,
    lastMessageId,
    tokenization.encodingModelName ?? tokenization.normalizedModelName,
  );
  const cached = exactTokenCache.get(key);
  if (cached !== undefined) {
    // Refresh recency: delete + re-insert so the oldest entries evict first.
    exactTokenCache.delete(key);
    exactTokenCache.set(key, cached);
    return cached;
  }
  const count = encodeCapped(serialized, tokenization.encoding);
  exactTokenCache.set(key, count);
  if (exactTokenCache.size > EXACT_TOKEN_CACHE_MAX) {
    const oldest = exactTokenCache.keys().next().value;
    if (oldest !== undefined) exactTokenCache.delete(oldest);
  }
  return count;
}

/** Test-only: clear the memoized exact-count cache. */
export function __clearExactTokenCacheForTests(): void {
  exactTokenCache.clear();
}

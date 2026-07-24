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
 * Fallback context window for a model that is not in {@link MODEL_CONTEXT_WINDOWS}
 * and whose catalog entry omits `maxInputTokens`. Goals: (1) never leave the window
 * null (that disables compaction → unbounded growth → the main-thread freeze);
 * (2) don't cripple a supported LARGE-context provider — the config importer creates
 * Google/Gemini and Anthropic/Claude entries without maxInputTokens, and an 8K
 * assumption would compact them around ~6.5K, repeatedly summarizing a
 * huge-context model; (3) don't ASSUME a large window for a truly unknown /local
 * OpenAI-compatible model — those are often 8K/32K and assuming huge means
 * compaction fires too late and the provider rejects the request.
 *
 * So: recognize common large-context model FAMILIES by name and give them a
 * representative (conservative-within-family) window; fall back to a modest floor
 * only for genuinely unrecognized names. A real catalog entry / maxInputTokens
 * override always takes priority.
 */
const GENERIC_UNKNOWN_CONTEXT_WINDOW = 8192;
function defaultWindowForModel(rawLowerName: string): number {
  const n = rawLowerName;
  // Gemini: 1.5/2.x are 1M+; use a conservative-but-large 128K so a Gemini entry
  // without an explicit limit isn't compacted at 6.5K.
  if (/gemini/.test(n)) return 128_000;
  // Anthropic Claude: 200K standard.
  if (/claude/.test(n)) return 200_000;
  // Llama-3.1+/Mistral/Qwen/Command-R/DeepSeek etc. commonly 32K-128K; 32K middle.
  if (/llama|mistral|mixtral|qwen|command-?r|deepseek/.test(n)) return 32_768;
  // Modern OpenAI GPT / o-series that slipped the table → 128K floor.
  if (/\bgpt-|\bo[0-9]/.test(n)) return 128_000;
  // Genuinely unknown / small local model → modest floor (compact early rather than
  // fail over-window).
  return GENERIC_UNKNOWN_CONTEXT_WINDOW;
}

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
  /** The tiktoken BASE encoding this model uses (e.g. 'o200k_base', 'cl100k_base').
   *  Distinct model names can share a base (gpt-5, gpt-4o, gpt-4.1, o3, o4-mini all
   *  use o200k_base); the compaction gate compares THIS, not encodingModelName, so
   *  every model on the canonical base keeps the fast cached-count path. */
  encodingBaseName: string | null;
  encoding: ModelEncoding | null;
};

/**
 * Map a normalized model name to its tiktoken BASE encoding name. o200k_base is
 * the modern base (GPT-5, GPT-4o, GPT-4.1, GPT-4.5, o-series); cl100k_base is the
 * LEGACY base (original gpt-4 / gpt-4-turbo / gpt-4-32k / dated gpt-4 snapshots,
 * and gpt-3.5). Uses an allowlist of the legacy cl100k families and defaults
 * everything else to o200k_base (matching the resolveEncodingForModel gpt-5
 * fallback), so a modern gpt-4.x (4o/4.1/4.5) or an unknown OpenAI-compatible
 * model is correctly treated as sharing the canonical cache base — NOT lumped into
 * cl100k by a broad `gpt-4*` match.
 */
function encodingBaseFor(normalizedModelName: string): string {
  const n = normalizedModelName;
  // gpt-3.5 family → cl100k.
  if (/^gpt-3\.5|^gpt-35/.test(n)) return 'cl100k_base';
  // Legacy gpt-4 ONLY: bare "gpt-4", gpt-4-turbo/32k/vision, or a dated gpt-4
  // snapshot (gpt-4-0613 / gpt-4-1106 …). Modern gpt-4o / gpt-4.1 / gpt-4.5 are
  // o200k and must NOT match here (they have a '.'  or 'o' immediately after 4).
  if (/^gpt-4(?:-(?:turbo|32k|vision|\d)|$|\b(?![.o]))/.test(n)) return 'cl100k_base';
  return 'o200k_base';
}

export function resolveConversationTokenization(
  modelName: string,
  contextWindowOverride?: number,
): ConversationTokenizationInfo {
  const normalizedModelName = normalizeConversationModelName(modelName);
  const contextWindowTokens =
    typeof contextWindowOverride === 'number' && Number.isFinite(contextWindowOverride) && contextWindowOverride > 0
      ? Math.floor(contextWindowOverride)
      : (MODEL_CONTEXT_WINDOWS[normalizedModelName] ??
        // Family-aware fallback keyed on the raw (lowercased) name so a provider
        // prefix like "google/gemini-1.5-pro" is still recognized.
        defaultWindowForModel(String(modelName).toLowerCase()));

  const encodingModelName = MODEL_ENCODING_ALIASES[normalizedModelName] ?? normalizedModelName;
  const encoding = resolveEncodingForModel(encodingModelName);

  return {
    normalizedModelName,
    contextWindowTokens,
    encodingModelName: encoding ? encodingModelName : null,
    encodingBaseName: encoding ? encodingBaseFor(normalizedModelName) : null,
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
 * of English; 8M chars (≈2M tokens) clears every real window.
 */
export const MAX_SYNC_ENCODE_CHARS = 8_000_000;

/**
 * tiktoken's BPE cost is CONTENT-dependent, not just length-dependent: a long run
 * with few token boundaries (whitespace/punctuation) makes the merge search
 * expensive and can block the main thread well below the hard char cap. tiktoken's
 * pathological case is a long CONSECUTIVE RUN of the same byte (the BPE merge search
 * degrades toward quadratic), so we bound the longest same-character run directly —
 * a run-aware limit, not a fragile boundary-ratio heuristic (a long `/` or `a` run
 * has no boundaries yet is exactly the danger).
 */
const MAX_ENCODE_RUN = 8_192;
/** Above this length, content using at most {@link REPETITIVE_MAX_DISTINCT}
 *  distinct UTF-16 code units is treated as repetitive and the encode is skipped.
 *  The threshold is LOW (16) on purpose: true repetition ('a'…, 'ab'…, '😀'…,
 *  short-pattern loops) uses ≤ a handful of distinct units, whereas ordinary
 *  English prose already uses ~27+ (lowercase) to ~37+ (mixed case + punctuation),
 *  and code/base64 ~30+. A higher threshold (e.g. 64) would wrongly flag normal
 *  prose as repetitive and byte-ceiling it, causing premature/lossy compaction. */
const REPETITIVE_LEN_THRESHOLD = 16_384;
const REPETITIVE_MAX_DISTINCT = 16;

/** Longest run of a single identical character in `s`. Cheap single O(n) scan. */
function longestCharRun(s: string): number {
  let best = 0;
  let cur = 0;
  let prev = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === prev) {
      cur++;
    } else {
      cur = 1;
      prev = c;
    }
    if (cur > best) {
      best = cur;
      if (best > MAX_ENCODE_RUN) return best; // early-out once over the limit
    }
  }
  return best;
}

/**
 * Cheap detector for LARGE REPETITIVE content of ANY pattern (not just a single
 * repeated char): scans distinct UTF-16 code units and bails as soon as more than
 * REPETITIVE_MAX_DISTINCT are seen. A repeated multi-char pattern ('ab'…) or emoji
 * ('😀'… = 2 units) still uses very few distinct units, so it's flagged, whereas
 * real prose/JSON crosses the distinct-unit threshold almost immediately. O(n) with
 * an early-out, so normal content costs ~64 iterations.
 */
function looksRepetitive(s: string): boolean {
  if (s.length <= REPETITIVE_LEN_THRESHOLD) return false;
  const seen = new Set<number>();
  for (let i = 0; i < s.length; i++) {
    seen.add(s.charCodeAt(i));
    if (seen.size > REPETITIVE_MAX_DISTINCT) return false; // diverse → not repetitive
  }
  return true; // large + few distinct code units → repetitive
}

/**
 * Exact token count of a serialized string via tiktoken, UNLESS encoding it
 * synchronously would risk blocking the main thread, in which case fall back to
 * the UTF-8 byte ceiling (a true upper bound: ≤ 1 token/byte for byte-level BPE).
 * The encode is skipped when the string (a) exceeds the hard char cap, (b) contains
 * a long single-character RUN, or (c) is large with very few DISTINCT code units
 * (repetitive of any multi-char pattern / emoji). These are the input shapes that
 * make tiktoken's BPE merge search pathological (toward quadratic). Cost-aware, so
 * a repetitive prompt/tool result can't stall the UI regardless of the pattern.
 * The ceiling is a safe over-estimate for both the gate and budget-fit.
 */
function encodeCapped(serialized: string, encoding: ModelEncoding): number {
  if (serialized.length > MAX_SYNC_ENCODE_CHARS) {
    return Buffer.byteLength(serialized, 'utf8');
  }
  if (longestCharRun(serialized) > MAX_ENCODE_RUN || looksRepetitive(serialized)) {
    // Long single-char run OR large low-diversity (repetitive multi-char/emoji)
    // content → skip the potentially-quadratic BPE encode; use the byte ceiling.
    return Buffer.byteLength(serialized, 'utf8');
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
 * Sum of per-message cached token counts over a branch — the INTEGER-ONLY hot
 * path. A present, valid numeric `tokenCount` is trusted AS-IS (no per-message
 * re-serialization), so a fully-counted branch sums with zero JSON.stringify.
 * Only a message MISSING/invalid a count falls back to the over-biased char
 * estimate.
 *
 * Correctness of "is a cached count still valid?" lives at the WRITE boundary,
 * not here: the store recomputes count+signature whenever a node's content
 * changes (append/edit/redact/plugin upsert — detected via `tokenCountSig`), and
 * the send path strips counts off messages a transform hook actually rewrote. So
 * by the time a message reaches this sum its `tokenCount` is authoritative. Doing
 * a signature check HERE would re-serialize the whole history every turn — exactly
 * the cost the accumulator exists to avoid (codex round 5).
 *
 * Per-message counts individually OMIT the array framing (outer `[` `]` and the
 * inter-element `,`) that a whole-array encode includes, so a naive sum could sit
 * a few tokens BELOW the authoritative count right at the trigger and wrongly skip
 * compaction. We add a small conservative framing overhead per message so the sum
 * stays a true upper bound (over-count only ever causes an unnecessary exact
 * check, never skips a needed one).
 */
const FRAMING_TOKENS_PER_MESSAGE = 4;
export function sumBranchTokenCounts(
  messages: Array<{ tokenCount?: number; role?: unknown; content?: unknown }>,
): number {
  let sum = 0;
  for (const msg of messages) {
    const count = msg?.tokenCount;
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
      sum += count;
    } else {
      // Missing/invalid count → a TRUE ceiling (UTF-8 byte length), not length/3.
      // length/3 assumes ~English density and can UNDER-count token-dense Unicode,
      // letting a genuinely over-window request stay under the gate; the byte
      // ceiling (≤ 1 token/byte for any BPE) never under-counts.
      sum += tokenProjectionByteCeiling(msg ?? {});
    }
    sum += FRAMING_TOKENS_PER_MESSAGE; // account for array delimiters the per-msg count omits
  }
  return sum;
}

/** The tiktoken BASE encoding the storage-layer cached counts are computed with
 *  (gpt-5 → o200k_base). Cached counts are a SAFE gate floor for any model on this
 *  same base — regardless of its specific model name. */
let canonicalBaseCache: string | null | undefined;
export function canonicalCountEncodingBaseName(): string | null {
  if (canonicalBaseCache === undefined) {
    canonicalBaseCache = resolveConversationTokenization('gpt-5').encodingBaseName;
  }
  return canonicalBaseCache;
}

/**
 * Tokenizer-SAFE branch token sum for the compaction gate. Cached per-message
 * `tokenCount`s are computed with the canonical o200k base; they are a safe gate
 * FLOOR for any target model on that SAME base (GPT-5/4o/4.1 + o-series all share
 * o200k_base, even though their model-name strings differ — comparing base, not
 * name, keeps them all on the fast cached-count path). For a model on a DIFFERENT
 * base (e.g. a legacy cl100k `gpt-4`), an o200k count can under-count relative to
 * the target — the branch could be over-window while the cached sum stays under
 * the trigger, skipping compaction and failing the provider request. There we fall
 * back to a model-INDEPENDENT upper bound (UTF-8 byte length, ≤ 1 token/byte for
 * any BPE) so the gate never under-counts.
 */
export function sumBranchTokensForGate(
  messages: Array<{ tokenCount?: number; role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown }>,
  tokenization: ConversationTokenizationInfo,
): number {
  const canonicalBase = canonicalCountEncodingBaseName();
  if (tokenization.encodingBaseName !== null && tokenization.encodingBaseName === canonicalBase) {
    return sumBranchTokenCounts(messages); // same tokenizer base → cached counts are a safe floor
  }
  // Different tokenizer base → model-independent true ceiling (never under-counts).
  let sum = 0;
  for (const msg of messages) sum += tokenProjectionByteCeiling(msg ?? {});
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
/** A message shape carrying the fields that count toward tokens sent to the model. */
export type TokenBearingMessage = {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
};
/**
 * The MODEL-BEARING projection of a message used for counting + signatures.
 * Includes not just `{role, content}` but also the legacy/plugin top-level
 * `tool_calls` and `tool_call_id` fields, which are sent to the model and can
 * carry large serialized arguments. Omitting them let a message with big
 * top-level tool args under-count (sum below trigger → exact check skipped → an
 * over-limit request), and a top-level tool_calls rewrite wouldn't change the
 * signature. Only fields present are included, so a plain `{role, content}`
 * message projects identically to before.
 */
export function messageTokenProjection(message: TokenBearingMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: message?.role, content: message?.content };
  if (message?.tool_calls !== undefined) out.tool_calls = message.tool_calls;
  if (message?.tool_call_id !== undefined) out.tool_call_id = message.tool_call_id;
  return out;
}

/** Serialized char length of a message's token-bearing projection — cheap (no
 *  tiktoken), used to budget backfill work. */
export function tokenProjectionSerializedLength(message: TokenBearingMessage): number {
  return serializeForTokenCounting(messageTokenProjection(message)).length;
}

/** True TOKEN CEILING for a message's projection: UTF-8 byte length (byte-level
 *  BPE emits ≤ 1 token per UTF-8 byte). Used when the exact encode is skipped
 *  (over budget / no encoding) so the persisted estimate can never UNDER-count —
 *  even for CJK / rare-Unicode / high-entropy content — and slip under the gate. */
export function tokenProjectionByteCeiling(message: TokenBearingMessage): number {
  return Buffer.byteLength(serializeForTokenCounting(messageTokenProjection(message)), 'utf8');
}

/**
 * Cheap COLLISION-RESISTANT content signature of a message's token-bearing
 * projection: a 32-bit FNV-1a hash of `serializeForTokenCounting({role,content})`
 * combined with its length. Used at the WRITE boundary to decide whether a cached
 * `tokenCount` must be recomputed: if a hook, redaction, or same-id plugin upsert
 * rewrites content, the hash changes and the write recomputes count+sig. A
 * length-only signature would miss a same-length content swap (compressible text →
 * token-dense Unicode), trusting a stale low count; the hash catches that. Not
 * used on the read path (see sumBranchTokenCounts), so its per-message cost is
 * paid only when a message is (re)written.
 */
export function messageContentSig(message: TokenBearingMessage): number {
  const s = serializeForTokenCounting(messageTokenProjection(message));
  // FNV-1a 32-bit over UTF-16 code units (cheap; collision-resistant enough to
  // distinguish a same-length content rewrite). Mix in length as the low bits'
  // companion so length-equal but hash-equal collisions are vanishingly unlikely.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Fold length in so two strings with a hash collision but different lengths
  // still differ; keep it a non-negative 32-bit-ish integer.
  return (h >>> 0) ^ (s.length * 0x9e3779b1);
}

/**
 * Canonical per-message exact count + its content signature, for the storage
 * layer (no model name at append time; all mapped models alias to the gpt-5
 * o200k encoding, which `resolveEncodingForModel` also falls back to). Counts the
 * `{role,content}` projection only (stable across tree bookkeeping). Returns
 * `{count: undefined}` when no encoding is available; `sig` is always returned so
 * the caller can still store/compare it.
 */
export function computeMessageCount(message: TokenBearingMessage): {
  count: number | undefined;
  sig: number;
} {
  const sig = messageContentSig(message);
  if (canonicalEncoding === undefined) {
    canonicalEncoding = resolveEncodingForModel('gpt-5');
  }
  if (!canonicalEncoding) return { count: undefined, sig };
  return { count: encodeCapped(serializeForTokenCounting(messageTokenProjection(message)), canonicalEncoding), sig };
}

/** Back-compat: just the canonical count (see {@link computeMessageCount}). */
export function countMessageTokensCanonical(message: TokenBearingMessage): number | undefined {
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
  return `${encodingModelName}\0${serialized.length}\0${messageCount}\0${lastMessageId ?? ''}`;
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

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
  // Amazon Bedrock large families: Nova (~300K), Titan/other large → 128K floor.
  // Official IDs look like `amazon.nova-pro-v1:0`.
  if (/nova/.test(n)) return 300_000;
  if (/amazon\.|bedrock|titan/.test(n)) return 128_000;
  // Llama-3.1+/Mistral/Qwen/Command-R/DeepSeek etc. commonly 32K-128K; 32K middle.
  if (/llama|mistral|mixtral|qwen|command-?r|deepseek/.test(n)) return 32_768;
  // LEGACY OpenAI GPT windows — must come BEFORE the modern 128K gpt fallback, or an
  // imported entry without maxInputTokens would over-assume 128K and never compact
  // before the provider (16K/8K) rejects the request.
  if (/gpt-3\.5|gpt-35/.test(n)) return 16_384; // gpt-3.5-turbo family ≈ 16K
  if (/gpt-4-32k/.test(n)) return 32_768;
  if (/gpt-4-turbo/.test(n)) return 128_000;
  // 8K ONLY for the original gpt-4 8K models: bare `gpt-4` or the 0314/0613 dated
  // snapshots. All PREVIEWS (1106/0125/vision) and later are 128K — they must NOT
  // match here and fall through to the modern 128K default.
  if (/^gpt-4(?:-(?:0314|0613)|$)/.test(n)) return 8_192;
  // Modern OpenAI GPT / o-series / ChatGPT that slipped the table → 128K floor
  // (includes gpt-4-1106-preview / gpt-4-0125-preview / gpt-4o / gpt-4.1 / …).
  // NB `chatgpt-4o-latest` embeds "gpt" (no word boundary), so match chatgpt too.
  if (/\bgpt-|\bo[0-9]|chatgpt/.test(n)) return 128_000;
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

/**
 * Whether tiktoken ACTUALLY recognizes `modelName` (vs falling back to a default
 * encoder). Used to decide if the resolved encoding's `.name` reflects the target
 * model's real tokenizer: for a recognized model it does (o200k/cl100k/p50k…); for
 * an UNRECOGNIZED model (Claude/Gemini/Llama/most providers) resolveEncodingForModel
 * returns the gpt-5 fallback whose `.name` would MISlabel it o200k, so callers must
 * NOT trust that name for tokenizer-compatibility gating.
 */
const tiktokenRecognizedCache = new Map<string, boolean>();
export function tiktokenRecognizesModel(modelName: string): boolean {
  const cached = tiktokenRecognizedCache.get(modelName);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const enc = encoding_for_model(modelName as Parameters<typeof encoding_for_model>[0]);
    ok = !!enc;
  } catch {
    ok = false;
  }
  tiktokenRecognizedCache.set(modelName, ok);
  return ok;
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
  /** True when `encoding` is the o200k FALLBACK (tiktoken didn't recognize the
   *  model) — i.e. we have NO correct tokenizer for this model. shouldCompact uses
   *  this to decide whether the exact recount is meaningful: a recognized model (any
   *  base) is exact-recounted with its own encoder; an unrecognized/fallback model
   *  uses the byte-ceiling authoritative value (o200k would be the wrong tokenizer). */
  isFallbackEncoding: boolean;
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
        // Family-aware fallback on the NORMALIZED name: normalization strips provider
        // prefixes (openai/, azure:) so the anchored legacy GPT rules match
        // `openai/gpt-4` (→ 8K, not the modern 128K), while family substrings like
        // `gemini`/`claude` survive normalization for the unanchored rules.
        defaultWindowForModel(normalizedModelName));

  const encodingModelName = MODEL_ENCODING_ALIASES[normalizedModelName] ?? normalizedModelName;
  const encoding = resolveEncodingForModel(encodingModelName);

  // encodingBaseName is the tokenizer-compatibility key for the compaction gate.
  // Trust the resolved encoding's real `.name` ONLY when tiktoken actually
  // recognizes the model (so davinci→p50k/cl100k, gpt→o200k are correct). For a
  // model tiktoken does NOT recognize (Claude/Gemini/Llama/most providers),
  // resolveEncodingForModel returns the gpt-5 fallback whose `.name` would MISlabel
  // it o200k and make the gate trust o200k cached counts — which can undercount the
  // provider's real tokenizer and skip needed compaction. So leave it null there:
  // sumBranchTokensForGate then uses the tokenizer-independent byte ceiling.
  const recognized = tiktokenRecognizesModel(encodingModelName);
  let encodingBaseName: string | null = null;
  if (encoding && recognized) {
    const nm = (encoding as { name?: unknown }).name;
    encodingBaseName = typeof nm === 'string' && nm.length > 0 ? nm : encodingBaseFor(normalizedModelName);
  }

  return {
    normalizedModelName,
    contextWindowTokens,
    encodingModelName: encoding ? encodingModelName : null,
    encodingBaseName,
    // Fallback when we have an encoder but tiktoken didn't recognize the model (it's
    // the o200k gpt-5 fallback — the wrong tokenizer). A recognized model (any base)
    // has its correct encoder and is exact-recountable.
    isFallbackEncoding: !!encoding && !recognized,
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
 *  NOTE this runs on the SERIALIZED string (JSON-wrapped message), whose wrapper
 *  (`{"role":"user","content":"…"}`) already contributes ~14 distinct structural
 *  chars. So the threshold must sit in the gap between "repetitive payload + JSON
 *  wrapper" (measured ~16-18, up to ~22 for an 8-char pattern) and "real prose/code
 *  + wrapper" (~31+): 24 catches every repetitive pattern while letting genuine
 *  content encode exactly. (A lower value like 16 let `xyz…` slip past once wrapped;
 *  a higher value like 64 wrongly flagged plain prose.) */
const REPETITIVE_LEN_THRESHOLD = 16_384;
const REPETITIVE_MAX_DISTINCT = 24;

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
 * Even for DIVERSE content (no long run, many distinct chars — e.g. a base64 image
 * payload or a huge tool result), a single synchronous tiktoken encode of a
 * multi-megabyte string blocks the main thread. `appendConversationMessages`
 * counts each message on the main thread as it persists CLI attachments /
 * server-persisted tool results (image payloads near 7 MiB), so the PER-MESSAGE
 * path caps the EXACT encode at this size regardless of diversity: above it, use
 * the safe UTF-8 byte ceiling. Set to the store's per-write backfill budget (1.5M
 * chars ≈ 375k+ tokens) — far above any normal single message.
 *
 * The COMPACTION budget-fit path passes a higher cap ({@link MAX_SYNC_ENCODE_CHARS})
 * because it needs an EXACT whole-branch count for large-context models (GPT-4.1's
 * ~1M-token window ≈ ~4M chars); byte-ceiling there would inflate the value and make
 * budget-fit drop-and-null so compaction could never succeed. The run/repetition
 * guards still apply to both, so a pathological 4M input is still byte-ceilinged.
 */
const SAFE_EXACT_ENCODE_CHARS = 1_500_000;

/**
 * Content-INDEPENDENT per-message exact-encode cap. No distinct-char / run heuristic
 * is complete — a periodic input just above the distinct threshold (e.g.
 * `'abc…xy'.repeat(N)`, 25 distinct) can still make tiktoken pathological on some
 * builds. Since every message is counted synchronously on the main thread as it's
 * persisted, cap the per-message exact encode by SIZE regardless of content: a
 * message whose serialized projection exceeds this many chars byte-ceilings instead
 * of encoding. ~32K chars encodes fast even worst-case; the byte ceiling above it is
 * a safe over-estimate. (The COMPACTION whole-branch path uses the higher
 * MAX_SYNC_ENCODE_CHARS cap for accuracy — it runs rarely and is guarded too.)
 */
const MAX_PER_MESSAGE_EXACT_CHARS = 32_768;

/**
 * Exact token count of a serialized string via tiktoken, UNLESS encoding it
 * synchronously would risk blocking the main thread, in which case fall back to
 * the UTF-8 byte ceiling (a true upper bound: ≤ 1 token/byte for byte-level BPE).
 * The encode is skipped when the string (a) exceeds `maxExactChars`, (b) contains a
 * long single-character RUN, or (c) is large with very few DISTINCT code units
 * (repetitive of any multi-char pattern / emoji). Cost- AND size-aware. The ceiling
 * is a safe over-estimate for both the gate and budget-fit.
 */
function encodeCapped(
  serialized: string,
  encoding: ModelEncoding,
  maxExactChars: number = SAFE_EXACT_ENCODE_CHARS,
): number {
  if (serialized.length > maxExactChars) {
    // Too large to encode synchronously without risking a main-thread stall.
    return Buffer.byteLength(serialized, 'utf8');
  }
  if (longestCharRun(serialized) > MAX_ENCODE_RUN || looksRepetitive(serialized)) {
    // Long single-char run OR large low-diversity (repetitive multi-char/emoji)
    // content → skip the potentially-quadratic BPE encode; use the byte ceiling.
    return Buffer.byteLength(serialized, 'utf8');
  }
  try {
    return encoding.encode(serialized).length;
  } catch {
    // tiktoken.encode() THROWS on literal reserved-marker text (e.g. `<|endoftext|>`)
    // — special tokens are disallowed by default. This runs on the write/append path,
    // so a throw would block persisting the turn (and any later write to a
    // conversation already containing the marker). Fall back to the safe byte ceiling
    // rather than crash; the count is only a gate/budget input.
    return Buffer.byteLength(serialized, 'utf8');
  }
}

/**
 * Public capped-encode for the COMPACTION path (budget-fit loop + final safety
 * re-encode). Uses the HIGHER {@link MAX_SYNC_ENCODE_CHARS} exact-encode cap so a
 * legitimate large-context whole-branch prefix (up to ~4M chars for a 1M-token
 * window) is counted exactly and budget-fit can succeed — while the run/repetition
 * guards still byte-ceiling genuinely pathological content.
 */
export function encodeCappedWith(serialized: string, encoding: ModelEncoding): number {
  return encodeCapped(serialized, encoding, MAX_SYNC_ENCODE_CHARS);
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
  messages: Array<{
    tokenCount?: number;
    role?: unknown;
    content?: unknown;
    tool_calls?: unknown;
    tool_call_id?: unknown;
  }>,
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
  // Per-message path: cap the exact encode at the low content-independent size so a
  // large/periodic single message can't stall the main thread on append.
  return {
    count: encodeCapped(
      serializeForTokenCounting(messageTokenProjection(message)),
      canonicalEncoding,
      MAX_PER_MESSAGE_EXACT_CHARS,
    ),
    sig,
  };
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
  // Whole-branch count for the compaction decision → use the HIGHER compaction
  // exact-encode cap (via encodeCappedWith), not the low per-message default. A 2M+
  // char diverse large-context branch (e.g. ~450k GPT-4.1 tokens, under trigger)
  // must be counted exactly, or byte-ceiling it would falsely trip compaction.
  const count = encodeCappedWith(serialized, tokenization.encoding);
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

// ---------------------------------------------------------------------------
// Off-main-thread whole-branch encoding (see electron/agent/tokenizer-worker.ts)
// ---------------------------------------------------------------------------
//
// The synchronous encodeCappedWith/countBranchTokensCached above stay for the
// per-message path (already 32K-capped) and for any caller that can't await.
// The WHOLE-BRANCH compaction encodes — the ones that can freeze the main
// thread on a large/pathological history — go through the worker via
// countBranchTokensCachedAsync. The main thread awaits the worker result, so
// the event loop stays live while the CPU-bound encode runs off-thread.

import { Worker } from 'node:worker_threads';
import { join } from 'node:path';

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; id: number; count: number }
  | { type: 'error'; id: number; message: string };

/** How long to wait for a worker encode before giving up. A genuine
 *  large-context branch encodes in well under a second off-thread; a stuck
 *  worker must never wedge the send path. On timeout we byte-ceiling (a stuck
 *  worker means the input may be exactly the pathological one we moved
 *  off-thread — re-running it synchronously would freeze main). */
const WORKER_ENCODE_TIMEOUT_MS = 15_000;

/**
 * When the worker can't produce the count (unavailable, crashed, timed out, or
 * the turn was aborted), the whole-branch fallback is ALWAYS the UTF-8 byte
 * ceiling — NEVER a synchronous whole-branch tiktoken encode. A multi-megabyte
 * branch is not safe to encode on the Electron main thread regardless of WHY the
 * worker is missing (a missing packaged entry, a tiktoken load failure, an OOM,
 * a stuck encode); doing so would recreate the exact main-thread freeze this
 * worker exists to prevent. The byte ceiling is a true upper bound (≤ 1 token/
 * byte for byte-level BPE), so the compaction gate can only over-trigger, never
 * miss a needed compaction. (The per-message path never uses the worker — it
 * stays synchronous and is already size-capped at MAX_PER_MESSAGE_EXACT_CHARS.)
 */
type EncodeFallback = { ceiling: () => number };

/** Resolution of an off-thread encode: the token count plus whether it is an
 *  EXACT worker result (`exact: true`) or a byte-ceiling FALLBACK (`exact:
 *  false`). Only exact results are cached — a fallback ceiling must not poison
 *  the shared per-branch cache, or an unchanged branch would keep reusing the
 *  inflated value and never re-reach a healthy worker. */
type EncodeOutcome = { count: number; exact: boolean };

type PendingEncode = {
  settle: (outcome: EncodeOutcome) => void;
  fallback: EncodeFallback;
  timer: ReturnType<typeof setTimeout>;
};

let tokenizerWorker: Worker | null = null;
/** True once the worker has posted `ready`. Encodes issued before this are
 *  buffered on the worker's message queue (postMessage is safe pre-ready). */
let tokenizerWorkerReady = false;
/** Set when the worker is known to be unavailable (spawn threw, or it
 *  crashed/exited BEFORE ever signaling ready — e.g. running from .ts source in
 *  tests/dev with no built worker). Whole-branch callers then byte-ceiling. */
let tokenizerWorkerUnavailable = false;
let nextEncodeId = 1;
const pendingEncodes = new Map<number, PendingEncode>();

/** Overridable so tests can point at a built worker or force the unavailable
 *  path. Defaults to the sibling built worker next to the main bundle. */
let tokenizerWorkerPathOverride: string | null = null;
export function __setTokenizerWorkerPathForTests(path: string | null): void {
  tokenizerWorkerPathOverride = path;
  if (tokenizerWorker) {
    try {
      void tokenizerWorker.terminate();
    } catch {
      // ignore
    }
  }
  tokenizerWorker = null;
  tokenizerWorkerReady = false;
  tokenizerWorkerUnavailable = false;
  flushPending();
}

/** Settle and clear all in-flight encodes via the byte ceiling — the only
 *  main-thread-safe fallback (see {@link EncodeFallback}). */
function flushPending(): void {
  for (const p of pendingEncodes.values()) {
    clearTimeout(p.timer);
    p.settle({ count: p.fallback.ceiling(), exact: false });
  }
  pendingEncodes.clear();
}

/**
 * The worker crashed/exited. In-flight encodes settle via the BYTE CEILING (the
 * only main-thread-safe fallback — a crash can be an input-correlated OOM on a
 * huge branch, and even a pre-ready load failure doesn't make a multi-megabyte
 * branch safe to encode synchronously on main). If the crash happened BEFORE the
 * worker ever signaled ready, the worker module failed to load (no built worker
 * in dev/test, or a tiktoken load throw) → mark it permanently unavailable so we
 * stop respawning; a post-ready crash drops the handle so the next encode
 * respawns a fresh worker.
 */
function handleWorkerDown(worker: Worker): void {
  // Idempotent: 'error' and 'exit' both fire on a crash — only act on the first,
  // and ignore events from a worker we've already replaced.
  if (tokenizerWorker !== worker) return;
  const wasReady = tokenizerWorkerReady;
  tokenizerWorker = null;
  tokenizerWorkerReady = false;
  if (!wasReady) tokenizerWorkerUnavailable = true;
  flushPending();
}

/**
 * A live encode exceeded the timeout. The worker may still be spinning in a
 * synchronous WASM encode of a pathological input, so leaving it in place would
 * make it hold a CPU core and force EVERY later encode to wait another full
 * timeout behind it. Force-terminate it and drop the handle so the next encode
 * spawns a fresh worker. Its queued encodes settle via the BYTE CEILING.
 * Terminating a still-ready worker does NOT mark it unavailable.
 */
function terminateStuckWorker(worker: Worker): void {
  if (tokenizerWorker !== worker) return;
  // Detach handlers so the pending exit/error from terminate() doesn't re-enter
  // handleWorkerDown.
  worker.removeAllListeners();
  try {
    void worker.terminate();
  } catch {
    // ignore
  }
  tokenizerWorker = null;
  tokenizerWorkerReady = false;
  flushPending();
}

function ensureTokenizerWorker(): Worker | null {
  if (tokenizerWorkerUnavailable) return null;
  if (tokenizerWorker) return tokenizerWorker;
  const path = tokenizerWorkerPathOverride ?? join(import.meta.dirname, 'tokenizer-worker.js');
  try {
    const worker = new Worker(path);
    worker.on('message', (msg: WorkerMessage) => {
      if (msg?.type === 'ready') {
        tokenizerWorkerReady = true;
        return;
      }
      const pending = pendingEncodes.get(msg.id);
      if (!pending) return;
      pendingEncodes.delete(msg.id);
      clearTimeout(pending.timer);
      // A normal result carries the EXACT count (cacheable); a worker-reported
      // encode error is defensive (the worker already byte-ceilings pathological
      // input) → byte-ceiling fallback (not cacheable), never a whole-branch sync
      // encode on main.
      if (msg.type === 'result') pending.settle({ count: msg.count, exact: true });
      else pending.settle({ count: pending.fallback.ceiling(), exact: false });
    });
    worker.on('error', () => handleWorkerDown(worker));
    worker.on('exit', () => handleWorkerDown(worker));
    worker.unref(); // don't keep the process alive for this helper
    tokenizerWorker = worker;
    return worker;
  } catch {
    // Spawn threw synchronously → unavailable; whole-branch callers byte-ceiling.
    tokenizerWorkerUnavailable = true;
    return null;
  }
}

/** Terminate the tokenizer worker (call on app quit). Safe to call when none
 *  was ever spawned. In-flight encodes settle via the BYTE CEILING — never a
 *  synchronous whole-branch encode: doing that in the `before-quit` handler
 *  could freeze shutdown on the large/pathological input this worker isolates. */
export function terminateTokenizerWorker(): void {
  flushPending();
  if (tokenizerWorker) {
    try {
      void tokenizerWorker.terminate();
    } catch {
      // ignore
    }
    tokenizerWorker = null;
    tokenizerWorkerReady = false;
  }
}

/**
 * Encode a single serialized string off-thread, resolving to the exact token
 * count. Returns null when the worker is unavailable so the caller uses the
 * synchronous path directly. On a live-worker TIMEOUT the promise resolves to
 * the byte ceiling; on a worker crash it resolves to the caller's sync
 * fallback (see {@link EncodeFallback}). Never rejects — always resolves to a
 * safe number so the send path can't be wedged.
 */
function encodeSerializedAsync(
  serialized: string,
  encodingModel: string,
  maxExactChars: number,
  fallback: EncodeFallback,
  signal?: AbortSignal,
): Promise<EncodeOutcome> | null {
  // Already cancelled before we even start → don't spawn/post anything (no
  // watchdog is needed for a job that was never submitted, and posting would
  // occupy the sole worker and delay the replacement run). Byte-ceiling now.
  if (signal?.aborted) return Promise.resolve({ count: fallback.ceiling(), exact: false });
  const worker = ensureTokenizerWorker();
  if (!worker) return null;
  const id = nextEncodeId++;
  return new Promise<EncodeOutcome>((resolve) => {
    let settled = false;
    let onAbort: (() => void) | null = null;
    const settle = (outcome: EncodeOutcome): void => {
      if (settled) return;
      settled = true;
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      // Live worker but stuck (possibly mid-WASM on a pathological input) →
      // force-terminate + respawn-on-next so it can't hold a core and make
      // every later encode wait behind it. This settles THIS request (and any
      // other queued behind the same worker) via the byte ceiling.
      terminateStuckWorker(worker);
    }, WORKER_ENCODE_TIMEOUT_MS);
    pendingEncodes.set(id, { settle, fallback, timer });

    // If the owning turn is cancelled/superseded AFTER submission, stop awaiting
    // and settle THIS caller with the byte ceiling. We do NOT terminate the
    // shared worker (it may be mid-encode for OTHER live conversations) and — key
    // for the watchdog — we DELIBERATELY leave the pending entry and its timeout
    // in place. The caller has its answer, but the orphan job's watchdog stays
    // armed: if the worker is genuinely stuck on this (possibly pathological)
    // encode, the timeout still fires terminateStuckWorker so it can't spin a CPU
    // core forever; if the job completes normally, its result clears the timer.
    // The idempotent settle() means the later result/timeout won't re-resolve the
    // caller. (An already-aborted signal was handled before submission above.)
    if (signal) {
      onAbort = () => settle({ count: fallback.ceiling(), exact: false });
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      worker.postMessage({ type: 'encode', id, encodingModel, text: serialized, maxExactChars });
    } catch {
      pendingEncodes.delete(id);
      clearTimeout(timer);
      // postMessage failed (worker dying) → byte ceiling (never a whole-branch
      // sync encode on main).
      settle({ count: fallback.ceiling(), exact: false });
    }
  });
}

/**
 * Off-thread equivalent of {@link encodeCappedWith} for the COMPACTION path
 * (budget-fit loop + final safety re-encode). Awaits the tokenizer worker so the
 * repeated whole-prefix encodes don't block the main thread. When the worker is
 * unavailable OR fails/times out, falls back to the UTF-8 BYTE CEILING — never a
 * synchronous whole-branch encode on main (that would recreate the freeze). The
 * ceiling is a safe upper bound: budget-fit only ever keeps FEWER messages, and
 * the final safety check only ever returns the null no-op, so an over-estimate
 * can't produce an over-budget compacted request.
 */
export async function encodeCappedWithAsync(
  serialized: string,
  tokenization: ConversationTokenizationInfo,
  signal?: AbortSignal,
): Promise<number> {
  if (!tokenization.encoding) return Buffer.byteLength(serialized, 'utf8');
  const encodingModel = tokenization.encodingModelName ?? tokenization.normalizedModelName;
  const pending = encodeSerializedAsync(
    serialized,
    encodingModel,
    MAX_SYNC_ENCODE_CHARS,
    { ceiling: () => Buffer.byteLength(serialized, 'utf8') },
    signal,
  );
  return pending ? (await pending).count : Buffer.byteLength(serialized, 'utf8');
}

/**
 * Whole-branch exact token count, computed OFF the main thread, sharing the
 * per-branch LRU with {@link countBranchTokensCached}. The main thread awaits the
 * worker, so the event loop stays live during the CPU-bound encode.
 *
 * When the worker is unavailable (dev/test from source, a missing packaged
 * entry, a tiktoken load failure) OR it crashes / times out, falls back to the
 * UTF-8 BYTE CEILING — NEVER a synchronous whole-branch encode on main, which
 * would recreate the very freeze this worker prevents (a multi-megabyte branch
 * isn't safe to encode on the main thread regardless of why the worker is
 * missing). The ceiling never under-counts, so the compaction gate can only
 * over-trigger, never miss a needed compaction.
 */
export async function countBranchTokensCachedAsync(
  messages: unknown[],
  tokenization: ConversationTokenizationInfo,
  lastMessageId?: string,
  signal?: AbortSignal,
): Promise<number | null> {
  if (!tokenization.encoding) return null;
  const serialized = serializeForTokenCounting(messages);
  const encodingModel = tokenization.encodingModelName ?? tokenization.normalizedModelName;
  const key = branchSignature(serialized, messages.length, lastMessageId, encodingModel);
  const cached = exactTokenCache.get(key);
  if (cached !== undefined) {
    exactTokenCache.delete(key);
    exactTokenCache.set(key, cached);
    return cached;
  }

  const ceiling = (): number => Buffer.byteLength(serialized, 'utf8');
  const pending = encodeSerializedAsync(serialized, encodingModel, MAX_SYNC_ENCODE_CHARS, { ceiling }, signal);
  // pending === null → worker unavailable → byte ceiling (safe, non-blocking).
  const outcome: EncodeOutcome = pending ? await pending : { count: ceiling(), exact: false };

  // Cache ONLY genuine exact worker results. A byte-ceiling fallback (worker
  // unavailable/crash/timeout/abort) must not poison the shared per-branch cache
  // — otherwise an unchanged branch would keep reusing the inflated ceiling and
  // never re-reach a healthy (respawned) worker, potentially compacting far below
  // the real trigger.
  if (outcome.exact) {
    exactTokenCache.set(key, outcome.count);
    if (exactTokenCache.size > EXACT_TOKEN_CACHE_MAX) {
      const oldest = exactTokenCache.keys().next().value;
      if (oldest !== undefined) exactTokenCache.delete(oldest);
    }
  }
  return outcome.count;
}

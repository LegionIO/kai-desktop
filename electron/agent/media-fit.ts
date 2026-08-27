/**
 * Budget-aware fitting of model-visible tool-result MEDIA (native `_modelContent`
 * image parts) into the model's REMAINING context window.
 *
 * Text tool results are shrunk by the tool/conversation compaction paths
 * (head/tail truncation or AI summarization). A base64 image can't be sliced, so
 * when one would push the turn over the remaining budget we either RE-ENCODE it
 * smaller (`downscale`) or DROP it with a note (`drop`). `downscale` shrinks the
 * image's longest edge (and, for lossy formats, quality) toward the configured
 * floor; if even the floor version doesn't fit, it fails safe like `drop` — the
 * part is replaced with a text note to the model (and the caller surfaces a UI
 * warning suggesting `/compact`).
 *
 * `sharp` is a native addon loaded lazily via dynamic import so this module (and
 * its pure helpers) is importable/testable without the binary present; when sharp
 * is unavailable the downscale path degrades to the fail-safe drop-with-note.
 */

import type SharpNs from 'sharp';
import { join, sep } from 'path';
import { getMaxPartBytes, getMaxTotalBytes } from './tool-model-content.js';
import { safeReadRangeWithin } from '../utils/safe-file-read.js';

/** Bounded, symlink-safe byte size of an offloaded `kai-media://` value's file,
 *  or null (unknown / outside media dir / missing). Used so token+byte accounting
 *  attributes an offloaded attachment its REAL size instead of the ~40-char URL
 *  string — otherwise /compact and the media budget under-count it. A 1-byte
 *  ranged read yields the total size without buffering the file. */
function offloadedMediaSize(value: string, appHome: string): number | null {
  const prefix = __BRAND_MEDIA_PROTOCOL + '://';
  if (!value.startsWith(prefix)) return null;
  const mediaDir = join(appHome, 'media');
  const rel = value.slice(prefix.length).split('?')[0];
  let rp: string;
  try {
    rp = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const filePath = join(mediaDir, rp);
  if (filePath !== mediaDir && !filePath.startsWith(mediaDir + sep)) return null;
  const probe = safeReadRangeWithin(mediaDir, filePath, 0, 0);
  return probe ? probe.size : null;
}

/** Media-fit settings, mirroring the `compaction.media` config section. */
export type MediaFitConfig = {
  enabled: boolean;
  strategy: 'downscale' | 'drop';
  /** Smallest longest-edge (px) downscale will target before failing safe. */
  minDimension: number;
  /** Lowest lossy re-encode quality (1-100) before failing safe. */
  minQuality: number;
  /** Tokens held back from the window when computing remaining budget. */
  reserveTokens: number;
};

/** Bare base64 (no data: prefix), as carried on a ModelContentPart. */
function approxBytesFromBase64(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

/** Strip a leading `data:<mime>;base64,` prefix so the value is genuine base64.
 *  A `_modelContent` image MAY arrive in data-URL form (extractModelContent
 *  normalizes it downstream, but media-fit runs BEFORE that). Decoding the whole
 *  data-URL string as base64 would include the prefix bytes and corrupt the image
 *  signature, so sharp couldn't read it → the image would be dropped instead of
 *  resized. Mirrors extractModelContent's DATA_URL_RE handling. */
const DATA_URL_RE = /^data:[^;,]*(?:;[^,]*)?,(.*)$/s;
function stripDataUrlPrefix(data: string): string {
  const m = DATA_URL_RE.exec(data);
  return m ? (m[1] ?? '') : data;
}

/** Decoded byte length of a media payload (data-URL prefix stripped first). Used by
 *  the turn to sum the branch's retained media bytes so the whole-request media
 *  ceiling accounts for what prior turns already committed, not just this turn. */
export function decodedMediaBytes(data: string): number {
  return approxBytesFromBase64(stripDataUrlPrefix(data));
}

/** Extract the declared MIME from a `data:<mime>;base64,...` URL (or undefined for
 *  a bare base64 string). Used so a file whose OUTER mediaType is generic (e.g.
 *  application/octet-stream) but whose data-URL declares application/pdf still gets
 *  the document expansion estimate — matching how the downstream sanitizer adopts
 *  the data-URL MIME. */
const DATA_URL_MIME_RE = /^data:([^;,]*)[;,]/s;
function dataUrlMediaType(data: string): string | undefined {
  const m = DATA_URL_MIME_RE.exec(data);
  const mime = m?.[1]?.trim();
  return mime ? mime : undefined;
}

/** True TOKEN CEILING for a text string: UTF-8 byte length (byte-level BPE emits
 *  ≤ 1 token per UTF-8 byte). A safe OVER-estimate even for token-dense Unicode
 *  (where chars/4 would UNDER-count and let text overflow the budget). */
function estimateTextTokens(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Head/tail-truncate `text` so its UTF-8 byte length (the token ceiling) fits
 *  ~maxTokens, with a marker. Never returns MORE bytes than the input. Because
 *  the ceiling counts BYTES, truncation uses a byte budget: slice by chars then
 *  verify, shrinking if a multibyte tail pushed it back over. */
function truncateTextToTokens(text: string, maxTokens: number): string {
  const marker = '\n\n...[content truncated to fit the context window]...\n\n';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  // Budget too small to hold even the marker → return a marker bounded BY the
  // budget (possibly empty). With reserveTokens:0 near a full window, emitting a
  // fixed 17-byte marker anyway could itself overflow, so clamp to maxTokens.
  if (maxTokens <= markerBytes) {
    return maxTokens <= 0 ? '' : '...[truncated]...'.slice(0, Math.max(0, maxTokens));
  }
  const keepBytes = maxTokens - markerBytes;
  if (estimateTextTokens(text) <= maxTokens) return text;
  // Char budget ≈ byte budget (worst case 1 byte/char for ASCII; multibyte only
  // makes the result SHORTER in chars), then verify + shrink.
  let head = Math.floor(keepBytes * 0.7);
  let tail = keepBytes - head;
  let out = text.slice(0, head) + marker + (tail > 0 ? text.slice(text.length - tail) : '');
  for (let i = 0; i < 8 && estimateTextTokens(out) > maxTokens; i++) {
    head = Math.floor(head * 0.7);
    tail = Math.floor(tail * 0.7);
    out = text.slice(0, head) + marker + (tail > 0 ? text.slice(text.length - tail) : '');
  }
  return out;
}

/**
 * Hard ceiling on a single image's DECODED byte size that we're willing to feed
 * to `Buffer.from`/sharp. Untrusted plugin `_modelContent` reaches here; a
 * multi-hundred-MB base64 blob would otherwise force an unbounded allocation +
 * native libvips decode before we even measure it. Reads the SAME per-part cap
 * the downstream `extractModelContent` sanitizer enforces (configurable via
 * `compaction.media.maxImageBytes`) — anything larger is dropped WITHOUT decoding
 * (it would be dropped downstream regardless). The base64 STRING length is
 * checked first (cheap, no allocation).
 */
function maxDecodeBytes(): number {
  return getMaxPartBytes();
}
/** Whole-REQUEST media byte ceiling (branch + this turn), the default for
 *  fitModelContentToBudget's maxTotalMediaBytes. Larger than the per-tool-result
 *  cap (extractModelContent's per-result total) because a request legitimately
 *  carries media from several turns; kept well under typical provider request
 *  limits (Anthropic ~32 MB total incl. text/schemas) so the media alone can't
 *  bloat a request that also carries the transcript + tool schemas. */
export const DEFAULT_MAX_TOTAL_MEDIA_BYTES = 20 * 1024 * 1024;
/** Max base64 chars for the per-part decode cap (base64 inflates ~4/3). A
 *  generous upper bound so we reject before allocating the Buffer. */
function maxDecodeBase64Chars(): number {
  return Math.ceil((maxDecodeBytes() * 4) / 3) + 4;
}

/**
 * Max decoded PIXEL AREA (width×height) we're willing to actually re-encode. The
 * byte-size cap bounds only the COMPRESSED payload — a small highly-compressed
 * image can still decode to enormous dimensions (a "pixel bomb") and blow memory/
 * CPU in the libvips decode. sharp's `metadata()` reads only the header (cheap, no
 * full decode), so we check area BEFORE any resize/decode and drop over-area
 * images. Also passed to sharp as `limitInputPixels` for defense-in-depth. 100 MP
 * (e.g. 10000×10000) is far above any legitimate screenshot/diagram. */
const MAX_DECODE_PIXELS = 100_000_000;

/** Working JPEG/WebP re-encode quality (the config `minQuality` is only a FLOOR).
 *  The downscale loop fits by reducing dimensions, so images keep good quality. */
const DEFAULT_JPEG_QUALITY = 82;

/**
 * Coarse UPPER-BOUND estimate of the tokens a provider will charge for an image
 * of the given pixel dimensions. Real formulas differ per provider (Anthropic
 * ≈ (w·h)/750; OpenAI tiles ≈ 85 base + 170·tiles), but they all scale with
 * PIXEL AREA, not base64 length. We use the more expensive of the two families
 * so the estimate never UNDER-counts (an over-estimate only ever makes us shrink
 * a little more aggressively, which is the safe direction). Callers that only
 * know the byte size use {@link estimateImageTokensFromBytes} instead.
 */
export function estimateImageTokensFromDimensions(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 0;
  }
  const area = width * height;
  // Anthropic-style area cost.
  const anthropic = Math.ceil(area / 750);
  // OpenAI legacy tile cost: 512px tiles, ~170 tokens each + 85 base.
  const tiles = Math.ceil(width / 512) * Math.ceil(height / 512);
  const openaiTiles = 85 + 170 * tiles;
  // OpenAI PATCH-based cost (GPT-4.1 mini/nano, o4-mini): billed in 32px patches,
  // capped at 1536 patches, then scaled by a per-model multiplier (nano ≈ 2.46,
  // mini ≈ 1.62). Use the LARGEST multiplier so we never under-count that family —
  // a 1024×1024 image is ~1024 patches × 2.46 ≈ 2519 tokens, which the tile/area
  // formulas above undercount (~1399). Over-estimating only shrinks more.
  const PATCH = 32;
  const MAX_PATCHES = 1536;
  const PATCH_MULT_MAX = 2.5;
  const patches = Math.min(MAX_PATCHES, Math.ceil(width / PATCH) * Math.ceil(height / PATCH));
  const openaiPatch = Math.ceil(patches * PATCH_MULT_MAX);
  return Math.max(anthropic, openaiTiles, openaiPatch);
}

/**
 * Fallback token estimate when only the encoded byte size is known (sharp
 * unavailable / metadata unreadable). Base64 bytes are a POOR proxy for image
 * token cost, but a deliberate over-estimate keeps the fail-safe conservative:
 * assume a dense ~2 bytes/token so a large image reads as "expensive" and we
 * prefer to shrink/drop rather than risk an over-budget request.
 */
export function estimateImageTokensFromBytes(base64: string): number {
  return Math.ceil(approxBytesFromBase64(base64) / 2);
}

/**
 * Token estimate for a FILE part (PDF, doc, etc.) from its encoded byte size.
 * Unlike images, files have no dimensions and may be text-dense — provider-side
 * extraction can approach 1 token/byte — so bytes/2 is NOT a safe upper bound.
 * Base estimate = full decoded byte count.
 *
 * For DOCUMENT types (PDF/Office/RTF) the provider parses, decompresses, and often
 * RENDERS pages before charging tokens, so the token cost can EXCEED the encoded
 * bytes (a compact many-page PDF). The encoded-byte count is then not a true
 * ceiling. We can't know the true expansion client-side (a document is compressed —
 * a zip/PDF can decompress to far more text than its bytes suggest, and safely
 * bounding that would require decompressing untrusted content), so a single
 * multiplier can't be a guaranteed upper bound. We use a CONSERVATIVE multiplier
 * biased toward shrink/drop (the safe direction), and the HARD backstops are the
 * per-part 5 MiB cap + the whole-request media BYTE ceiling (which bound how many
 * document bytes reach the provider regardless of token estimate) plus the reserve.
 * Non-document files (plain data blobs, ~1 token/byte) stay at the byte count.
 */
const DOCUMENT_EXPANSION_MULTIPLIER = 5;
function isDocumentMediaType(mediaType: string | undefined): boolean {
  if (!mediaType) return false;
  const m = mediaType.toLowerCase();
  return (
    m.includes('pdf') ||
    m.includes('msword') ||
    m.includes('officedocument') ||
    m.includes('opendocument') ||
    m.includes('rtf') ||
    m.includes('epub') ||
    m.includes('powerpoint') ||
    m.includes('excel') ||
    m.includes('spreadsheet') ||
    m.includes('presentation')
  );
}
export function estimateFileTokensFromBytes(base64: string, mediaType?: string): number {
  const bytes = approxBytesFromBase64(stripDataUrlPrefix(base64));
  // A document is a document whether declared via the outer mediaType OR the
  // data-URL's own MIME (the downstream sanitizer adopts the data-URL MIME, so a
  // generic outer type must not let a PDF bypass the 3× document estimate).
  const isDoc = isDocumentMediaType(mediaType) || isDocumentMediaType(dataUrlMediaType(base64));
  return isDoc ? bytes * DOCUMENT_EXPANSION_MULTIPLIER : bytes;
}

/** Native token estimate from a KNOWN decoded byte count (for an offloaded
 *  kai-media:// attachment whose bytes we don't read — only its file size). Mirrors
 *  estimateImageTokensFromBytes / estimateFileTokensFromBytes but takes raw bytes,
 *  and (having no data-URL) relies solely on the declared mediaType for the
 *  document check. */
export function estimateNativeTokensFromSize(bytes: number, isImage: boolean, mediaType?: string): number {
  if (bytes <= 0) return 0;
  if (isImage) return Math.ceil(bytes / 2);
  return isDocumentMediaType(mediaType) ? bytes * DOCUMENT_EXPANSION_MULTIPLIER : bytes;
}

/** LRU cache of native token estimates keyed by a fast hash of the bare base64.
 *  A payload's dimensions are immutable, and the branch-sum path re-probes the
 *  SAME historical media on every tool result of a turn — caching turns that from
 *  O(history) sharp decodes per result into one decode per distinct payload. */
const nativeMediaTokenCache = new Map<string, number>();
const NATIVE_MEDIA_CACHE_MAX = 512;
/** Cheap, collision-resistant cache key WITHOUT hashing the whole payload: the
 *  byte length plus an FNV-1a over the first + last 1KB. Hashing the full multi-MB
 *  base64 (SHA-256) on every fitting pass would stall the main thread on a media-
 *  heavy branch; sampling the ends + length distinguishes distinct images (two
 *  different images sharing an exact length AND identical 1KB head+tail don't
 *  occur in practice). */
const CACHE_KEY_SAMPLE = 1024;
function cacheKeyFor(s: string): string {
  const head =
    s.length <= CACHE_KEY_SAMPLE * 2 ? s : s.slice(0, CACHE_KEY_SAMPLE) + s.slice(s.length - CACHE_KEY_SAMPLE);
  let h = 0x811c9dc5;
  for (let i = 0; i < head.length; i++) {
    h ^= head.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}:${s.length}`;
}

/**
 * Best-available native token estimate for one media payload, for the BRANCH
 * token sum (prior-turn media). Prefers a dimension-based estimate via sharp's
 * header parse (cheap, no full decode); falls back to the byte estimate when
 * sharp is unavailable, the header can't be read, or the payload is a non-image
 * file / oversized. Data-URL prefixes are stripped first. RESULT IS CACHED by
 * payload hash (dimensions are immutable) so a media-heavy history isn't
 * re-decoded on every tool result.
 */
export async function estimateNativeMediaTokens(data: string, isImage: boolean, mediaType?: string): Promise<number> {
  const bare = stripDataUrlPrefix(data);
  if (!isImage) {
    // FILES have no dimensions; use the decoded byte count, with a document
    // expansion multiplier for PDF/Office/etc. (provider-side rasterization can
    // exceed the encoded size). Pass the ORIGINAL data (not the prefix-stripped
    // `bare`) so estimateFileTokensFromBytes can read the data-URL's own MIME for
    // the document check when the outer mediaType is generic.
    return estimateFileTokensFromBytes(data, mediaType);
  }
  const byteEst = estimateImageTokensFromBytes(bare);
  // Probe cap for the ESTIMATE path is larger than the fit path's 5 MiB decode cap:
  // a top-level user attachment (not subject to the 5 MiB _modelContent sanitizer cap)
  // is legitimately larger and IS sent to the provider, so it must get an ACCURATE
  // dimension-based estimate — a 6 MiB 4096×4096 JPEG is ~22K tokens, not the ~3.1M
  // the byte fallback would charge (which zeroes the budget and drops later media).
  // metadata() is header-only (no pixel decode), so probing up to the whole-request
  // media ceiling is cheap; beyond that, fall back to the byte estimate.
  const MAX_ESTIMATE_BASE64_CHARS = Math.ceil((DEFAULT_MAX_TOTAL_MEDIA_BYTES * 4) / 3) + 4;
  if (bare.length > MAX_ESTIMATE_BASE64_CHARS) return byteEst;
  const key = cacheKeyFor(bare);
  const cached = nativeMediaTokenCache.get(key);
  if (cached !== undefined) {
    // Refresh recency.
    nativeMediaTokenCache.delete(key);
    nativeMediaTokenCache.set(key, cached);
    return cached;
  }
  const sharpMod = await loadSharp();
  if (!sharpMod) return byteEst;
  let estimate = byteEst;
  try {
    const meta = await sharpMod(Buffer.from(bare, 'base64'), { limitInputPixels: false }).metadata();
    const dimEst = estimateImageTokensFromDimensions(meta.width ?? 0, meta.height ?? 0);
    // Prefer the DIMENSION-based estimate — the accurate proxy for native image
    // token cost. Byte size is unreliable in BOTH directions (a 1 MiB photo
    // over-counts to ~524k "tokens"; a solid-color image under-counts), so only
    // fall back to bytes when dimensions are unreadable (dimEst === 0).
    estimate = dimEst > 0 ? dimEst : byteEst;
  } catch {
    estimate = byteEst;
  }
  nativeMediaTokenCache.set(key, estimate);
  if (nativeMediaTokenCache.size > NATIVE_MEDIA_CACHE_MAX) {
    const oldest = nativeMediaTokenCache.keys().next().value;
    if (oldest !== undefined) nativeMediaTokenCache.delete(oldest);
  }
  return estimate;
}

/**
 * Project a message branch for TOKEN COUNTING by stripping media base64 out of the
 * serialized text and returning the media's NATIVE token estimate separately. A
 * branch stored verbatim (stream-persistence keeps each tool result's `_modelContent`
 * base64) would otherwise count a 1 MiB screenshot as ~1.4M "text" tokens — a massive
 * over-count that wrongly shrinks the media budget. The caller counts the stripped
 * projection as text and ADDS nativeMediaTokens. Bounded concurrency + a probe cap so
 * an untrusted media-heavy branch can't stall the main thread; abort-aware.
 *
 * Shared by the parent turn's inline splitter and the sub-agent fitter so both budget
 * historical media identically.
 */
/** Predicate mirroring extractModelContent's isModelContentPart for a MEDIA part: an
 *  image/file the downstream sanitizer will FORWARD to the provider. Requires non-empty
 *  base64 `data` AND a non-empty string `mediaType`; a file's optional `filename` (if
 *  present) must be a string. A part failing this is DISCARDED before the provider call,
 *  so budget projections must NOT charge its tokens/bytes. */
export function isSanitizerRetainableMedia(p: {
  type?: unknown;
  data?: unknown;
  mediaType?: unknown;
  filename?: unknown;
}): boolean {
  if (p.type !== 'image' && p.type !== 'file') return false;
  if (typeof p.data !== 'string' || p.data.length === 0) return false;
  if (typeof p.mediaType !== 'string' || p.mediaType.length === 0) return false;
  if (p.filename !== undefined && typeof p.filename !== 'string') return false;
  return true;
}

export async function stripBranchMediaForCount(
  messages: readonly unknown[],
  signal?: AbortSignal,
  appHome?: string,
): Promise<{ stripped: unknown[]; nativeMediaTokens: number; retainedMediaBytes: number }> {
  // Mirror extractModelContent's per-tool-result retention so we count ONLY the media
  // the sanitizer actually forwards to the provider — a historical result with four
  // images each over the per-part cap becomes omission notes provider-side, so counting
  // their raw bytes would over-seed the whole-request ceiling and wrongly drop a new
  // small image. Values come from tool-model-content.ts (the single source of truth).
  const SANITIZER_MAX_PART_BYTES = getMaxPartBytes();
  const SANITIZER_MAX_TOTAL_BYTES = getMaxTotalBytes();
  const SANITIZER_MAX_PARTS = 64;
  const mediaToEstimate: Array<{ data: string; isImage: boolean; mediaType?: string }> = [];
  let retainedMediaBytes = 0;
  // Native token estimates for offloaded (kai-media://) attachments resolved by file
  // size above — folded into nativeMediaTokens at the end (they're not in
  // mediaToEstimate, which holds base64 payloads probed via sharp).
  let preResolvedNativeTokens = 0;
  // Consume a `_modelContent` group applying the sanitizer's per-RESULT limits: walk
  // in order up to MAX_PARTS; a media part is retained only if it's under the per-part
  // cap AND keeps the running per-result total under the total cap — otherwise the
  // sanitizer replaces it with an omission note (not sent), so we neither estimate its
  // tokens nor count its bytes.
  const consumeModelContent = (arr: unknown): string => {
    if (!Array.isArray(arr)) return '';
    let text = '';
    let partCount = 0;
    let resultTotalBytes = 0;
    for (const cp of arr) {
      if (partCount >= SANITIZER_MAX_PARTS) break;
      if (!cp || typeof cp !== 'object') continue;
      const c = cp as Record<string, unknown>;
      if (c.type === 'image' || c.type === 'file') {
        // Sanitizer-INVALID media (missing/empty data or mediaType, non-string
        // filename) is DISCARDED before the provider call — don't count it (and, like
        // extractModelContent, it doesn't consume a part slot).
        if (!isSanitizerRetainableMedia(c)) continue;
        partCount += 1;
        const bytes = approxBytesFromBase64(stripDataUrlPrefix(c.data as string));
        if (bytes > SANITIZER_MAX_PART_BYTES || resultTotalBytes + bytes > SANITIZER_MAX_TOTAL_BYTES) {
          // Sanitizer REPLACES over-limit media with a model-visible omission note
          // (it does NOT silently discard it) — mirror that text so the projection
          // counts the note the model actually sees, matching extractModelContent's
          // format exactly. The base64 bytes themselves are NOT counted (not sent).
          const label = c.type === 'image' ? 'image' : 'file';
          text += `[${label} omitted: ${(bytes / (1024 * 1024)).toFixed(1)} MB exceeds the per-result media limit]`;
          continue;
        }
        resultTotalBytes += bytes;
        retainedMediaBytes += bytes;
        mediaToEstimate.push({ data: c.data as string, isImage: c.type === 'image', mediaType: c.mediaType as string });
      } else if (c.type === 'text' && typeof c.text === 'string') {
        partCount += 1;
        text += c.text;
      }
    }
    return text;
  };
  const stripped = messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const rec = m as Record<string, unknown>;
    const content = rec.content;
    if (!Array.isArray(content)) return m;
    let touched = false;
    const cleaned = content.map((part) => {
      if (!part || typeof part !== 'object') return part;
      const p = part as Record<string, unknown>;
      if ((p.type === 'image' || p.type === 'file') && typeof (p.data ?? p.image) === 'string') {
        const data = (p.data ?? p.image) as string;
        // A scheme:// URL is an OFFLOADED (or remote) attachment, not inline base64.
        // For a local kai-media:// value, attribute its REAL bytes/tokens via a bounded
        // symlink-safe size lookup (else counting the ~40-char URL as base64 under-counts
        // the attachment — inflating the media budget and letting /compact wrongly report
        // a protected suffix as safe). Estimate tokens from the byte SIZE (we don't read
        // the bytes here). If the size can't be resolved (missing/outside mediaDir, or no
        // appHome), leave the part UNTOUCHED so its stored tokenCount (if any) is trusted
        // rather than mis-counted. A BARE base64 payload (no scheme) still counts normally.
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(data)) {
          const size = appHome ? offloadedMediaSize(data, appHome) : null;
          if (size === null) return part; // unresolvable → leave untouched
          retainedMediaBytes += size;
          const mediaType = (p.mimeType ?? p.mediaType) as string | undefined;
          // Size-based native token estimate (no bytes needed). estimateImageTokensFromBytes
          // / estimateFileTokensFromBytes accept the DECODED byte count via a fake-length
          // base64 string is unnecessary — use the dimensions-agnostic byte estimators.
          preResolvedNativeTokens += estimateNativeTokensFromSize(size, p.type === 'image', mediaType);
          touched = true;
          const { data: _du, image: _iu, ...restU } = p;
          void _du;
          void _iu;
          return { ...restU, _mediaStripped: true };
        }
        // TOP-LEVEL user attachment (renderer image/file) — NOT routed through the
        // `_modelContent` sanitizer, so its 5 MiB per-part cap does NOT apply: the
        // attachment is forwarded to the provider as-is. Always count it (native token
        // estimate handles a large image correctly via dimensions; full bytes toward
        // the whole-request seed). Applying the sanitizer cap here would wrongly EXCLUDE
        // a legitimate 6 MiB user image that IS sent — under-counting the branch.
        retainedMediaBytes += approxBytesFromBase64(stripDataUrlPrefix(data));
        mediaToEstimate.push({
          data,
          isImage: p.type === 'image',
          mediaType: (p.mimeType ?? p.mediaType) as string | undefined,
        });
        touched = true;
        const { data: _d, image: _i, ...rest } = p;
        void _d;
        void _i;
        return { ...rest, _mediaStripped: true };
      }
      const res = p.result as Record<string, unknown> | undefined;
      // A COMPACTED tool-call part keeps a pre-compaction backup on the OUTER part
      // (originalResult) + UI-only compaction metadata; only `result` is sent. Strip
      // those from the OUTER part so a ~1 MB backup isn't counted as branch text.
      const hasOuterBackup =
        Object.hasOwn(p, 'originalResult') || Object.hasOwn(p, 'compactionMeta') || Object.hasOwn(p, 'compactionPhase');
      if (res && typeof res === 'object' && !Array.isArray(res) && Object.hasOwn(res, '_modelContent')) {
        touched = true;
        const foldedText = consumeModelContent(res._modelContent);
        const { _modelContent, ...restResult } = res;
        void _modelContent;
        const { originalResult: _or, compactionMeta: _cm, compactionPhase: _cp, ...restPart } = p;
        void _or;
        void _cm;
        void _cp;
        return { ...restPart, result: { ...restResult, _foldedMediaText: foldedText } };
      }
      if (hasOuterBackup) {
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
    // Drop any persisted per-message token cache: it was computed over the ORIGINAL
    // content (including the base64 we just stripped). sumBranchTokensForGate trusts a
    // matching cache for canonical models, so keeping it would charge the stripped
    // media AS TEXT and then again via nativeMediaTokens (double-count). Recompute.
    const { tokenCount: _tc, tokenCountSig: _tcs, ...recNoCache } = rec;
    void _tc;
    void _tcs;
    return { ...recNoCache, content: cleaned };
  });

  let nativeMediaTokens = preResolvedNativeTokens;
  const MEDIA_ESTIMATE_CONCURRENCY = 4;
  const MEDIA_ESTIMATE_MAX = 128;
  const toProbe = mediaToEstimate.slice(0, MEDIA_ESTIMATE_MAX);
  for (const item of mediaToEstimate.slice(MEDIA_ESTIMATE_MAX)) {
    nativeMediaTokens += item.isImage
      ? estimateImageTokensFromBytes(item.data)
      : estimateFileTokensFromBytes(item.data, item.mediaType);
  }
  for (let i = 0; i < toProbe.length; i += MEDIA_ESTIMATE_CONCURRENCY) {
    if (signal?.aborted) {
      for (const x of toProbe.slice(i)) {
        nativeMediaTokens += x.isImage
          ? estimateImageTokensFromBytes(x.data)
          : estimateFileTokensFromBytes(x.data, x.mediaType);
      }
      break;
    }
    const batch = toProbe.slice(i, i + MEDIA_ESTIMATE_CONCURRENCY);
    const estimates = await Promise.all(batch.map((x) => estimateNativeMediaTokens(x.data, x.isImage, x.mediaType)));
    for (const e of estimates) nativeMediaTokens += e;
  }
  return { stripped, nativeMediaTokens, retainedMediaBytes };
}

/** Outcome of fitting one image part to a token budget. */
export type FitImageResult =
  | { kind: 'unchanged'; data: string; mediaType: string; estimatedTokens: number }
  | { kind: 'downscaled'; data: string; mediaType: string; estimatedTokens: number; note: string }
  | { kind: 'dropped'; note: string; originalTokens: number };

/** Human-readable MB for notes. */
function mb(base64: string): string {
  return (approxBytesFromBase64(base64) / (1024 * 1024)).toFixed(1);
}

/** The callable sharp factory (`sharp(buffer)`). The ESM `import('sharp')`
 *  namespace's default export IS this factory; CJS interop may expose it as the
 *  namespace itself, so we read `.default` first and fall back to the module. */
type SharpFactory = typeof SharpNs;

/**
 * Lazily load sharp. Returns null when the native addon can't be loaded (dev/test
 * without the binary, or a load failure) so callers fall back to the drop path
 * rather than throwing mid-turn.
 */
async function loadSharp(): Promise<SharpFactory | null> {
  try {
    const mod = (await import('sharp')) as { default?: SharpFactory } & SharpFactory;
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

/**
 * Fit a single base64 image into `budgetTokens`.
 *
 * - If it already fits → `unchanged`.
 * - If strategy is `drop`, or sharp is unavailable, or even the floor version
 *   doesn't fit → `dropped` (caller replaces with the returned note).
 * - Otherwise → `downscaled` with the re-encoded base64 and a note describing the
 *   reduction.
 *
 * The re-encode targets progressively smaller longest edges (halving) down to
 * `minDimension`, re-estimating tokens from the ACTUAL re-encoded output's
 * dimensions/bytes each step, and stops at the first size that fits the budget.
 */
export async function fitImagePart(
  data: string,
  mediaType: string,
  budgetTokens: number,
  config: Pick<MediaFitConfig, 'strategy' | 'minDimension' | 'minQuality'>,
  signal?: AbortSignal,
): Promise<FitImageResult> {
  // Capture any `data:<mime>;base64,` MIME BEFORE stripping the prefix — the
  // `unchanged` path returns the bare (prefix-stripped) bytes, so if the outer
  // mediaType is generic (e.g. application/octet-stream) we must relabel with the
  // data-URL's own MIME (what extractModelContent would have adopted) or a provider
  // may reject bare PNG bytes labeled octet-stream.
  const embeddedMime = dataUrlMediaType(data);
  const effectiveMediaType =
    embeddedMime && (!mediaType || mediaType === 'application/octet-stream') ? embeddedMime : mediaType;
  // Normalize away any `data:<mime>;base64,` prefix so the payload we measure and
  // decode is genuine base64 (a data-URL prefix would corrupt the sharp decode).
  data = stripDataUrlPrefix(data);
  // Refuse to decode an oversized payload — cap the base64 STRING length first
  // (cheap, no allocation) so untrusted plugin content can't force an unbounded
  // Buffer.from()/sharp decode. Above the cap the image would be dropped by the
  // downstream sanitizer anyway; drop it here without touching sharp.
  if (data.length > maxDecodeBase64Chars()) {
    return {
      kind: 'dropped',
      originalTokens: estimateImageTokensFromBytes(data),
      note: `[image omitted: ~${mb(data)} MB exceeds the ${(maxDecodeBytes() / (1024 * 1024)).toFixed(1)} MB per-image limit; resize or re-encode the image smaller, then retry]`,
    };
  }

  // Load sharp for the metadata probe REGARDLESS of strategy — even in `drop`
  // mode we want real dimensions to (a) estimate token cost accurately and (b)
  // catch a compressed pixel bomb. Only the RESIZE step is gated on `downscale`.
  const sharpMod = await loadSharp();

  // On abort, stop before any sharp decode/re-encode and return the original bytes
  // UNCHANGED. The caller only invokes fitImagePart while committing a result; when
  // the turn is aborted that whole result is discarded and nothing is sent, so the
  // return value's fit no longer matters — this just frees CPU/memory promptly
  // instead of grinding through up to 32 halving passes on a huge image.
  const abortedUnchanged = (): FitImageResult => ({
    kind: 'unchanged',
    data,
    mediaType: effectiveMediaType,
    estimatedTokens: estimateImageTokensFromBytes(data),
  });
  if (signal?.aborted) return abortedUnchanged();

  // Without sharp we can't measure real dimensions or resize. Compressed byte size
  // has NO bounded relation to pixel area — a tiny highly-compressed payload can be
  // a huge-dimension image whose native token cost exceeds the whole window — so no
  // byte threshold is safe. Fail CLOSED: drop the unverifiable image with a note.
  // (sharp is a bundled production dependency; this path is effectively dev/test-
  // only or a transient load failure, so the conservative drop has no prod cost.)
  if (!sharpMod) {
    return {
      kind: 'dropped',
      originalTokens: estimateImageTokensFromBytes(data),
      note: `[image omitted: cannot be measured/resized here so its size can't be verified; resize or re-encode the image smaller, then retry]`,
    };
  }

  const buffer = Buffer.from(data, 'base64');
  let meta: { width?: number; height?: number; format?: string; hasAlpha?: boolean };
  try {
    // Read metadata with limitInputPixels DISABLED: metadata() only parses the
    // header (no full decode). sharp's DEFAULT limit (~268MP) would otherwise make
    // metadata() THROW for a large image → the catch below could return a highly-
    // compressed pixel bomb unchanged, bypassing our explicit MAX_DECODE_PIXELS
    // guard. With the limit off, the explicit dimension check right after runs and
    // drops it; the real MAX_DECODE_PIXELS limit is enforced in reencode()'s decode.
    meta = await sharpMod(buffer, { limitInputPixels: false }).metadata();
  } catch {
    // Unreadable/corrupt image → we couldn't measure dimensions, and byte size has
    // no bounded relation to pixel area, so fail CLOSED (drop) like the no-sharp
    // path rather than trusting a byte estimate that can under-count a compressed
    // large-dimension image.
    return {
      kind: 'dropped',
      originalTokens: estimateImageTokensFromBytes(data),
      note: `[image omitted: could not be measured/resized so its size can't be verified; resize or re-encode the image smaller, then retry]`,
    };
  }

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  // Pixel-bomb guard: refuse to resize/decode an image whose declared dimensions
  // exceed the area cap (metadata() above only read the header, no full decode).
  // Drop it — decoding it to downscale is exactly the resource-exhaustion we're
  // avoiding.
  if (width * height > MAX_DECODE_PIXELS) {
    return {
      kind: 'dropped',
      originalTokens: estimateImageTokensFromDimensions(width, height) || estimateImageTokensFromBytes(data),
      note: `[image omitted: ${width}×${height} exceeds the maximum resizable dimensions; resize or re-encode the image smaller, then retry]`,
    };
  }
  const originalTokens = estimateImageTokensFromDimensions(width, height) || estimateImageTokensFromBytes(data);
  if (originalTokens <= budgetTokens) {
    return { kind: 'unchanged', data, mediaType: effectiveMediaType, estimatedTokens: originalTokens };
  }

  // Over budget. In `drop` mode we don't resize — drop with a note (the metadata
  // probe above already gave us an accurate dimension estimate + pixel-bomb
  // guard, so this decision isn't fooled by a compressed large-dimension image).
  if (config.strategy !== 'downscale') {
    return {
      kind: 'dropped',
      originalTokens,
      note: `[image omitted: too large for the remaining context window; run /compact to free space, then retry]`,
    };
  }

  // Downscale: halve the longest edge until it fits or reaches the floor. Loop
  // until the floor is actually hit (a fixed step count could stop early for an
  // extreme-aspect / very large image and drop it even though the floor size
  // would fit). A generous hard cap prevents any pathological infinite loop.
  const longestEdge = Math.max(width, height);
  let targetEdge = longestEdge;
  let atFloor = false;
  for (let i = 0; i < 32 && !atFloor; i++) {
    if (signal?.aborted) return abortedUnchanged();
    targetEdge = Math.floor(targetEdge / 2);
    if (targetEdge <= config.minDimension) {
      // Clamp the floor to at most the ORIGINAL longest edge — never UPSCALE. A misconfigured
      // minDimension larger than the image would otherwise make sharp.resize target a bigger
      // dimension than the source (wasted work / potential large-allocation), and shrinking
      // toward a floor above the source is meaningless.
      targetEdge = Math.min(config.minDimension, longestEdge);
      atFloor = true; // this is the last iteration — the floor attempt
    }

    const reencoded = await reencode(
      sharpMod,
      buffer,
      targetEdge,
      Math.max(1, Math.min(100, Math.max(config.minQuality, DEFAULT_JPEG_QUALITY))),
      meta.format,
      meta.hasAlpha === true,
    );
    if (!reencoded) break; // re-encode failed → fail safe below
    const est = estimateImageTokensFromDimensions(reencoded.width, reencoded.height);
    // The re-encoded output must ALSO fit the downstream per-part byte cap that
    // extractModelContent enforces (maxDecodeBytes) — a large re-encoded PNG can
    // exceed it and be silently dropped there despite being "kept" here. If it's
    // over the byte cap, keep shrinking rather than returning an output that will
    // be discarded downstream.
    if (est <= budgetTokens && reencoded.buffer.byteLength <= maxDecodeBytes()) {
      const outData = reencoded.buffer.toString('base64');
      return {
        kind: 'downscaled',
        data: outData,
        mediaType: reencoded.mediaType,
        estimatedTokens: est,
        note: `[image downscaled to ${reencoded.width}×${reencoded.height} to fit the remaining context window]`,
      };
    }
    // Token-fits but BYTE-cap-bound, and the output is lossy (JPEG): descend
    // quality toward the configured floor (minQuality) before halving dimensions.
    // Lowering quality preserves resolution — the whole point of the quality floor
    // — where a dimension halve would needlessly shed detail (or drop at the floor).
    if (est <= budgetTokens && reencoded.format === 'jpeg' && DEFAULT_JPEG_QUALITY > config.minQuality) {
      const floor = Math.max(1, Math.min(100, config.minQuality));
      // Coarse ~10-point steps from just-below-default down to the floor. Coarse on
      // purpose: each step is a full re-encode, and JPEG size vs quality is smooth
      // enough that a handful of probes find a fitting quality without a per-point
      // search.
      for (let q = DEFAULT_JPEG_QUALITY - 10; ; q -= 10) {
        if (signal?.aborted) return abortedUnchanged();
        const quality = Math.max(floor, q);
        const lower = await reencode(sharpMod, buffer, targetEdge, quality, meta.format, meta.hasAlpha === true);
        if (lower && lower.buffer.byteLength <= maxDecodeBytes()) {
          const lowerEst = estimateImageTokensFromDimensions(lower.width, lower.height);
          if (lowerEst <= budgetTokens) {
            return {
              kind: 'downscaled',
              data: lower.buffer.toString('base64'),
              mediaType: lower.mediaType,
              estimatedTokens: lowerEst,
              note: `[image downscaled to ${lower.width}×${lower.height} @ quality ${quality} to fit the remaining context window]`,
            };
          }
        }
        if (quality <= floor) break; // reached the floor and still over the cap → fall through to halve
      }
    }
    // (loop exits when atFloor was set above and this attempt still didn't fit)
  }

  return {
    kind: 'dropped',
    originalTokens,
    note: `[image omitted: too large for the remaining context window even at the minimum ${config.minDimension}px size; run /compact to free space, then retry]`,
  };
}

/** Map a sharp `format` (or a source mediaType) to an output media type. Lossy
 *  sources re-encode as JPEG (quality-controlled); everything else as PNG. An
 *  image WITH ALPHA never goes to JPEG (which has no alpha channel — sharp would
 *  flatten transparency to black); it re-encodes as PNG to preserve transparency. */
function outputFormatFor(
  sharpFormat: string | undefined,
  hasAlpha: boolean,
): {
  format: 'jpeg' | 'png';
  mediaType: string;
} {
  if (!hasAlpha && (sharpFormat === 'jpeg' || sharpFormat === 'jpg' || sharpFormat === 'webp')) {
    return { format: 'jpeg', mediaType: 'image/jpeg' };
  }
  return { format: 'png', mediaType: 'image/png' };
}

async function reencode(
  sharpMod: SharpFactory,
  buffer: Buffer,
  targetLongestEdge: number,
  quality: number,
  sourceFormat: string | undefined,
  hasAlpha: boolean,
): Promise<{ buffer: Buffer; width: number; height: number; mediaType: string; format: 'jpeg' | 'png' } | null> {
  try {
    const { format, mediaType } = outputFormatFor(sourceFormat, hasAlpha);
    // sharp's resize width/height and jpeg quality require INTEGERS — a fractional
    // value (e.g. a config with minQuality: 90.5, or a computed half-edge) throws
    // and the caller's loop would drop the image instead of downscaling. Floor
    // defensively here (the config schema also validates ints, but on-disk/plugin
    // configs could bypass it, and the halving math can produce fractions).
    const targetEdgeInt = Math.max(1, Math.floor(targetLongestEdge));
    // `.rotate()` with no args auto-orients from EXIF BEFORE resize, then the
    // re-encode strips metadata by default — without this, a JPEG/WebP that
    // relied on an EXIF orientation flag would be resized in its stored (un-
    // rotated) orientation and emitted rotated/mirrored to the model.
    let pipeline = sharpMod(buffer, { limitInputPixels: MAX_DECODE_PIXELS }).rotate().resize({
      width: targetEdgeInt,
      height: targetEdgeInt,
      fit: 'inside',
      withoutEnlargement: true,
    });
    const encodeQuality = Math.max(1, Math.min(100, Math.floor(quality)));
    // PNG is lossless — quality doesn't apply (only JPEG honors the descent).
    pipeline = format === 'jpeg' ? pipeline.jpeg({ quality: encodeQuality }) : pipeline.png();
    const out = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      buffer: out.data,
      width: out.info.width,
      height: out.info.height,
      mediaType,
      format,
    };
  } catch {
    return null;
  }
}

/** Structural shape of a `_modelContent` part (mirrors ModelContentPart in
 *  tool-model-content.ts; duplicated locally to avoid an import cycle). */
type ModelContentPartLike =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mediaType: string }
  | { type: 'file'; data: string; mediaType: string; filename?: string };

export type FitModelContentResult = {
  /** The (possibly re-encoded) parts, with any dropped image replaced by a text
   *  note so the model still learns the item existed. */
  parts: ModelContentPartLike[];
  /** True if any image was downscaled or dropped — the caller surfaces a UI note. */
  changed: boolean;
  /** True if at least one image was DROPPED (over budget even at the floor) —
   *  the caller surfaces the "run /compact" guidance. */
  dropped: boolean;
  /** Human-readable summary for the UI/log (empty when nothing changed). */
  note: string;
  /** Estimated tokens the KEPT images in this result contribute to the model
   *  input (sum of each unchanged/downscaled image's estimate). The caller
   *  accumulates this across a turn's tool results so later results in the same
   *  turn budget against what earlier media already committed. */
  keptTokens: number;
  /** Decoded BYTES of the kept media (images + files) in this result. The caller
   *  accumulates this across a turn's tool results and feeds it back as
   *  `alreadyCommittedMediaBytes` so the 12 MiB aggregate cap is enforced over the
   *  WHOLE request, not reset per result (else N results each just under the cap
   *  could collectively produce a multi-hundred-MB request). */
  keptMediaBytes: number;
};

/**
 * Fit every image in a `_modelContent` array into the REMAINING context budget.
 *
 * `remainingBudgetTokens` is how many tokens are left in the model's window after
 * the current branch + a reserve (computed by the caller). Images are fit in
 * order; each kept image's estimated cost is subtracted from the running budget
 * so a result carrying several images can't collectively overflow. Text and file
 * parts pass through unchanged (files aren't downscalable images and are already
 * byte-capped upstream).
 *
 * Returns the transformed parts plus flags the caller uses to surface a UI note.
 * When `config.enabled` is false, returns the input unchanged.
 */
export async function fitModelContentToBudget(
  parts: readonly ModelContentPartLike[],
  remainingBudgetTokens: number,
  config: MediaFitConfig,
  signal?: AbortSignal,
  alreadyCommittedMediaBytes = 0,
  maxTotalMediaBytes?: number,
): Promise<FitModelContentResult> {
  if (!config.enabled || parts.length === 0) {
    return { parts: [...parts], changed: false, dropped: false, note: '', keptTokens: 0, keptMediaBytes: 0 };
  }

  const out: ModelContentPartLike[] = [];
  let budget = Math.max(0, remainingBudgetTokens);
  let changed = false;
  let dropped = false;
  let downscaledCount = 0;
  let droppedCount = 0;
  let truncatedTextCount = 0;
  // Distinct human remedies for dropped media, surfaced in the AGGREGATE stream note.
  // The per-item inline notes live inside `_modelContent` which the tool-result UI
  // strips (underscore-prefixed fields hidden), so the user only ever sees the
  // aggregate — it must carry the actual remedy (/compact vs smaller file vs re-encode),
  // not "see notes above". A Set de-dupes when several parts share a remedy.
  const dropRemedies = new Set<string>();
  const recordRemedy = (note: string): void => {
    if (/\/compact/.test(note)) dropRemedies.add('run /compact to free space');
    else if (/smaller or fewer images/i.test(note)) dropRemedies.add('send smaller or fewer images');
    else if (/smaller file/i.test(note)) dropRemedies.add('send a smaller file');
    else if (/resize or re-encode/i.test(note)) dropRemedies.add('resize or re-encode the image smaller');
    else dropRemedies.add('reduce attachment size');
  };
  let keptTokens = 0;
  // Cap how many parts we actively FIT (matches extractModelContent's MAX_PARTS
  // DoS guard). Parts beyond the cap pass through untouched — the downstream
  // sanitizer enforces the same limit — so an untrusted result with thousands of
  // parts can't make us do thousands of sharp decodes OR text truncations.
  const MAX_FIT_PARTS = 64;
  let fitCount = 0;
  // TWO byte ceilings, both of which a kept media part must satisfy:
  //
  //  (1) MAX_AGGREGATE_MEDIA_BYTES (12 MiB) — the PER-CALL aggregate, matching the
  //      downstream extractModelContent MAX_TOTAL_BYTES (a per-tool-result limit).
  //      Bounds the media in the parts THIS call emits (unseeded), so a single
  //      result's images can't collectively exceed what the sanitizer will accept.
  //
  //  (2) maxTotalMediaBytes — the WHOLE-REQUEST ceiling. Seeded by the caller with
  //      alreadyCommittedMediaBytes = this turn's prior kept media + the retained
  //      BRANCH media bytes (prior turns). Bounds the TOTAL media in the provider
  //      request, so a branch that accumulated many small-DIMENSION but large-BYTE
  //      images across turns (cheap in tokens, so compaction never fires) can't grow
  //      the request to hundreds of MiB. Defaults to a generous provider-safe bound.
  //
  // A part is dropped (loudly, via droppedCount → UI note) once accepting it would
  // cross EITHER ceiling.
  const MAX_AGGREGATE_MEDIA_BYTES = getMaxTotalBytes();
  const seed = Math.max(0, alreadyCommittedMediaBytes);
  const totalCeiling = Math.max(0, maxTotalMediaBytes ?? DEFAULT_MAX_TOTAL_MEDIA_BYTES);
  // Per-call aggregate starts at 0 (only THIS call's kept bytes); whole-request total
  // starts at the seed. Both advance together as parts are kept.
  let callMediaBytes = 0;
  let totalMediaBytes = seed;
  // A prospective part of `n` bytes fits only if it stays under BOTH ceilings. Return
  // WHICH cap fired so the caller can recommend the right remedy: the per-call cap is
  // this RESULT's own media being too big (fixed — /compact can't help, send smaller/
  // re-encoded media); the whole-request cap is cross-turn BRANCH accumulation (/compact
  // can free prior-turn media). 'per-result' takes precedence (it's a fixed limit).
  const capExceeded = (n: number): 'per-result' | 'whole-request' | null => {
    if (callMediaBytes + n > MAX_AGGREGATE_MEDIA_BYTES) return 'per-result';
    if (totalMediaBytes + n > totalCeiling) return 'whole-request';
    return null;
  };
  // Bytes accepted in THIS call only (excludes the seed), returned to the caller so
  // it can accumulate a running per-turn total to feed back next result.
  let keptMediaBytes = 0;
  // Bound how many OVER-cap text blocks we actively byte-count/truncate. Earlier
  // dropped media can free downstream sanitizer slots, so over-cap text isn't just
  // passed through — but an untrusted result with THOUSANDS of huge text blocks
  // must not make us Buffer.byteLength + truncate each (main-thread stall). At most
  // MAX_FIT_PARTS could ever occupy freed slots; beyond that no slot can remain, so
  // pass the rest through untouched (downstream discards them past its 64-part cap).
  let overCapTextProcessed = 0;

  for (const part of parts) {
    // Turn cancelled mid-fit → stop doing sharp decodes/re-encodes and pass the
    // remaining parts through untouched (nothing is sent, so their exact fit no
    // longer matters — this just frees CPU/memory promptly on abort).
    if (signal?.aborted) {
      out.push(part);
      continue;
    }
    // A null/undefined/non-object entry (untrusted plugin content) passes through
    // untouched — the downstream sanitizer discards it. Guard before any property
    // access so it can't throw and fail the whole tool result.
    if (!part || typeof part !== 'object') {
      out.push(part);
      continue;
    }
    // Whether this part is DOWNSTREAM-VALID (i.e. extractModelContent would emit
    // it and thus count it toward its own 64-part cap): a text part with a string
    // `text`, or an image/file with non-empty string `data`. Only valid parts
    // consume our fit allowance — otherwise 64 junk objects could exhaust the cap
    // and let a following valid image bypass fitting (yet still be emitted
    // downstream, over budget).
    const pt = (part as { type?: unknown }).type;
    const isValidText = pt === 'text' && typeof (part as { text?: unknown }).text === 'string';
    // Mirror extractModelContent's isModelContentPart: media needs non-empty
    // string `data` AND a non-empty string `mediaType` (and a file's optional
    // `filename`, if present, must be a string). Parts failing this are discarded
    // downstream WITHOUT consuming its 64-part cap, so they must not consume ours.
    const dataOk = typeof (part as { data?: unknown }).data === 'string' && (part as { data: string }).data.length > 0;
    const mediaTypeOk =
      typeof (part as { mediaType?: unknown }).mediaType === 'string' &&
      (part as { mediaType: string }).mediaType.length > 0;
    const filenameOk =
      (part as { filename?: unknown }).filename === undefined ||
      typeof (part as { filename?: unknown }).filename === 'string';
    const isValidMedia = (pt === 'image' || pt === 'file') && dataOk && mediaTypeOk && filenameOk;
    // Past the fit cap. We must NOT pass valid MEDIA through unfit: because earlier
    // over-budget media may have been dropped, an unfit part here could become one
    // of the first 64 the downstream sanitizer emits — sent at full size, over
    // budget. So DROP over-cap media (silently; the aggregate note records it).
    // Over-cap TEXT may pass through (truncating it isn't the overflow risk and it
    // stays within the sanitizer's own text handling).
    if (isValidMedia && fitCount >= MAX_FIT_PARTS) {
      changed = true;
      dropped = true;
      droppedCount += 1;
      continue; // drop the part entirely (no note — budget likely exhausted)
    }
    if (isValidText && fitCount >= MAX_FIT_PARTS) {
      // Over-cap text still counts against the downstream sanitizer's part window
      // (which has no text-size limit), so truncate it to the remaining budget
      // rather than passing it through unbounded (earlier dropped media may have
      // freed sanitizer slots, letting this become one of its first 64 parts). BUT
      // bound the work: after MAX_FIT_PARTS over-cap text blocks, DROP the rest
      // rather than passing them RAW — passing raw could let a downstream freed slot
      // (from earlier truncate-to-empty omissions) admit an unbudgeted large block
      // and overflow the next step. Dropping is safe (recorded via droppedCount) and
      // avoids a main-thread stall on thousands of huge blocks.
      if (overCapTextProcessed >= MAX_FIT_PARTS) {
        changed = true;
        dropped = true;
        droppedCount += 1;
        continue;
      }
      overCapTextProcessed += 1;
      const text = typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '';
      const est = estimateTextTokens(text);
      if (est <= budget) {
        budget -= est;
        keptTokens += est;
        out.push(part);
      } else {
        changed = true;
        truncatedTextCount += 1; // count it so the summary note isn't empty
        const truncated = truncateTextToTokens(text, Math.max(0, budget));
        budget = 0;
        keptTokens += estimateTextTokens(truncated);
        // Budget already exhausted → truncated may be '' — DON'T emit an empty text
        // part (extractModelContent forwards it and providers like Anthropic reject
        // empty text blocks, failing the whole request). Omitting it is fine: the
        // truncatedTextCount still records the change in the note.
        if (truncated.length > 0) out.push({ type: 'text', text: truncated });
      }
      continue;
    }
    if (isValidText || isValidMedia) fitCount += 1;
    // TEXT parts can be truncated (unlike base64). A very large text part in
    // `_modelContent` is exempt from the tool-compaction path (splitPreservedFields
    // splits the whole field off), so budget it here: keep it whole if it fits,
    // else head/tail-truncate to the remaining budget with a marker.
    if (part.type === 'text') {
      const text = typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '';
      const est = estimateTextTokens(text);
      if (est <= budget) {
        budget -= est;
        keptTokens += est;
        out.push(part);
      } else {
        changed = true;
        truncatedTextCount += 1;
        const truncated = truncateTextToTokens(text, Math.max(0, budget));
        budget = 0;
        keptTokens += estimateTextTokens(truncated);
        // See above — never emit an empty text part (provider-invalid).
        if (truncated.length > 0) out.push({ type: 'text', text: truncated });
      }
      continue;
    }
    // Non-image/-file parts pass straight through.
    if (part.type !== 'image' && part.type !== 'file') {
      out.push(part);
      continue;
    }
    // A malformed/untrusted media part passes through untouched — the downstream
    // `extractModelContent` sanitizer drops it (it validates data + mediaType +
    // string filename), and we must not feed `undefined` to Buffer.from()/sharp.
    // Use the SAME `isValidMedia` predicate as the fit-cap accounting so a part
    // that didn't consume the cap also isn't processed here (consistency).
    if (!isValidMedia) {
      out.push(part);
      continue;
    }

    // FILE parts can't be downscaled; budget them by the full decoded-byte
    // ceiling (files can be text-dense, ~1 token/byte) and drop with a note when
    // over budget (a large byte-capped PDF can still overflow).
    if (part.type === 'file') {
      const fileBytes = approxBytesFromBase64(stripDataUrlPrefix((part as { data: string }).data));
      const est = estimateFileTokensFromBytes(
        (part as { data: string }).data,
        (part as { mediaType?: string }).mediaType,
      );
      // Also respect the downstream PER-PART byte cap (maxDecodeBytes / the
      // configurable maxImageBytes) — a file over it is silently replaced
      // downstream, so drop it here (loud) instead of charging phantom keptTokens
      // that shrink later media's budget.
      const fileCap = capExceeded(fileBytes);
      if (est <= budget && fileBytes <= maxDecodeBytes() && fileCap === null) {
        callMediaBytes += fileBytes;
        totalMediaBytes += fileBytes;
        keptMediaBytes += fileBytes;
        budget -= est;
        keptTokens += est;
        out.push(part);
      } else {
        changed = true;
        dropped = true;
        droppedCount += 1;
        // Emit the omission note ONLY if it fits the remaining budget; else drop
        // the media SILENTLY (the aggregate UI note + droppedCount still record it).
        // Pick the remedy by WHY it dropped: a FIXED cap (per-attachment, or the
        // per-result combined-media cap) can't be relieved by /compact — ask for
        // smaller/fewer files; a whole-request/context drop CAN be relieved by /compact.
        const fixedCap = fileBytes > maxDecodeBytes() || fileCap === 'per-result';
        const note = fixedCap
          ? `[file omitted: exceeds the per-attachment/per-result media size limit; send a smaller file, then retry]`
          : `[file omitted: too large for the remaining context window; run /compact to free space, then retry]`;
        recordRemedy(note);
        const noteTokens = estimateTextTokens(note);
        if (noteTokens <= budget) {
          budget -= noteTokens;
          keptTokens += noteTokens;
          out.push({ type: 'text', text: note });
        }
      }
      continue;
    }

    const fit = await fitImagePart(part.data, part.mediaType, budget, config, signal);
    if (fit.kind === 'unchanged') {
      // Would accepting this push cumulative media over the downstream aggregate
      // cap? If so, drop it here (loudly) rather than let extractModelContent drop
      // it silently. (Compares the ACTUAL bytes that would be sent.)
      const partBytes = approxBytesFromBase64(fit.data);
      // The sanitizer's per-part predicate is on DECODED bytes (maxDecodeBytes), but
      // fitImagePart's cheap guard is on base64 STRING length — base64 padding makes the
      // two disagree right at the cap boundary, so an image of ~cap+1 can return
      // `unchanged` here yet be DROPPED by extractModelContent downstream. Charging it as
      // retained then over-counts the budget (phantom bytes) and can push a following
      // valid image out. Enforce the same per-part decoded-byte cap the sanitizer uses —
      // treat an over-cap image as a FIXED-cap drop (compaction can't relieve it).
      const overPerPart = partBytes > maxDecodeBytes();
      const imgCap = overPerPart ? 'per-result' : capExceeded(partBytes);
      if (imgCap !== null) {
        changed = true;
        dropped = true;
        droppedCount += 1;
        // per-result / over-per-part = a FIXED cap (this result's own combined media, or
        // this single image, exceeds the fixed limit) — compaction can't help (send
        // smaller/fewer/re-encoded images); whole-request = cross-turn branch accumulation
        // (/compact can free prior-turn media).
        const note =
          imgCap === 'per-result'
            ? `[image omitted: this result's combined attachments exceed the per-result media size limit; send smaller or fewer images, then retry]`
            : `[image omitted: the combined attachments exceed the media size limit for one request; run /compact to free space, then retry]`;
        recordRemedy(note);
        const noteTokens = estimateTextTokens(note);
        if (noteTokens <= budget) {
          budget -= noteTokens;
          keptTokens += noteTokens;
          out.push({ type: 'text', text: note });
        }
        continue;
      }
      callMediaBytes += partBytes;
      totalMediaBytes += partBytes;
      keptMediaBytes += partBytes;
      budget -= fit.estimatedTokens;
      keptTokens += fit.estimatedTokens;
      out.push(part);
    } else if (fit.kind === 'downscaled') {
      const partBytes = approxBytesFromBase64(fit.data);
      const imgCap = capExceeded(partBytes);
      if (imgCap !== null) {
        changed = true;
        dropped = true;
        droppedCount += 1;
        // per-result = this result's OWN combined media exceeds the fixed 12 MiB cap
        // (compaction can't help — send smaller/fewer/re-encoded images); whole-request
        // = cross-turn branch accumulation (/compact can free prior-turn media).
        const note =
          imgCap === 'per-result'
            ? `[image omitted: this result's combined attachments exceed the per-result media size limit; send smaller or fewer images, then retry]`
            : `[image omitted: the combined attachments exceed the media size limit for one request; run /compact to free space, then retry]`;
        recordRemedy(note);
        const noteTokens = estimateTextTokens(note);
        if (noteTokens <= budget) {
          budget -= noteTokens;
          keptTokens += noteTokens;
          out.push({ type: 'text', text: note });
        }
        continue;
      }
      callMediaBytes += partBytes;
      totalMediaBytes += partBytes;
      keptMediaBytes += partBytes;
      budget -= fit.estimatedTokens;
      keptTokens += fit.estimatedTokens;
      changed = true;
      downscaledCount += 1;
      // Replace the image 1:1 (do NOT add a separate text note part). Emitting an
      // extra part per downscaled image would inflate the part count and could
      // push later parts past the downstream 64-part sanitizer cap, silently
      // dropping successfully-fitted images. The aggregate reduction is surfaced
      // once via the caller's UI note instead.
      out.push({ type: 'image', data: fit.data, mediaType: fit.mediaType });
    } else {
      changed = true;
      dropped = true;
      droppedCount += 1;
      // Emit the omission note only if it fits the remaining budget; else drop
      // silently (aggregate UI note + droppedCount still record it) so many
      // notes can't collectively overflow the window.
      recordRemedy(fit.note);
      const noteTokens = estimateTextTokens(fit.note);
      if (noteTokens <= budget) {
        budget -= noteTokens;
        keptTokens += noteTokens;
        out.push({ type: 'text', text: fit.note });
      }
    }
  }

  const noteParts: string[] = [];
  if (downscaledCount > 0) noteParts.push(`${downscaledCount} image(s) downscaled`);
  if (truncatedTextCount > 0) noteParts.push(`${truncatedTextCount} text block(s) truncated`);
  // The user only sees this aggregate (per-item notes are stripped from the UI), so
  // spell out the actual remedy/remedies rather than "see notes above".
  if (droppedCount > 0) {
    const remedies = dropRemedies.size > 0 ? ` — ${[...dropRemedies].join(' or ')}` : '';
    noteParts.push(`${droppedCount} item(s) omitted${remedies}`);
  }
  return { parts: out, changed, dropped, note: noteParts.join('; '), keptTokens, keptMediaBytes };
}

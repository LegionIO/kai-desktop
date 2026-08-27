/**
 * Offload base64 DISPLAY media out of a conversation tree onto disk.
 *
 * User attachments enter the message tree as inline base64 data URLs
 * (`{type:'image', image:'data:...'}` / `{type:'file', data:'data:...'}`).
 * Materialized whole into the renderer's React state — plus a decoded bitmap per
 * mounted <img> — they drive the renderer JS heap toward the V8 limit and OOM the
 * window on media-heavy conversations, and they bloat the on-disk conversation
 * JSON (observed 32 MiB for a single chat).
 *
 * This walks a tree and rewrites those base64 DISPLAY parts to `kai-media://`
 * URLs backed by files under `~/.<slug>/media/`, served by the existing hardened
 * media protocol (main.ts). The browser then owns (and can evict) the bytes, and
 * the persisted tree stores a tiny URL instead of megabytes of base64.
 *
 * SCOPE — this touches ONLY display content parts on message `content`. It NEVER
 * descends into a tool result's `_modelContent` (the model-visible copy, consumed
 * by tool-model-content.ts) or a compacted part's `originalResult`/`result`
 * backups: those are the model-input / compaction paths and must round-trip
 * byte-exact. The two are separate locations; offloading display never alters
 * what the model sees.
 *
 * Idempotent: a part already holding a `kai-media://` / http(s) URL is left as-is,
 * so re-persisting an already-offloaded tree is a no-op. Malformed data URLs are
 * left untouched rather than throwing (a persist must never fail on bad media).
 */
import { createHash } from 'crypto';
import { mkdirSync, lstatSync, rmSync, realpathSync } from 'fs';
import { join, sep } from 'path';

import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { safeReadRangeWithin } from '../utils/safe-file-read.js';
import { filePathToUrl, MAX_MEDIA_BYTES } from '../tools/media-gen-utils.js';

/** Ceiling on TOTAL decoded bytes rehydrateModelMedia will materialize into base64
 *  in one pass — a safety bound so a pathological deep history of attachments can't
 *  OOM the main process. 64 MiB is far above any realistic single-turn attachment
 *  set (the whole-request media ceiling is a few MiB) yet nowhere near a main-heap
 *  risk. Not a per-turn budget (that's media-fit's job) — a backstop against abuse. */
const REHYDRATE_TOTAL_CAP = 64 * 1024 * 1024;

/** `data:<mime>;base64,<payload>` — capture the mime and the base64 body. Also
 *  tolerates a missing/again-declared charset segment. We only offload base64
 *  data URLs (the heavy ones); a `data:...;utf8,` text URL is left as-is. */
const DATA_URL_RE = /^data:([^;,]+)?(?:;[^,]*?)?;base64,([\s\S]*)$/;
/** Standard base64 alphabet + valid terminal padding. Necessary but NOT sufficient:
 *  `AB==` passes this yet is non-canonical (the trailing bits aren't zero), and
 *  Buffer.from normalizes it — so callers use isCanonicalBase64 (regex + round-trip)
 *  as the single source of truth for "cleanly, uniquely decodable". */
const STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decode `payload` iff it is CANONICAL base64 (alphabet/padding regex AND round-trips
 *  decode→re-encode === input) AND within the decoded-byte cap, returning the decoded
 *  Buffer — or null otherwise. The ENCODED-length gate runs FIRST (before any decode),
 *  so an oversized payload is rejected without allocating >1 GiB in the main process.
 *  The round-trip rejects non-canonical forms (`AB==`) that the regex alone accepts but
 *  Buffer.from silently normalizes. Returns the buffer so callers needing the bytes
 *  don't decode twice. `maxBytes` defaults to the media cap. */
export function canonicalBase64ToBuffer(payload: string, maxBytes: number = MAX_MEDIA_BYTES): Buffer | null {
  if (payload.length === 0 || !STRICT_BASE64_RE.test(payload)) return null;
  // Reject over-cap by ENCODED length before decoding (4 base64 chars ≈ 3 bytes).
  if (Math.floor((payload.length * 3) / 4) > maxBytes) return null;
  try {
    const buf = Buffer.from(payload, 'base64');
    if (buf.length > maxBytes) return null;
    return buf.toString('base64') === payload ? buf : null;
  } catch {
    return null;
  }
}

/** Boolean form of {@link canonicalBase64ToBuffer} — the shared "cleanly, uniquely
 *  decodable" predicate used by offload / compaction-identity / eligibility so they
 *  all agree. Bound the ENCODED length before calling on untrusted-size input. */
export function isCanonicalBase64(payload: string): boolean {
  return canonicalBase64ToBuffer(payload) !== null;
}

/** Map a decoded mime type to a media subdir + file extension. Non-media
 *  documents (PDF, text, JSON, …) go under `files/` with a type-appropriate
 *  extension so the media protocol + web route serve them with the correct
 *  Content-Type (and previews key off it) rather than octet-stream. A truly
 *  unknown type keeps its bytes under `files/` as `.bin`. */
function mediaTarget(mime: string): { type: 'images' | 'videos' | 'audio' | 'files'; ext: string } {
  const m = mime.toLowerCase().split(';')[0].trim();
  const map: Record<string, { type: 'images' | 'videos' | 'audio' | 'files'; ext: string }> = {
    'image/png': { type: 'images', ext: 'png' },
    'image/jpeg': { type: 'images', ext: 'jpg' },
    'image/jpg': { type: 'images', ext: 'jpg' },
    'image/webp': { type: 'images', ext: 'webp' },
    'image/gif': { type: 'images', ext: 'gif' },
    'image/svg+xml': { type: 'images', ext: 'svg' },
    'video/mp4': { type: 'videos', ext: 'mp4' },
    'video/webm': { type: 'videos', ext: 'webm' },
    'video/quicktime': { type: 'videos', ext: 'mov' },
    'audio/mpeg': { type: 'audio', ext: 'mp3' },
    'audio/wav': { type: 'audio', ext: 'wav' },
    'audio/flac': { type: 'audio', ext: 'flac' },
    'audio/opus': { type: 'audio', ext: 'opus' },
    'audio/ogg': { type: 'audio', ext: 'ogg' },
    'application/pdf': { type: 'files', ext: 'pdf' },
    'application/json': { type: 'files', ext: 'json' },
    'text/plain': { type: 'files', ext: 'txt' },
    'text/markdown': { type: 'files', ext: 'md' },
    'text/csv': { type: 'files', ext: 'csv' },
    'text/html': { type: 'files', ext: 'html' },
  };
  if (map[m]) return map[m];
  // Unknown MIME: keep bytes under files/ (never guess an image ext). A generic
  // text/* is stored .txt so it previews as text; everything else is .bin.
  if (m.startsWith('text/')) return { type: 'files', ext: 'txt' };
  return { type: 'files', ext: 'bin' };
}

/** The file extension the offload assigns for a MIME type — the single source of
 *  truth so the compaction identity token can reproduce an offloaded file's ext for
 *  a not-yet-offloaded data: URL and hash cross-form-consistently. */
export function extForMime(mime: string | undefined): string {
  return mediaTarget(mime ?? '').ext;
}

/** True when a string is already a servable URL (offloaded or remote) — leave it. */
function isAlreadyUrl(value: string): boolean {
  return (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    // any custom scheme that isn't a data: URL (covers kai-media:// under any brand)
    (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !value.startsWith('data:'))
  );
}

/** Active/script-capable formats that must NOT be offloaded to a servable
 *  kai-media:// URL: served from the authenticated app origin (esp. the web bridge's
 *  /media/ route) they could execute attacker-controlled script with the app's
 *  origin (SVG carries <script>, HTML is obviously active). Keeping them INLINE as
 *  base64 means they never get a servable URL — they render sandboxed as a data:
 *  image / are shown as text, exactly as before offload. The heap/disk win from
 *  offloading these is negligible (attachments are overwhelmingly images/PDFs). */
function isActiveFormat(mime: string): boolean {
  const m = mime.toLowerCase().split(';')[0].trim();
  return m === 'image/svg+xml' || m === 'text/html' || m === 'application/xhtml+xml';
}

/**
 * Write a decoded base64 media payload to `mediaDir` (content-addressed so
 * identical bytes reuse one file across edits/regenerations) and return its
 * `kai-media://` URL, or null if the payload is unusable (too large / empty) or an
 * active/script-capable format that must stay inline.
 */
function offloadBase64(dataUrl: string, appHome: string): string | null {
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return null;
  const mime = (m[1] ?? 'application/octet-stream').trim() || 'application/octet-stream';
  // Never offload active content to a servable URL (XSS via the app origin).
  if (isActiveFormat(mime)) return null;
  const base64 = m[2] ?? '';
  if (base64.length === 0) return null;
  // Pre-decode size gate FIRST (cheap): 4 base64 chars ≈ 3 bytes. Reject an over-cap
  // payload from its ENCODED length BEFORE any decode, so a pathological/oversized
  // attachment can't allocate the decoded buffer (>1 GiB) in the main process just to
  // be rejected. Only then pay for canonical validation, which must decode.
  if (Math.floor((base64.length * 3) / 4) > MAX_MEDIA_BYTES) return null;
  // CANONICAL base64 only: Buffer.from silently drops invalid chars AND normalizes
  // non-canonical padding (`QUJD!!!!` truncates, `AB==` re-encodes differently), which
  // would persist a corrupted/ambiguous attachment while replacing the original — so a
  // non-canonical data URL stays inline. Decode + validate in one pass, reusing the
  // buffer below (no second decode).
  const buf = canonicalBase64ToBuffer(base64);
  if (!buf) return null;
  if (buf.length === 0 || buf.length > MAX_MEDIA_BYTES) return null;

  const { type, ext } = mediaTarget(mime);
  // Content-addressed filename: identical bytes → same file, so editing or
  // regenerating a message with the same attachment never duplicates on disk.
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const dir = join(appHome, 'media', type);
  const filename = `${hash}.${ext}`;
  const filePath = join(dir, filename);

  try {
    // Ensure the category dir exists, then confirm ITS canonical path is inside the
    // canonical media root — BEFORE either reusing an existing file or writing a new
    // one. A symlinked category dir (e.g. media/images -> /elsewhere) would otherwise
    // let both paths accept/produce a URL pointing outside the root, which serving +
    // rehydration then reject → a permanently broken attachment. Done unconditionally
    // so the reuse path is guarded too (not just the write path). On any failure, keep
    // the bytes inline (return null) rather than emit an unservable URL.
    mkdirSync(dir, { recursive: true });
    const mediaRoot = join(appHome, 'media');
    let realDir: string;
    let realRoot: string;
    try {
      realDir = realpathSync(dir);
      realRoot = realpathSync(mediaRoot);
    } catch {
      return null;
    }
    if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) return null;

    // Reuse an existing content-addressed file only if it's a real, non-empty REGULAR
    // file (lstat — NOT followed) matching the payload size. A symlink at the leaf must
    // NOT count as reusable (its target may be elsewhere); lstat + isFile() forces a
    // re-materialize (atomic O_NOFOLLOW write) in that case.
    let reusable = false;
    try {
      const st = lstatSync(filePath);
      reusable = st.isFile() && st.size === buf.length;
    } catch {
      /* missing → not reusable */
    }
    if (!reusable) {
      // Atomic write: tmp sibling opened O_EXCL|O_NOFOLLOW, then rename into place.
      // A crash mid-write can never leave a partial at `filePath` (only an orphan
      // .tmp), and a symlink planted at the destination can't redirect the write.
      atomicWriteFileSync(filePath, buf);
    }
  } catch {
    // If we can't persist the file, keep the inline base64 (correctness over
    // memory — a missing file would render as a broken image).
    return null;
  }
  return filePathToUrl(filePath);
}

/** A content part shape we might rewrite. Kept loose — trees come from disk /
 *  plugins and aren't guaranteed to match the renderer's exact ContentPart. */
type LoosePart = { type?: unknown; image?: unknown; data?: unknown } & Record<string, unknown>;

/**
 * Rewrite base64 display media in a single message's `content` array. Returns the
 * new content plus whether anything changed (so the caller can drop stale token
 * caches only for modified nodes). Non-array content and non-media parts pass
 * through untouched. NEVER recurses into tool-result `result`/`_modelContent`.
 */
function offloadContent(content: unknown, appHome: string): { content: unknown; changed: boolean } {
  if (!Array.isArray(content)) return { content, changed: false };
  let changed = false;
  const next = content.map((raw) => {
    const part = raw as LoosePart;
    if (!part || typeof part !== 'object') return raw;
    // Image display part: { type:'image', image: <dataURL> }
    if (part.type === 'image' && typeof part.image === 'string' && part.image.startsWith('data:')) {
      if (isAlreadyUrl(part.image)) return raw;
      const url = offloadBase64(part.image, appHome);
      if (url) {
        changed = true;
        return { ...part, image: url };
      }
      return raw;
    }
    // File display part: { type:'file', data: <dataURL> }
    if (part.type === 'file' && typeof part.data === 'string' && part.data.startsWith('data:')) {
      if (isAlreadyUrl(part.data)) return raw;
      const url = offloadBase64(part.data, appHome);
      if (url) {
        changed = true;
        return { ...part, data: url };
      }
      return raw;
    }
    return raw;
  });
  return { content: next, changed };
}

/** A tree node loose enough to accept disk/plugin trees. */
type LooseNode = {
  content?: unknown;
  tokenCount?: unknown;
  tokenCountSig?: unknown;
} & Record<string, unknown>;

/** Cheap eligibility check (no decode): is this value a base64 `data:` URL that
 *  offload would actually MOVE to disk? Must match offloadBase64's criteria exactly
 *  — excludes active/script-capable formats (kept inline for XSS safety), empty
 *  bodies, and over-cap payloads (by encoded length) — so a migration/reload gate
 *  built on it never churns on a value offload will reject. */
function isOffloadableDataUrl(value: string): boolean {
  if (!value.startsWith('data:')) return false;
  const m = DATA_URL_RE.exec(value);
  if (!m) return false;
  const mime = (m[1] ?? 'application/octet-stream').trim() || 'application/octet-stream';
  if (isActiveFormat(mime)) return false;
  const base64 = m[2] ?? '';
  if (base64.length === 0) return false;
  // Size gate FIRST (cheap, pre-decode) so an oversized payload isn't decoded by the
  // canonical check just to be rejected — then canonical validation (matches offloadBase64).
  if (Math.floor((base64.length * 3) / 4) > MAX_MEDIA_BYTES) return false;
  return isCanonicalBase64(base64); // non-canonical → stays inline (matches offloadBase64)
}

/** Cheap read-only check: does any node hold an inline base64 image/file DISPLAY
 *  part that offload would actually move to disk? Used to decide whether a
 *  migration/offload pass is worth running (and to route it through the sanitize-
 *  first write path) WITHOUT writing any file. Matches offload eligibility exactly
 *  (excludes SVG/HTML, which stay inline) so a record of only-inline-forever media
 *  doesn't churn rewrite/reload on every read. */
export function hasInlineBase64DisplayMedia(tree: unknown): boolean {
  if (!Array.isArray(tree)) return false;
  for (const node of tree) {
    const content = (node as LooseNode)?.content;
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      const p = raw as LoosePart;
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'image' && typeof p.image === 'string' && isOffloadableDataUrl(p.image)) return true;
      if (p.type === 'file' && typeof p.data === 'string' && isOffloadableDataUrl(p.data)) return true;
    }
  }
  return false;
}

/**
 * Offload base64 display media across an entire message tree (array of nodes).
 * Returns a new tree (nodes are only cloned when their content changed) plus the
 * count of rewritten media parts. When a node's content changes, its cached
 * `tokenCount`/`tokenCountSig` are cleared so the write boundary recomputes them
 * against the (much smaller) URL content instead of the stale base64 count.
 */
export function offloadTreeDisplayMedia(tree: unknown, appHome: string): { tree: unknown; rewritten: number } {
  if (!Array.isArray(tree)) return { tree, rewritten: 0 };
  let rewritten = 0;
  const next = tree.map((rawNode) => {
    const node = rawNode as LooseNode;
    if (!node || typeof node !== 'object') return rawNode;
    const { content, changed } = offloadContent(node.content, appHome);
    if (!changed) return rawNode;
    rewritten++;
    // Drop stale token caches: the content shrank from base64 → URL, so the
    // cached count no longer matches. The store recomputes on signature mismatch.
    const { tokenCount: _tc, tokenCountSig: _ts, ...rest } = node;
    return { ...rest, content };
  });
  // Nothing rewritten → return the ORIGINAL array reference (no needless clone),
  // so callers can cheaply detect "no offload happened".
  return rewritten === 0 ? { tree, rewritten: 0 } : { tree: next, rewritten };
}

// ─── Rehydration (the inverse: kai-media:// URL → base64 data URL) ────────────
// User image/file parts are DUAL-PURPOSE: display AND model input. The runtimes
// (Mastra/AI-SDK, Claude, Codex) only accept data:/http media, not kai-media://.
// So before an offloaded tree is sent to a provider, each kai-media:// display
// part must be resolved back to a data: URL by reading its file from mediaDir.
// (The renderer serves the same URLs via the media protocol; this path is for the
// MODEL boundary, where there's no protocol handler.)

const MEDIA_PROTOCOL_PREFIX = __BRAND_MEDIA_PROTOCOL + '://';

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** MIME for a media file extension (inverse of mediaTarget), for the data: prefix. */
function mimeForExt(ext: string): string {
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    opus: 'audio/opus',
    ogg: 'audio/ogg',
    pdf: 'application/pdf',
    json: 'application/json',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    html: 'text/html',
  };
  return map[ext.toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Resolve a `kai-media://images/<name>` URL to a `data:<mime>;base64,<...>` URL by
 * reading the referenced file. Returns null if the value isn't a media URL, the
 * path escapes mediaDir, the file can't be read, or its size exceeds `maxBytes` —
 * callers then leave the value as-is (a broken model image is better than crashing
 * the turn, and an over-budget file must NOT be read into memory). Security mirrors
 * the protocol handler: strip query, decode, join under mediaDir, lexical
 * containment, then a symlink/TOCTOU-safe (realpath + O_NOFOLLOW) read.
 * `mimeType` (from the part) takes precedence over the extension-derived MIME.
 *
 * The size is PROBED first (a 1-byte ranged read that returns the total size) so an
 * over-`maxBytes` file is rejected WITHOUT allocating it — the bound is enforced
 * before the read, not after.
 */
export function rehydrateMediaUrl(
  value: string,
  appHome: string,
  mimeType?: string,
  maxBytes = MAX_MEDIA_BYTES,
): string | null {
  if (typeof value !== 'string' || !value.startsWith(MEDIA_PROTOCOL_PREFIX)) return null;
  const mediaDir = join(appHome, 'media');
  const rawPath = value.slice(MEDIA_PROTOCOL_PREFIX.length).split('?')[0];
  let rel: string;
  try {
    rel = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  const filePath = join(mediaDir, rel);
  if (filePath !== mediaDir && !filePath.startsWith(mediaDir + sep)) return null;
  const cap = Math.min(maxBytes, MAX_MEDIA_BYTES);
  // Probe the size with a 1-byte read FIRST (symlink/TOCTOU-safe), so an
  // over-budget/oversized/symlinked target is rejected before we allocate it.
  const probe = safeReadRangeWithin(mediaDir, filePath, 0, 0);
  if (!probe || probe.size === 0 || probe.size > cap) return null;
  const ranged = safeReadRangeWithin(mediaDir, filePath, 0, probe.size - 1);
  if (!ranged || ranged.size === 0 || ranged.size > cap) return null;
  const buf = ranged.data;
  const ext = filePath.split('.').pop() ?? '';
  const mime = mimeType && typeof mimeType === 'string' ? mimeType : mimeForExt(ext);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * Return a NEW messages array with `kai-media://` display media values rehydrated
 * to data: URLs, for the model boundary. Never mutates the input (branch objects
 * are shared with persisted/renderer state) — nodes and content arrays are cloned
 * only when a part changes. Non-array content and non-media parts pass by reference.
 * Leaves a part unchanged if its URL can't be resolved. NEVER descends into
 * tool-result `result`/`_modelContent` (those carry their own model media).
 *
 * BOUNDED: rehydration base64-encodes files into memory, so an unbounded history of
 * attachments could spike the MAIN process (the very OOM we're preventing in the
 * renderer). We rehydrate NEWEST-FIRST until `maxTotalBytes` of decoded media has
 * been materialized, then leave older URLs un-rehydrated: the current turn is about
 * the most-recent attachments (end of the branch), so if the cap is ever hit it
 * sheds the least-relevant OLDEST media, not the newest. The whole-request media
 * ceiling means the provider can't accept more than the cap anyway. Default cap is
 * generous (64 MiB) — enough for any realistic turn.
 *
 * Two passes so budgeting is newest-first while output stays in branch order: pass 1
 * walks messages in REVERSE, resolving each media value into a map (value → data URL)
 * until the budget is spent; pass 2 maps the branch forward, substituting only the
 * values pass 1 chose to materialize.
 */
export function rehydrateModelMedia(messages: unknown[], appHome: string, maxTotalBytes = REHYDRATE_TOTAL_CAP): unknown[] {
  if (!Array.isArray(messages)) return messages;

  // Pass 1 (newest-first): decide which specific OCCURRENCES to materialize within
  // budget. `selected` keys by `mi:pi` (message index : part index) — pass 2 must
  // substitute ONLY the occurrences pass 1 could afford. `resolvedData` caches the
  // produced data URL keyed by VALUE+MIME (not value alone): the same content-
  // addressed URL can appear with different declared mimeTypes across parts, and
  // rehydrateMediaUrl gives the part's mimeType precedence in the data: header — so
  // reusing a first-resolved URL for a differently-typed occurrence would mislabel it.
  const selected = new Set<string>(); // "mi:pi"
  const resolvedData = new Map<string, string>(); // `${value}\x00${mime}` → data: URL
  const cacheKey = (value: string, mime: string | undefined): string => `${value}\x00${mime ?? ''}`;
  let budget = maxTotalBytes;
  for (let mi = messages.length - 1; mi >= 0 && budget > 0; mi--) {
    const msg = messages[mi] as { content?: unknown };
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) continue;
    const parts = msg.content as LoosePart[];
    for (let pi = 0; pi < parts.length; pi++) {
      if (budget <= 0) break;
      const part = parts[pi] as LoosePart;
      if (!part || typeof part !== 'object') continue;
      const value =
        part.type === 'image' && typeof part.image === 'string'
          ? part.image
          : part.type === 'file' && typeof part.data === 'string'
            ? (part.data as string)
            : null;
      if (value === null) continue;
      const mime = typeof part.mimeType === 'string' ? part.mimeType : undefined;
      const key = cacheKey(value, mime);
      // Resolve (or reuse) the data URL. Pass the REMAINING budget so an over-budget
      // file is rejected before it's read into memory (cap enforced pre-allocation).
      let data = resolvedData.get(key);
      if (data === undefined) {
        const r = rehydrateMediaUrl(value, appHome, mime, budget);
        if (!r) continue; // not resolvable (missing / over-budget / not kai-media) — leave as URL
        data = r;
        resolvedData.set(key, r);
      }
      const payloadLen = data.length - (data.indexOf(',') + 1);
      const bytes = Math.floor((payloadLen * 3) / 4);
      if (bytes > budget) continue; // this occurrence can't fit → leave it a URL, try older ones
      budget -= bytes; // CHARGE per occurrence
      selected.add(`${mi}:${pi}`);
    }
  }
  if (selected.size === 0) return messages;

  // Pass 2 (branch order): substitute ONLY the selected occurrences.
  let anyChanged = false;
  const out = messages.map((rawMsg, mi) => {
    const msg = rawMsg as { content?: unknown } & Record<string, unknown>;
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) return rawMsg;
    let contentChanged = false;
    const content = (msg.content as LoosePart[]).map((raw, pi) => {
      const part = raw as LoosePart;
      if (!part || typeof part !== 'object' || !selected.has(`${mi}:${pi}`)) return raw;
      const mime = typeof part.mimeType === 'string' ? part.mimeType : undefined;
      if (part.type === 'image' && typeof part.image === 'string') {
        const data = resolvedData.get(cacheKey(part.image, mime));
        if (data) {
          contentChanged = true;
          return { ...part, image: data };
        }
        return raw;
      }
      if (part.type === 'file' && typeof part.data === 'string') {
        const data = resolvedData.get(cacheKey(part.data, mime));
        if (data) {
          contentChanged = true;
          return { ...part, data };
        }
        return raw;
      }
      return raw;
    });
    if (!contentChanged) return rawMsg;
    anyChanged = true;
    return { ...msg, content };
  });
  return anyChanged ? out : messages;
}

/**
 * Replace any REMAINING `kai-media://` display media parts (image/file) with an
 * omission-text placeholder. Runs AFTER rehydrateModelMedia on a path with no
 * separate media-fit gate (the plugin/automation stream): once rehydration's byte
 * cap is spent, older attachments keep their kai-media:// URL, which a provider
 * can't dereference — forwarding it fails the whole request. Swapping it for a note
 * keeps the request valid (the model just loses that over-budget attachment) rather
 * than erroring. Never mutates the input; clones only changed nodes. Leaves
 * data:/http values (already model-usable) untouched.
 */
export function stripUnresolvedOffloadedMedia(messages: unknown[]): unknown[] {
  if (!Array.isArray(messages)) return messages;
  let anyChanged = false;
  const out = messages.map((rawMsg) => {
    const msg = rawMsg as { content?: unknown } & Record<string, unknown>;
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) return rawMsg;
    let contentChanged = false;
    const content = (msg.content as LoosePart[]).map((raw) => {
      const part = raw as LoosePart;
      if (!part || typeof part !== 'object') return raw;
      const value =
        part.type === 'image' && typeof part.image === 'string'
          ? part.image
          : part.type === 'file' && typeof part.data === 'string'
            ? (part.data as string)
            : null;
      if (value !== null && value.startsWith(MEDIA_PROTOCOL_PREFIX)) {
        contentChanged = true;
        const label = part.type === 'image' ? 'image' : 'file';
        const name = typeof part.filename === 'string' && part.filename ? ` "${part.filename}"` : '';
        return { type: 'text', text: `[${label}${name} omitted — exceeds this turn's media budget]` };
      }
      // A hook could also inject a kai-media:// URL INSIDE a tool result's model-visible
      // `_modelContent` (image/file `data`), which the runtimes forward as base64 → the
      // scheme URL becomes garbage media. Neutralize any such nested value too (drop the
      // whole media part; a leftover URL there can't be resolved at the model boundary).
      const result = part.result as { _modelContent?: unknown } | undefined;
      if (result && typeof result === 'object' && Array.isArray(result._modelContent)) {
        let mcChanged = false;
        const mc = (result._modelContent as Array<Record<string, unknown>>).filter((cp) => {
          const bad =
            cp &&
            typeof cp === 'object' &&
            (cp.type === 'image' || cp.type === 'file') &&
            typeof cp.data === 'string' &&
            (cp.data as string).startsWith(MEDIA_PROTOCOL_PREFIX);
          if (bad) mcChanged = true;
          return !bad;
        });
        if (mcChanged) {
          contentChanged = true;
          return { ...part, result: { ...result, _modelContent: mc } };
        }
      }
      return raw;
    });
    if (!contentChanged) return rawMsg;
    anyChanged = true;
    return { ...msg, content };
  });
  return anyChanged ? out : messages;
}

// ─── Reference-aware media GC ─────────────────────────────────────────────────
// Offloaded (and generated) media live in a GLOBAL per-app media dir, shared
// across conversations (content-addressed → identical bytes are one file). When a
// conversation is deleted/cleared, its media must be reclaimed — both to bound
// disk and, for privacy, so a deleted sensitive chat's attachments don't linger.
// But a file may be referenced by OTHER conversations, so deletion is
// reference-counted: a file is removed only when NO surviving conversation
// references it. Collection scans the WHOLE tree (display parts AND tool
// results / _modelContent), since generated media is referenced from tool output.

/** Collect every `<mediaDir>`-relative path referenced by a `kai-media://` URL
 *  ANYWHERE in a value — including URLs EMBEDDED in a larger string (markdown
 *  `![alt](kai-media://images/x.png)`, HTML `src="…"`, prose), not just a bare
 *  value that starts with the prefix. Deep walk over arrays/objects/strings.
 *  Missing these embedded refs would let GC delete still-referenced media. Paths
 *  are normalized (query stripped, percent-decoded) for set membership. */
export function collectReferencedMediaPaths(value: unknown, into: Set<string> = new Set()): Set<string> {
  // A kai-media URL ends at the first char that can't be part of one: whitespace,
  // quote, paren/bracket, backtick, angle bracket (markdown/HTML/prose delimiters),
  // OR `#` (a fragment like #page=2 is not part of the stored path). The query is
  // stripped below. A trailing sentence punctuation char is then trimmed so prose
  // like "...see kai-media://images/x.png." doesn't capture the period into the path
  // — otherwise a survivor's bare-URL ref wouldn't match and GC could delete a live file.
  const urlRe = new RegExp(escapeRegExp(MEDIA_PROTOCOL_PREFIX) + '[^\\s\'"`)\\]<>#]+', 'g');
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.includes(MEDIA_PROTOCOL_PREFIX)) {
        for (const match of v.match(urlRe) ?? []) {
          const noQuery = match.slice(MEDIA_PROTOCOL_PREFIX.length).split('?')[0];
          const raw = noQuery.replace(/[.,;:!?]+$/, ''); // trim trailing prose punctuation
          if (raw.length === 0) continue;
          try {
            into.add(decodeURIComponent(raw));
          } catch {
            into.add(raw);
          }
        }
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (v && typeof v === 'object') {
      for (const key of Object.keys(v as Record<string, unknown>)) visit((v as Record<string, unknown>)[key]);
    }
  };
  visit(value);
  return into;
}

/**
 * Delete media files that WERE referenced by removed conversations but are NOT
 * referenced by any surviving conversation. `removedRefs` is the union of media
 * paths from the deleted conversation trees; `survivingRefs` is the union across
 * all conversations that remain on disk. Only files in `removedRefs \ survivingRefs`
 * are unlinked, and only if they resolve safely under mediaDir. Best-effort: a
 * failure to remove one file never throws (GC is a cleanup, not a correctness gate).
 * Returns the number of files actually removed.
 */
export function gcOrphanedMedia(appHome: string, removedRefs: Set<string>, survivingRefs: Set<string>): number {
  const mediaDir = join(appHome, 'media');
  let removed = 0;
  let realRoot: string;
  try {
    realRoot = realpathSync(mediaDir);
  } catch {
    return 0; // no media dir → nothing to GC
  }
  for (const rel of removedRefs) {
    if (survivingRefs.has(rel)) continue; // still referenced elsewhere — keep
    const filePath = join(mediaDir, rel);
    // Lexical containment first (cheap reject of `../` refs)...
    if (filePath !== mediaDir && !filePath.startsWith(mediaDir + sep)) continue;
    try {
      // The FINAL component must be a genuine regular file, inspected via lstat (NOT
      // followed): a symlink there resolves elsewhere, and deleting its TARGET could
      // remove a file still referenced under its real path — so skip any symlink/
      // dir/special node and only ever unlink the real file we wrote.
      const st = lstatSync(filePath);
      if (!st.isFile()) continue;
      // CANONICAL containment for ANCESTORS: a planted `media/images -> ~/.ssh`
      // symlinked parent would pass the lexical check, so resolve the parent chain
      // and confirm the real location is still inside the media root before unlinking.
      const realPath = realpathSync(filePath);
      if (realPath !== realRoot && !realPath.startsWith(realRoot + sep)) continue;
      // Unlink the ORIGINAL path (a real file, ancestors verified in-root) — never
      // realPath, which for a (already-excluded) symlink would be the target.
      rmSync(filePath, { force: true });
      removed++;
    } catch {
      /* missing or unremovable — best-effort */
    }
  }
  return removed;
}

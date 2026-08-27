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
import { mkdirSync, statSync, lstatSync, rmSync } from 'fs';
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

/** True when a string is already a servable URL (offloaded or remote) — leave it. */
function isAlreadyUrl(value: string): boolean {
  return (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    // any custom scheme that isn't a data: URL (covers kai-media:// under any brand)
    (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !value.startsWith('data:'))
  );
}

/**
 * Write a decoded base64 media payload to `mediaDir` (content-addressed so
 * identical bytes reuse one file across edits/regenerations) and return its
 * `kai-media://` URL, or null if the payload is unusable (too large / empty).
 */
function offloadBase64(dataUrl: string, appHome: string): string | null {
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return null;
  const mime = (m[1] ?? 'application/octet-stream').trim() || 'application/octet-stream';
  const base64 = m[2] ?? '';
  if (base64.length === 0) return null;

  let buf: Buffer;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
  // Guard against a pathological payload exhausting memory/disk (mirrors the
  // generated-media cap). Leave oversized media inline rather than truncating it.
  if (buf.length === 0 || buf.length > MAX_MEDIA_BYTES) return null;

  const { type, ext } = mediaTarget(mime);
  // Content-addressed filename: identical bytes → same file, so editing or
  // regenerating a message with the same attachment never duplicates on disk.
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const dir = join(appHome, 'media', type);
  const filename = `${hash}.${ext}`;
  const filePath = join(dir, filename);

  try {
    // Reuse an existing content-addressed file only if it's a real, non-empty
    // regular file matching the payload size — never trust a partial/zero-byte
    // leftover from a crashed/ENOSPC write (which would let us drop the inline
    // base64 while the on-disk copy is corrupt). Re-materialize otherwise.
    let reusable = false;
    try {
      const st = statSync(filePath);
      reusable = st.isFile() && st.size === buf.length;
    } catch {
      /* missing → not reusable */
    }
    if (!reusable) {
      mkdirSync(dir, { recursive: true });
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
 * path escapes mediaDir, or the file can't be read — callers then leave the value
 * as-is (a broken model image is better than crashing the turn). Security mirrors
 * the protocol handler: strip query, decode, join under mediaDir, lexical
 * containment check so a crafted `../` URL can't read outside the media dir.
 * `mimeType` (from the part) takes precedence over the extension-derived MIME.
 */
export function rehydrateMediaUrl(value: string, appHome: string, mimeType?: string): string | null {
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
  // Lexical containment (cheap first pass); the symlink/TOCTOU-safe read below is
  // authoritative. A bare statSync/readFileSync would FOLLOW a symlink planted
  // inside mediaDir (by a crafted conversation/plugin tree) and read an arbitrary
  // file, then send it to the model — so use the same realpath + O_NOFOLLOW helper
  // the media protocol handler uses. A ranged read caps the size (a media file is
  // ≤ MAX_MEDIA_BYTES; a larger/symlinked target is rejected via `size`).
  if (filePath !== mediaDir && !filePath.startsWith(mediaDir + sep)) return null;
  const ranged = safeReadRangeWithin(mediaDir, filePath, 0, MAX_MEDIA_BYTES - 1);
  if (!ranged || ranged.size === 0 || ranged.size > MAX_MEDIA_BYTES) return null;
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
 * renderer). We rehydrate in branch order until `maxTotalBytes` of decoded media has
 * been materialized, then leave further URLs un-rehydrated. The whole-request media
 * ceiling means the provider can't accept more than that anyway; the most-recent
 * turn's attachments (end of the branch) are what matter and comfortably fit, while
 * a pathological deep-history media pile can't OOM main. Default cap is generous
 * (4× the per-result media total) — enough for any realistic turn.
 */
export function rehydrateModelMedia(messages: unknown[], appHome: string, maxTotalBytes = REHYDRATE_TOTAL_CAP): unknown[] {
  if (!Array.isArray(messages)) return messages;
  let anyChanged = false;
  let budget = maxTotalBytes;
  // Resolve a value within the remaining byte budget; decrements budget by the
  // materialized size. Returns null (leave as-is) when unresolvable OR the budget
  // is exhausted / this file alone would blow it.
  const resolve = (value: string, mimeType?: string): string | null => {
    if (budget <= 0) return null;
    const data = rehydrateMediaUrl(value, appHome, mimeType);
    if (!data) return null;
    // Approx decoded bytes from the produced data: URL (payload len * 3/4).
    const payloadLen = data.length - (data.indexOf(',') + 1);
    const bytes = Math.floor((payloadLen * 3) / 4);
    if (bytes > budget) return null; // would exceed the cap → leave the URL
    budget -= bytes;
    return data;
  };
  const out = messages.map((rawMsg) => {
    const msg = rawMsg as { content?: unknown } & Record<string, unknown>;
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) return rawMsg;
    let contentChanged = false;
    const content = (msg.content as LoosePart[]).map((raw) => {
      const part = raw as LoosePart;
      if (!part || typeof part !== 'object') return raw;
      const mime = typeof part.mimeType === 'string' ? part.mimeType : undefined;
      if (part.type === 'image' && typeof part.image === 'string') {
        const data = resolve(part.image, mime);
        if (data) {
          contentChanged = true;
          return { ...part, image: data };
        }
        return raw;
      }
      if (part.type === 'file' && typeof part.data === 'string') {
        const data = resolve(part.data, mime);
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

// ─── Reference-aware media GC ─────────────────────────────────────────────────
// Offloaded (and generated) media live in a GLOBAL per-app media dir, shared
// across conversations (content-addressed → identical bytes are one file). When a
// conversation is deleted/cleared, its media must be reclaimed — both to bound
// disk and, for privacy, so a deleted sensitive chat's attachments don't linger.
// But a file may be referenced by OTHER conversations, so deletion is
// reference-counted: a file is removed only when NO surviving conversation
// references it. Collection scans the WHOLE tree (display parts AND tool
// results / _modelContent), since generated media is referenced from tool output.

/** Collect every `<mediaDir>`-relative path referenced by `kai-media://` URLs
 *  anywhere in a value (deep walk over arrays/objects/strings). Returned paths are
 *  normalized (query stripped, percent-decoded) for set membership. */
export function collectReferencedMediaPaths(value: unknown, into: Set<string> = new Set()): Set<string> {
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.startsWith(MEDIA_PROTOCOL_PREFIX)) {
        const raw = v.slice(MEDIA_PROTOCOL_PREFIX.length).split('?')[0];
        try {
          into.add(decodeURIComponent(raw));
        } catch {
          into.add(raw);
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
  for (const rel of removedRefs) {
    if (survivingRefs.has(rel)) continue; // still referenced elsewhere — keep
    const filePath = join(mediaDir, rel);
    // Containment: never unlink outside mediaDir (a crafted path in a tree).
    if (filePath !== mediaDir && !filePath.startsWith(mediaDir + sep)) continue;
    try {
      // lstat (NOT stat) so a symlink is inspected as the link itself, never
      // followed: only unlink a genuine regular file we could have written. A
      // symlink/dir/special entry planted in mediaDir is skipped, so GC can't be
      // tricked into removing (or traversing to) anything outside the media tree.
      const st = lstatSync(filePath);
      if (!st.isFile()) continue;
      rmSync(filePath, { force: true });
      removed++;
    } catch {
      /* missing or unremovable — best-effort */
    }
  }
  return removed;
}

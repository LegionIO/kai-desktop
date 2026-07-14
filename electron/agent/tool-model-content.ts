/**
 * Shared handling for the `_modelContent` tool-result convention.
 *
 * A tool's `execute()` may attach a reserved `_modelContent` array to its
 * returned object. It carries content the *model* should see natively — most
 * importantly images — that must not be JSON-stringified into an opaque base64
 * blob. Each runtime strips `_modelContent` from the text/JSON it shows the
 * model and re-emits those parts as that runtime's native content type
 * (AI-SDK content parts for Mastra, MCP content blocks for the SDK bridges).
 *
 * The visible JSON result should stay small and descriptive (ids, names,
 * notes); the heavy bytes ride only in `_modelContent`.
 */

/** A single model-visible content part carried on a tool result. */
export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mediaType: string }
  | { type: 'file'; data: string; mediaType: string; filename?: string };

/** Max bytes for a single image/file part before it is dropped (base64 inflates ~4/3). */
const MAX_PART_BYTES = 5 * 1024 * 1024;
/** Max total bytes across all parts in one tool result. */
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

function approxBytes(base64: string): number {
  // 4 base64 chars ≈ 3 bytes; ignore padding for an estimate.
  return Math.floor((base64.length * 3) / 4);
}

/**
 * The `data` field is contracted to be *bare* base64 (no `data:` URL prefix) —
 * that is what every runtime's downstream (AI-SDK `image-data`/`file-data`, MCP
 * `image`/`resource`) expects. A leading `data:<mime>;base64,` prefix would be
 * treated as part of the payload and silently corrupt the decoded bytes at the
 * provider. Strip it defensively and, when the caller left `mediaType` generic,
 * adopt the media type declared in the prefix.
 */
const DATA_URL_RE = /^data:([^;,]+)?(?:;[^,]*)?,(.*)$/s;
function normalizeMediaData(data: string, mediaType: string): { data: string; mediaType: string } {
  const m = DATA_URL_RE.exec(data);
  if (!m) return { data, mediaType };
  const prefixMime = m[1];
  const useMime = prefixMime && (!mediaType || mediaType === 'application/octet-stream') ? prefixMime : mediaType;
  return { data: m[2] ?? '', mediaType: useMime };
}

function isModelContentPart(v: unknown): v is ModelContentPart {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  if (p.type === 'text') return typeof p.text === 'string';
  if (p.type === 'image' || p.type === 'file') {
    return typeof p.data === 'string' && typeof p.mediaType === 'string';
  }
  return false;
}

/**
 * Split a tool result into its model-visible content parts and a cleaned result
 * (the same value with `_modelContent` removed) for the text/JSON channel.
 *
 * Oversized image/file parts are dropped and replaced with a text note so the
 * model still learns the item existed without blowing the input budget.
 */
export function extractModelContent(result: unknown): {
  modelContent: ModelContentPart[] | null;
  cleaned: unknown;
} {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { modelContent: null, cleaned: result };
  }
  const obj = result as Record<string, unknown>;
  const raw = obj._modelContent;
  if (!Array.isArray(raw)) return { modelContent: null, cleaned: result };

  const { _modelContent, ...rest } = obj;
  void _modelContent;

  const parts: ModelContentPart[] = [];
  let total = 0;
  for (const item of raw) {
    if (!isModelContentPart(item)) continue;
    if (item.type === 'text') {
      parts.push(item);
      continue;
    }
    // Normalize away any accidental `data:` URL prefix so the payload measured
    // and forwarded is genuine base64.
    const { data, mediaType } = normalizeMediaData(item.data, item.mediaType);
    const bytes = approxBytes(data);
    if (bytes > MAX_PART_BYTES || total + bytes > MAX_TOTAL_BYTES) {
      const label = item.type === 'image' ? 'image' : 'file';
      parts.push({
        type: 'text',
        text: `[${label} omitted: ${(bytes / (1024 * 1024)).toFixed(1)} MB exceeds the per-result media limit]`,
      });
      continue;
    }
    total += bytes;
    parts.push(
      item.type === 'image'
        ? { type: 'image', data, mediaType }
        : { type: 'file', data, mediaType, ...(item.filename ? { filename: item.filename } : {}) },
    );
  }

  return { modelContent: parts.length > 0 ? parts : null, cleaned: rest };
}

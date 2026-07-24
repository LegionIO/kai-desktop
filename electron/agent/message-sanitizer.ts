import { messageContentSig } from './tokenization.js';

type MessageLike = {
  role?: string;
  content?: unknown;
  messageMeta?: Record<string, unknown>;
  [key: string]: unknown;
};

type PartLike = Record<string, unknown>;

const PROVIDER_META_KEYS = ['providerMetadata', 'providerOptions', 'experimental_providerMetadata'] as const;

function stripProviderMeta(part: PartLike): PartLike {
  let needsClone = false;
  for (const key of PROVIDER_META_KEYS) {
    if (Object.hasOwn(part, key)) {
      needsClone = true;
      break;
    }
  }
  if (!needsClone) return part;

  const cleaned = { ...part };
  for (const key of PROVIDER_META_KEYS) delete cleaned[key];
  return cleaned;
}

function sanitizeContentParts(content: unknown): unknown {
  if (!Array.isArray(content)) return content;

  let changed = false;
  const result = content.map((part) => {
    if (part == null || typeof part !== 'object') return part;
    const cleaned = stripProviderMeta(part as PartLike);
    if (cleaned !== part) changed = true;
    return cleaned;
  });

  return changed ? result : content;
}

/** True if the message carries provider metadata at the MESSAGE level (not just
 *  inside content parts). These fields survive a model switch and can carry a
 *  provider-specific shape the next provider rejects. */
function hasMessageLevelProviderMeta(msg: MessageLike): boolean {
  return PROVIDER_META_KEYS.some((k) => Object.hasOwn(msg, k));
}

/** Strip content-part metadata AND message-level provider metadata. Returns the
 *  same object reference when nothing changed (so callers can detect no-ops). */
function sanitizeMessage(msg: MessageLike): MessageLike {
  const cleanedContent = sanitizeContentParts(msg.content);
  const msgLevel = hasMessageLevelProviderMeta(msg);
  if (cleanedContent === msg.content && !msgLevel) return msg;
  const next: MessageLike = { ...msg, content: cleanedContent };
  for (const k of PROVIDER_META_KEYS) delete (next as Record<string, unknown>)[k];
  return next;
}

/**
 * Model-scoped sanitization: strip provider-specific metadata from assistant
 * messages that were produced by a different model than the current target.
 *
 * Messages tagged with `messageMeta.sourceModel` matching `targetModelId` keep
 * their metadata. Messages with a different sourceModel or no tag at all have
 * provider metadata stripped defensively.
 */
export function sanitizeMessagesForModel(messages: unknown[], targetModelId: string): unknown[] {
  let changed = false;
  const result = messages.map((rawMsg) => {
    const msg = rawMsg as MessageLike;
    if (!msg || typeof msg !== 'object') return rawMsg;
    if (msg.role !== 'assistant') return rawMsg;

    const sourceModel = msg.messageMeta?.sourceModel as string | undefined;
    if (sourceModel === targetModelId) return rawMsg;

    const cleaned = sanitizeMessage(msg);
    if (cleaned === msg) return rawMsg;

    changed = true;
    return cleaned;
  });

  return changed ? result : messages;
}

/**
 * Drop a cached `tokenCount` from any message whose CURRENT content no longer
 * matches its stored `tokenCountSig`. Applied on the send path after a transform
 * hook (plugin pre-send / UserPromptSubmit modify) MAY have rewritten messages —
 * including IN PLACE on the same array reference (so an array-identity check would
 * miss it). Recomputing the signature and comparing catches both in-place and
 * replacement rewrites; a message the hook left untouched keeps its count (and the
 * accumulator fast path). A message with a count but NO signature is treated as
 * unverifiable → count dropped (safe: the read-side sum then estimates).
 * Returns the same array reference when nothing changed.
 */
export function invalidateStaleTokenCounts(messages: unknown[]): unknown[] {
  let changed = false;
  const out = messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const rec = m as Record<string, unknown>;
    if (!('tokenCount' in rec)) return m; // nothing cached → nothing to invalidate
    const sig = rec.tokenCountSig;
    const stillValid =
      typeof sig === 'number' && sig === messageContentSig({ role: rec.role, content: rec.content });
    if (stillValid) return m;
    changed = true;
    const { tokenCount: _c, tokenCountSig: _s, ...rest } = rec;
    void _c;
    void _s;
    return rest;
  });
  return changed ? out : messages;
}

/**
 * Strip user-message `file` parts flagged `displayOnly` — the renderer keeps
 * these for the attachment chip but already inlines their content as a
 * sibling text part, so providers (which reject e.g. `application/json`)
 * should never see them.
 */
export function stripDisplayOnlyParts(messages: unknown[]): unknown[] {
  let changed = false;
  const result = messages.map((rawMsg) => {
    const msg = rawMsg as MessageLike;
    if (msg?.role !== 'user' || !Array.isArray(msg.content)) return rawMsg;

    const filtered = (msg.content as PartLike[]).filter(
      (p) => !(p && typeof p === 'object' && p.type === 'file' && p.displayOnly === true),
    );
    if (filtered.length === msg.content.length) return rawMsg;
    // Guard: if stripping the displayOnly part(s) would leave the message with NO
    // content, the expected inline sibling text is missing. Emitting `content: []`
    // loses the turn and some providers reject it — keep the original instead.
    if (filtered.length === 0) return rawMsg;

    changed = true;
    return { ...msg, content: filtered };
  });

  return changed ? result : messages;
}

/**
 * Aggressive sanitization: strip ALL provider metadata from every message
 * regardless of source. Used on retry after a provider-mismatch error.
 */
export function deepSanitizeMessages(messages: unknown[]): unknown[] {
  let changed = false;
  const result = messages.map((rawMsg) => {
    const msg = rawMsg as MessageLike;
    if (!msg || typeof msg !== 'object') return rawMsg;
    const cleaned = sanitizeMessage(msg);
    if (cleaned === msg) return rawMsg;

    changed = true;
    return cleaned;
  });

  return changed ? result : messages;
}

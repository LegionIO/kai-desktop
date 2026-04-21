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
    if (part[key] != null) { needsClone = true; break; }
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

/**
 * Model-scoped sanitization: strip provider-specific metadata from assistant
 * messages that were produced by a different model than the current target.
 *
 * Messages tagged with `messageMeta.sourceModel` matching `targetModelId` keep
 * their metadata. Messages with a different sourceModel or no tag at all have
 * provider metadata stripped defensively.
 */
export function sanitizeMessagesForModel(
  messages: unknown[],
  targetModelId: string,
): unknown[] {
  let changed = false;
  const result = messages.map((rawMsg) => {
    const msg = rawMsg as MessageLike;
    if (msg.role !== 'assistant') return rawMsg;

    const sourceModel = msg.messageMeta?.sourceModel as string | undefined;
    if (sourceModel === targetModelId) return rawMsg;

    const cleaned = sanitizeContentParts(msg.content);
    if (cleaned === msg.content) return rawMsg;

    changed = true;
    return { ...msg, content: cleaned };
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
    const cleaned = sanitizeContentParts(msg.content);
    if (cleaned === msg.content) return rawMsg;

    changed = true;
    return { ...msg, content: cleaned };
  });

  return changed ? result : messages;
}

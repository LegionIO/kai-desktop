// Remote transports are frame-capped (web WS 4 MiB, CLI local-bridge 8 MiB) while a tool result can
// retain up to ~20 MiB of media (or a pre-compaction `originalContent` backup up to many MiB).
// Sending such a payload over-frame DISCONNECTS the socket before later events arrive. Local
// Electron windows have no frame cap, so we strip ONLY the copy fanned out to remote clients; a
// remote client that needs the full payload re-fetches the persisted record via conversations:get.
//
// This is the single shared implementation used by both the main agent stream broadcast and the
// sub-agent broadcast (a leaf module so neither has to import the other).

const REMOTE_ORIGINAL_CAP = 4096;
const REMOTE_STRIP_MAX_DEPTH = 8;
// Any string field longer than this is truncated for the remote copy — not just the whitelisted
// media keys. A tool/MCP result can put multi-MiB text under an arbitrary key (e.g. `output`,
// `stdout`, `content`); left intact it would exceed the CLI 8 MiB / web 4 MiB frame and disconnect
// the client. 256 KiB keeps normal text intact while bounding a single string's contribution.
const REMOTE_STRING_CAP = 256 * 1024;
function capString(s: string): string {
  return s.length > REMOTE_STRING_CAP ? `${s.slice(0, REMOTE_STRING_CAP)}…[truncated-in-broadcast]` : s;
}

// Bounded recursive strip of base64 / _modelContent / oversized backups / any oversized string from
// a payload for the remote fan-out. A depth-exhausted container is replaced with an omission marker
// (NOT returned verbatim) so a deeply-nested media blob can't bypass the cap.
export function stripRemoteMediaDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return capString(value); // a top-level / primitive string too
  if (Array.isArray(value)) {
    return depth >= REMOTE_STRIP_MAX_DEPTH
      ? '[omitted-in-broadcast]'
      : value.map((v) => stripRemoteMediaDeep(v, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;
  if (depth >= REMOTE_STRIP_MAX_DEPTH) return '[omitted-in-broadcast]';
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  for (const k of ['image', 'data', 'dataUrl', 'url', 'source']) {
    if (typeof out[k] === 'string' && (out[k] as string).length > 256) out[k] = '[omitted-in-broadcast]';
  }
  for (const k of ['originalResult', 'originalContent']) {
    if (typeof out[k] === 'string' && (out[k] as string).length > REMOTE_ORIGINAL_CAP) out[k] = '[omitted-in-broadcast]';
  }
  if (Array.isArray(out._modelContent)) out._modelContent = '[omitted-in-broadcast]';
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string') {
      // Any other oversized string field (not already replaced above) → truncate.
      if (out[k] !== '[omitted-in-broadcast]') out[k] = capString(v);
    } else if (v && typeof v === 'object') {
      out[k] = stripRemoteMediaDeep(v, depth + 1);
    }
  }
  return out;
}

// Cap the oversized fields of a stream/sub-agent event for the remote fan-out. Returns the event
// unchanged when nothing needs capping (the common case), else a shallow-cloned capped copy:
//  - tool-compaction: data.originalContent replaced when large;
//  - tool-result / any event with a result or compaction: the result payload is deep-stripped and
//    compaction.originalContent capped.
export function capRemoteEvent<T>(event: T): T {
  const e = event as unknown as {
    type?: string;
    data?: { originalContent?: unknown };
    compaction?: { originalContent?: unknown };
    result?: unknown;
  };
  if (e.type === 'tool-compaction') {
    if (typeof e.data?.originalContent === 'string' && e.data.originalContent.length > REMOTE_ORIGINAL_CAP) {
      return { ...(event as Record<string, unknown>), data: { ...e.data, originalContent: '[omitted-in-broadcast]' } } as T;
    }
    return event;
  }
  const bigOriginal =
    typeof e.compaction?.originalContent === 'string' && e.compaction.originalContent.length > REMOTE_ORIGINAL_CAP;
  const hasResult = e.result !== undefined && e.result !== null;
  if (!bigOriginal && !hasResult) return event;
  const out: Record<string, unknown> = { ...(event as Record<string, unknown>) };
  if (bigOriginal) out.compaction = { ...(e.compaction as object), originalContent: '[omitted-in-broadcast]' };
  if (hasResult) out.result = stripRemoteMediaDeep(e.result);
  return out as T;
}

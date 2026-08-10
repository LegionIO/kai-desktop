// Remote transports are frame-capped (web WS 4 MiB, CLI local-bridge 8 MiB) while a tool result can
// retain up to ~20 MiB of media (or a pre-compaction `originalContent` backup up to many MiB).
// Sending such a payload over-frame DISCONNECTS the socket before later events arrive. Local
// Electron windows have no frame cap, so we strip ONLY the copy fanned out to remote clients; a
// remote client that needs the full payload re-fetches the persisted record via conversations:get.
//
// This is the single shared implementation used by the main agent stream broadcast, the sub-agent
// broadcasts, AND the conversation-upsert broadcast (a leaf module so callers don't import each
// other).

const REMOTE_ORIGINAL_CAP = 4096;
const REMOTE_STRIP_MAX_DEPTH = 8;
// Per-string ceiling — one string field longer than this is truncated. A tool/MCP result can put
// multi-MiB text under an arbitrary key (`output`, `stdout`, `content`); 256 KiB keeps normal text
// intact while bounding a single string's contribution.
const REMOTE_STRING_CAP = 256 * 1024;
// CUMULATIVE serialized-byte budget for one whole event/payload. Per-string caps alone don't bound
// the frame — e.g. 40 strings of 250 KiB each pass individually but total ~10 MiB, over the CLI's
// 8 MiB frame, disconnecting it. Once the running total exceeds this budget, every remaining subtree
// is replaced with an omission marker. Set below both frame limits (web 4 MiB is the tighter one),
// with headroom for the JSON envelope + control fields; a remote client re-fetches full content via
// conversations:get, so aggressive omission past the budget only affects the live event, not the
// persisted record.
const REMOTE_EVENT_BYTE_BUDGET = 3 * 1024 * 1024;

const OMIT = '[omitted-in-broadcast]';

function capString(s: string): string {
  return s.length > REMOTE_STRING_CAP ? `${s.slice(0, REMOTE_STRING_CAP)}…[truncated-in-broadcast]` : s;
}

type Budget = { used: number };

// Bounded recursive strip of base64 / _modelContent / oversized backups / any oversized string from
// a payload for the remote fan-out. A depth-exhausted container OR a budget-exhausted subtree is
// replaced with an omission marker (NOT returned verbatim) so neither a deeply-nested blob nor a
// large aggregate of individually-small strings can exceed the frame.
function stripInner(value: unknown, depth: number, budget: Budget): unknown {
  if (budget.used >= REMOTE_EVENT_BYTE_BUDGET) return OMIT; // budget spent — omit the rest
  if (typeof value === 'string') {
    const capped = capString(value);
    // Charge the UTF-8 BYTE length, not the JS string length (UTF-16 units): a CJK char is 1 unit
    // but 3 bytes, so counting units undercounts the serialized frame ~3x and lets a CJK-heavy
    // payload blow the limit. Buffer.byteLength gives the exact UTF-8 size cheaply (no copy).
    budget.used += Buffer.byteLength(capped, 'utf8');
    return capped;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
    budget.used += 8;
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= REMOTE_STRIP_MAX_DEPTH) return OMIT;
    const arr: unknown[] = [];
    for (const v of value) {
      if (budget.used >= REMOTE_EVENT_BYTE_BUDGET) {
        arr.push(OMIT);
        break;
      }
      arr.push(stripInner(v, depth + 1, budget));
    }
    return arr;
  }
  if (typeof value !== 'object') return value;
  if (depth >= REMOTE_STRIP_MAX_DEPTH) return OMIT;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    budget.used += k.length + 4;
    if (budget.used >= REMOTE_EVENT_BYTE_BUDGET) {
      out[k] = OMIT;
      continue;
    }
    // Whitelisted media keys: drop wholesale when large (base64 image/file data URLs, source blobs).
    if ((k === 'image' || k === 'data' || k === 'dataUrl' || k === 'url' || k === 'source') && typeof v === 'string' && v.length > 256) {
      out[k] = OMIT;
      continue;
    }
    // UI-only pre-compaction backups: full oversized text — never needed in a broadcast.
    if ((k === 'originalResult' || k === 'originalContent') && typeof v === 'string' && v.length > REMOTE_ORIGINAL_CAP) {
      out[k] = OMIT;
      continue;
    }
    // Reserved plugin media convention: drop the whole _modelContent blob (base64 lives here).
    if (k === '_modelContent' && Array.isArray(v)) {
      out[k] = OMIT;
      continue;
    }
    out[k] = stripInner(v, depth + 1, budget);
  }
  return out;
}

// Public: strip a standalone value for the remote fan-out. Callers that strip MANY values that
// share ONE frame (e.g. every message part of a conversation upsert) must pass a SHARED budget from
// newRemoteBudget() so the cumulative cap bounds the WHOLE frame — a fresh per-value budget would
// let N parts each spend the full budget (N×3 MiB total, over-frame). Omit the budget only for a
// genuinely standalone value.
export type RemoteCapBudget = Budget;
export function newRemoteBudget(): RemoteCapBudget {
  return { used: 0 };
}
export function stripRemoteMediaDeep(value: unknown, budget?: RemoteCapBudget): unknown {
  return stripInner(value, 0, budget ?? { used: 0 });
}

// Cap a stream/sub-agent event for the remote fan-out. Deep-caps the ENTIRE event under ONE shared
// cumulative byte budget so the serialized frame stays bounded regardless of how the payload is
// shaped (one huge string, many medium strings, deep nesting, or media). Small control fields
// (type/conversationId/runGeneration/toolCallId/toolName) are short and pass through untouched.
export function capRemoteEvent<T>(event: T): T {
  if (!event || typeof event !== 'object') return event;
  return stripInner(event, 0, { used: 0 }) as T;
}

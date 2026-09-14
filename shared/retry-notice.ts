/**
 * Retry-notice formatting — shared by the renderer thread, the `kai` CLI, and
 * anything else that surfaces a `retry` stream event.
 *
 * A `retry` event is Kai's own bookkeeping, NOT model output: the request never
 * reached the model (or failed before emitting a token), so Kai reshaped or
 * re-sent it. Historically every producer hand-formatted its own line and each
 * consumer re-derived one from raw `attempt`/`delayMs`/`category` fields, which
 * produced notices that read like assistant prose ("Retrying (1/4) in 0s —
 * compatibility") and said nothing about what was actually adjusted or why.
 *
 * Producers now tag the event with a `kind` (plus, for a provider-compatibility
 * retry, the specific `adjustment` that was made) and this module owns the
 * wording. Field normalization is deliberately permissive because producers
 * disagree on names — the Claude Agent SDK bridge emits `delay`/`error` where
 * the Mastra path emits `delayMs`/`reason` — and a notice must never render
 * `(1/undefined)` or `NaN` at the user.
 */

/** What prompted the retry. Drives the wording; unknown/absent falls back to the generic line. */
export type RetryNoticeKind =
  /** Provider rejected a request parameter or the history shape; Kai reshaped and re-sent. */
  | 'provider-compatibility'
  /** Transient failure (rate limit, 5xx, network, timeout); Kai waited and re-sent unchanged. */
  | 'transient'
  /** Request exceeded the context window; Kai compacted the conversation and re-sent. */
  | 'context-overflow';

/** The specific reshaping applied for a `provider-compatibility` retry. */
export type RetryNoticeAdjustment =
  /** The model rejected `temperature`, so it was dropped from the request. */
  | 'omit-temperature'
  /** The provider rejected the message history shape, so it was sanitized. */
  | 'sanitize-messages';

/** Raw `data` payload of a `retry` stream event, as any producer may shape it. */
export type RetryNoticeData = {
  kind?: RetryNoticeKind;
  adjustment?: RetryNoticeAdjustment;
  /** 1-based attempt number this retry begins. */
  attempt?: number;
  maxRetries?: number;
  /** Backoff before the next attempt. `delaySeconds`/`delay` are Claude-SDK spellings. */
  delayMs?: number;
  delaySeconds?: number;
  delay?: number;
  /** Underlying provider message. `error` is the Claude-SDK spelling. */
  reason?: string;
  error?: string;
  category?: string;
  /** Pre-formatted override. Honoured verbatim (legacy producers).  */
  text?: string;
};

export type RetryNotice = {
  /** One short sentence: what Kai did. Plain text — never markdown. */
  title: string;
  /** Optional second line: the provider's own wording, so the cause is inspectable. */
  detail?: string;
};

/** Longest provider message we inline before eliding — keeps the notice to ~2 lines. */
const MAX_DETAIL_CHARS = 240;

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** Normalize the two delay spellings to milliseconds. `delaySeconds`/`delay` are seconds. */
function resolveDelayMs(data: RetryNoticeData): number | undefined {
  const ms = firstFiniteNumber(data.delayMs);
  if (ms !== undefined) return Math.max(0, ms);
  const seconds = firstFiniteNumber(data.delaySeconds, data.delay);
  return seconds === undefined ? undefined : Math.max(0, seconds * 1000);
}

/** Human-readable backoff, or null when there is no meaningful wait (the sub-second
 *  case included — a compatibility retry re-sends immediately and "in 0s" is noise). */
function formatDelay(delayMs: number | undefined): string | null {
  if (delayMs === undefined || delayMs < 1000) return null;
  const seconds = Math.round(delayMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/** "attempt 2 of 4" — omitted entirely unless BOTH numbers are known, so a
 *  producer that tracks one but not the other can't render "(2/undefined)". */
function formatAttempt(attempt: number | undefined, maxRetries: number | undefined): string | null {
  if (attempt === undefined || maxRetries === undefined) return null;
  if (attempt < 1 || maxRetries < 1) return null;
  return `attempt ${attempt} of ${maxRetries}`;
}

/** Plain-English label for a `classifyError` category. */
function describeCategory(category: string | undefined): string | null {
  switch (category) {
    case 'rate-limit':
      return 'the provider rate-limited the request';
    case 'overload':
      return 'the model was overloaded';
    case 'server-error':
      return 'the provider returned a server error';
    case 'network':
      return 'the network connection failed';
    case 'timeout':
      return 'the request timed out';
    case 'quota':
      return 'the account quota was exceeded';
    default:
      return null;
  }
}

function truncateDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const collapsed = detail.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > MAX_DETAIL_CHARS ? `${collapsed.slice(0, MAX_DETAIL_CHARS - 1)}…` : collapsed;
}

/** Join non-null clauses into a parenthetical suffix: " (a, b)". */
function suffix(...clauses: Array<string | null>): string {
  const present = clauses.filter((c): c is string => c !== null);
  return present.length === 0 ? '' : ` (${present.join(', ')})`;
}
/**
 * Turn a `retry` event payload into a user-facing notice.
 *
 * Returns null when the payload carries nothing worth showing, so callers can
 * skip rendering rather than emit an empty chip.
 */
export function formatRetryNotice(data: RetryNoticeData | undefined | null): RetryNotice | null {
  if (!data) return null;

  // A pre-formatted `text` wins: a legacy producer already wrote the sentence.
  // Strip any markdown blockquote/emoji lead-in — the notice surface supplies
  // its own affordance, and the raw "> ℹ️ " leaked into plain-text consumers.
  const override = firstNonEmptyString(data.text);
  if (override) {
    const cleaned = override.replace(/^>\s*/, '').replace(/^ℹ️\s*/, '').trim();
    if (cleaned.length > 0) return { title: cleaned };
  }

  const providerMessage = truncateDetail(firstNonEmptyString(data.reason, data.error));
  const delay = formatDelay(resolveDelayMs(data));
  const attempt = formatAttempt(firstFiniteNumber(data.attempt), firstFiniteNumber(data.maxRetries));

  if (data.kind === 'provider-compatibility') {
    if (data.adjustment === 'omit-temperature') {
      return {
        title: "This model rejected the temperature setting, so Kai re-sent the request without it.",
        detail: providerMessage,
      };
    }
    if (data.adjustment === 'sanitize-messages') {
      return {
        title: 'The provider rejected the conversation history, so Kai repaired it and re-sent the request.',
        detail: providerMessage,
      };
    }
    return {
      title: "Kai adjusted the request to match this model's API and re-sent it.",
      detail: providerMessage,
    };
  }

  if (data.kind === 'context-overflow') {
    return {
      title: 'The request exceeded the context window, so Kai compacted the conversation and re-sent it.',
      detail: providerMessage,
    };
  }

  // Transient (or an untagged legacy producer): the request is unchanged, it just failed.
  const cause = describeCategory(data.category);
  const because = cause ? ` because ${cause}` : '';
  const waited = delay ? `retrying in ${delay}` : 'retrying';
  return {
    title: `The request failed${because} — ${waited}${suffix(attempt)}.`,
    detail: providerMessage,
  };
}

/** Single-line rendering for plain-text surfaces (the `kai` CLI note rows). */
export function formatRetryNoticeLine(data: RetryNoticeData | undefined | null): string | null {
  const notice = formatRetryNotice(data);
  if (!notice) return null;
  return notice.detail ? `${notice.title} — ${notice.detail}` : notice.title;
}

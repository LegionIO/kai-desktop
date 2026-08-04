/**
 * Robust retry system with exponential backoff, Retry-After header respect,
 * error classification, and stream event emission for UI feedback.
 *
 * Inspired by Claude Code's withRetry pattern (src/services/api/withRetry.ts).
 */

export type RetryableErrorInfo = {
  statusCode?: number;
  retryAfterMs?: number;
  isTransient: boolean;
  category:
    | 'rate-limit'
    | 'overload'
    | 'server-error'
    | 'timeout'
    | 'network'
    | 'auth'
    | 'quota'
    | 'context-overflow'
    | 'client-error'
    | 'unknown';
  message: string;
};

export type RetryOptions = {
  /** Maximum number of retry attempts (default: 4) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 500) */
  baseDelayMs?: number;
  /** Maximum delay cap in ms (default: 32000) */
  maxDelayMs?: number;
  /** AbortSignal to cancel retries */
  abortSignal?: AbortSignal;
  /** Called before each retry with delay info — use for UI events */
  onRetry?: (info: { attempt: number; delay: number; reason: string; category: string }) => void;
};

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 32_000;
const RETRY_AFTER_CAP_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Classify an error to determine retryability and category. */
export function classifyError(error: unknown): RetryableErrorInfo {
  const message = extractErrorMessage(error);
  const statusCode = extractStatusCode(error);
  const retryAfterMs = extractRetryAfterMs(error);

  // Explicit provider marker: some SDKs/gateways set `isRetryable: true` on the
  // error object for a transient failure that carries no recognizable status.
  if (error && typeof error === 'object' && (error as { isRetryable?: unknown }).isRetryable === true) {
    return { statusCode, retryAfterMs, isTransient: true, category: 'network', message };
  }

  // Auth errors — not transient
  if (statusCode === 401 || statusCode === 403) {
    return { statusCode, retryAfterMs, isTransient: false, category: 'auth', message };
  }

  // Rate limit (429) — transient. Checked before the generic 4xx branch.
  if (statusCode === 429) {
    return { statusCode, retryAfterMs, isTransient: true, category: 'rate-limit', message };
  }

  // Timeout (408) — transient. Checked before the generic 4xx branch (a 408 is a
  // request timeout the server invites you to retry, not a permanent client error).
  if (statusCode === 408) {
    return { statusCode, retryAfterMs, isTransient: true, category: 'timeout', message };
  }

  // Payment required (402) — a provider/account billing or quota problem, not a
  // malformed request. Retrying the SAME model won't fix it (and a Retry-After
  // could make it sleep for hours), but falling back to a different
  // model/profile should. Mark transient so fallback engages, but callers must
  // gate SAME-MODEL retries on isSameModelRetryable() (which excludes quota).
  if (statusCode === 402) {
    return { statusCode, retryAfterMs, isTransient: true, category: 'quota', message };
  }

  // Context-window overflow — the request's input exceeds the model's context
  // length. Providers surface this as a 400 (sometimes 413) with a recognizable
  // message. Checked BEFORE the generic 4xx branch so it gets its own category
  // rather than an opaque `client-error`. NOT transient (a same-model retry with
  // the SAME input can't succeed), but the caller can recover by COMPACTING /
  // shrinking the history and retrying — see isContextOverflowError.
  const overflowLower = message.toLowerCase();
  // Exclude THROTTLING / rate-limit phrasings that also mention "tokens" (e.g.
  // AWS `ThrottlingException: too many tokens`, "token rate exceeded", "tokens
  // per minute"). Those are transient rate limits handled by the rate-limit
  // classifier below — misfiling them as overflow would trigger a pointless
  // compaction instead of a retry/fallback.
  const looksLikeThrottle =
    overflowLower.includes('throttl') ||
    overflowLower.includes('rate exceeded') ||
    overflowLower.includes('rate limit') ||
    overflowLower.includes('per minute') ||
    overflowLower.includes('per-minute') ||
    overflowLower.includes('too many requests') ||
    overflowLower.includes('tpm');
  // Exclude OUTPUT-token and QUOTA errors that also say "tokens exceeded": compacting
  // the INPUT context doesn't fix an output cap or an account/billing quota, and
  // recommending `/compact` would mislead. BUT some providers phrase a genuine INPUT
  // overflow as "prompt tokens + max_tokens exceed the context length" — so only
  // treat max_tokens/output phrasing as output-limited when NO input/context
  // phrasing is present. Quota/billing terms are always non-overflow.
  const mentionsContext =
    overflowLower.includes('context length') ||
    overflowLower.includes('context window') ||
    overflowLower.includes('maximum context') ||
    overflowLower.includes('prompt is too long') ||
    overflowLower.includes('input is too long') ||
    overflowLower.includes('reduce the length');
  const looksLikeOutputOrQuota =
    overflowLower.includes('quota') ||
    overflowLower.includes('billing') ||
    overflowLower.includes('credit') ||
    (!mentionsContext &&
      (overflowLower.includes('output token') ||
        overflowLower.includes('max_tokens') ||
        overflowLower.includes('max tokens') ||
        // Generation-cap phrasing from custom/OSS endpoints (vLLM/TGI/etc.) —
        // `max_new_tokens`/`max_output_tokens`/`max_completion_tokens` bound OUTPUT,
        // so compacting the INPUT can't fix them (and would re-fail on the same cap).
        overflowLower.includes('max_new_tokens') ||
        overflowLower.includes('max new tokens') ||
        overflowLower.includes('max_output_tokens') ||
        overflowLower.includes('max_completion_tokens') ||
        overflowLower.includes('generation token') ||
        overflowLower.includes('completion token')));
  const looksLikeOverflow =
    !looksLikeThrottle &&
    !looksLikeOutputOrQuota &&
    (overflowLower.includes('context length') ||
      overflowLower.includes('context window') ||
      overflowLower.includes('maximum context') ||
      overflowLower.includes('prompt is too long') ||
      overflowLower.includes('too many tokens') ||
      overflowLower.includes('too many total tokens') ||
      overflowLower.includes('reduce the length') ||
      overflowLower.includes('input is too long') ||
      (overflowLower.includes('token') && overflowLower.includes('exceed')));
  // A canonical HTTP 413 body ("payload too large" / "request entity too large")
  // WITHOUT any token/context evidence is AMBIGUOUS — it may be a gateway HTTP
  // body-size limit (e.g. nginx client_max_body_size) hit by a single large
  // attachment, which COMPACTION CANNOT FIX. Only treat such a 413-phrasing as
  // overflow when the message ALSO carries token/context evidence; otherwise it
  // falls through to a generic client-error (no paid summary, no /compact guidance).
  // Overflow status codes across providers: OpenAI/Anthropic use 400, some
  // endpoints/proxies use 413 (Payload Too Large), and OpenAI-COMPATIBLE servers
  // (vLLM, LM Studio, etc.) commonly return 422 (Unprocessable Entity) for "prompt
  // is too long". A statusless overflow (message-only) also counts. A 413 is treated
  // as overflow ONLY when its body carries overflow/payload phrasing — a BARE 413
  // (no recognizable text) may be a gateway HTTP body-size limit hit by a single
  // large attachment, which compaction can't fix; misrouting that to a paid
  // summary + `/compact` guidance is worse than a plain client-error. The throttle
  // guard above still excludes rate-limit phrasing.
  if (looksLikeOverflow && (statusCode === undefined || statusCode === 400 || statusCode === 413 || statusCode === 422)) {
    return { statusCode, retryAfterMs, isTransient: false, category: 'context-overflow', message };
  }

  // Client errors (4xx except the retryable 402/408/429 handled above) — not transient
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    return { statusCode, retryAfterMs, isTransient: false, category: 'client-error', message };
  }

  // Overload (529 — Anthropic-specific)
  if (statusCode === 529) {
    return { statusCode, retryAfterMs, isTransient: true, category: 'overload', message };
  }

  // Server errors (5xx)
  if (statusCode !== undefined && statusCode >= 500) {
    return { statusCode, retryAfterMs, isTransient: true, category: 'server-error', message };
  }

  // Network / statusless-timeout errors (no status code, connection-related or
  // timeout keywords). Bedrock/other SDKs sometimes surface a timeout as a bare
  // "Request timed out" with no status — treat those as transient too.
  const lowerMessage = message.toLowerCase();
  if (
    lowerMessage.includes('econnreset') ||
    lowerMessage.includes('econnrefused') ||
    lowerMessage.includes('etimedout') ||
    lowerMessage.includes('timed out') ||
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('epipe') ||
    lowerMessage.includes('socket hang up') ||
    lowerMessage.includes('network') ||
    lowerMessage.includes('fetch failed') ||
    lowerMessage.includes('dns')
  ) {
    return { statusCode, retryAfterMs, isTransient: true, category: 'network', message };
  }

  // AWS-specific transient errors
  if (
    lowerMessage.includes('serviceunavailableexception') ||
    lowerMessage.includes('throttlingexception') ||
    lowerMessage.includes('toomanyrequestsexception')
  ) {
    return { statusCode, retryAfterMs, isTransient: true, category: 'rate-limit', message };
  }

  // Message-only classification for errors that arrive as a bare string with no
  // status code (common for mid-stream provider failures surfaced as an `error`
  // stream event). Without this a string like "internal server error" or
  // "overloaded" would fall through to `unknown` (non-transient) and defeat
  // mid-stream fallback. User-initiated aborts are filtered out BEFORE
  // classifyError is consulted (abortSignal check), so treating a provider-side
  // "canceled"/stream-abort as transient here is safe.
  if (lowerMessage.includes('overloaded') || lowerMessage.includes('529') || lowerMessage.includes('capacity')) {
    return { statusCode, retryAfterMs, isTransient: true, category: 'overload', message };
  }
  if (
    lowerMessage.includes('internal server error') ||
    lowerMessage.includes('service unavailable') ||
    lowerMessage.includes('bad gateway') ||
    lowerMessage.includes('gateway timeout') ||
    /\b(500|502|503|504)\b/.test(lowerMessage) ||
    lowerMessage.includes('server had an error') ||
    lowerMessage.includes('server_error') ||
    lowerMessage.includes('unable to process')
  ) {
    return { statusCode, retryAfterMs, isTransient: true, category: 'server-error', message };
  }
  if (
    lowerMessage.includes('canceled') ||
    lowerMessage.includes('cancelled') ||
    lowerMessage.includes('stream ended') ||
    lowerMessage.includes('premature close') ||
    lowerMessage.includes('connection closed') ||
    lowerMessage.includes('incomplete chunked')
  ) {
    return { statusCode, retryAfterMs, isTransient: true, category: 'network', message };
  }

  // Default: not transient
  return { statusCode, retryAfterMs, isTransient: false, category: 'unknown', message };
}

/**
 * Whether an error should be retried on the SAME model. Transient errors are,
 * EXCEPT quota (402): retrying a depleted account can't succeed and — with a
 * Retry-After header — could sleep for hours. Quota is still `isTransient` so it
 * remains eligible for model FALLBACK; only same-model retry loops use this.
 */
export function isSameModelRetryable(info: RetryableErrorInfo): boolean {
  return info.isTransient && info.category !== 'quota';
}

/**
 * Whether an error is a context-window overflow — the request's input exceeded
 * the model's context length. Not retryable as-is (same input, same result), but
 * RECOVERABLE by compacting/shrinking the history first. The stream loop uses
 * this to attempt one compact-and-retry before surfacing a `/compact` hint,
 * instead of hard-failing the turn like any other non-transient client error.
 */
export function isContextOverflowError(error: unknown): boolean {
  return classifyError(error).category === 'context-overflow';
}

/** Calculate delay for a given attempt using exponential backoff with jitter. */
export function calculateDelay(
  attempt: number,
  errorInfo: RetryableErrorInfo,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  // If the server specified a Retry-After, respect it (capped)
  if (errorInfo.retryAfterMs && errorInfo.retryAfterMs > 0) {
    return Math.min(errorInfo.retryAfterMs, RETRY_AFTER_CAP_MS);
  }

  // Exponential backoff: base * 2^attempt + jitter
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponential + jitter, maxDelayMs);
}

/**
 * Execute an async function with retry logic.
 *
 * Only retries on transient errors (rate limits, server errors, network issues).
 * Non-transient errors (auth, client errors) are thrown immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const maxRetriesRaw = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayRaw = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayRaw = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  // Guard against NaN / negative option values: a NaN maxRetries would make the
  // loop never run (and throw undefined); a NaN delay would produce a broken timer.
  const maxRetries =
    Number.isFinite(maxRetriesRaw) && maxRetriesRaw >= 0 ? Math.floor(maxRetriesRaw) : DEFAULT_MAX_RETRIES;
  const baseDelayMs = Number.isFinite(baseDelayRaw) && baseDelayRaw >= 0 ? baseDelayRaw : DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = Number.isFinite(maxDelayRaw) && maxDelayRaw >= 0 ? maxDelayRaw : DEFAULT_MAX_DELAY_MS;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Abort BEFORE each attempt: if abort fired during the previous sleep (or
    // between the timer resolving and here), don't fire another fn() call.
    if (options?.abortSignal?.aborted) {
      throw lastError ?? new Error('Aborted');
    }
    try {
      return await fn();
    } catch (error) {
      if (options?.abortSignal?.aborted) throw error;

      lastError = error;
      const errorInfo = classifyError(error);

      // Don't retry non-transient errors, or quota (402) — retrying the same
      // model can't clear a billing/quota problem (only fallback can).
      if (!isSameModelRetryable(errorInfo)) throw error;

      // Don't retry if we've exhausted attempts
      if (attempt >= maxRetries) throw error;

      const delay = calculateDelay(attempt, errorInfo, baseDelayMs, maxDelayMs);

      options?.onRetry?.({
        attempt: attempt + 1,
        delay,
        reason: errorInfo.message,
        category: errorInfo.category,
      });

      await sleepWithAbort(delay, options?.abortSignal);
    }
  }

  throw lastError;
}

/**
 * Check if an error from a streaming response is retryable,
 * and whether no output has been emitted yet (safe to retry the full request).
 */
export function isRetryableStreamError(error: unknown, emittedContent: boolean): boolean {
  if (emittedContent) return false;
  return classifyError(error).isTransient;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    if (typeof e.message === 'string') return e.message;
    const data = e.data as Record<string, unknown> | undefined;
    if (typeof data?.message === 'string') return data.message;
    if (typeof e.responseBody === 'string' && e.responseBody.length > 0) return e.responseBody;
  }
  return String(error);
}

function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as Record<string, unknown>;
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  // Anthropic SDK uses 'status' on the error object
  const response = e.response as Record<string, unknown> | undefined;
  if (typeof response?.status === 'number') return response.status;
  return undefined;
}

function extractRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as Record<string, unknown>;

  // Headers may be a plain object OR a Fetch `Headers` instance (which the AI
  // SDK / undici expose). Read via .get() when available, else index the object.
  const rawHeaders = (e.headers ?? e.responseHeaders) as unknown;
  let retryAfter: string | undefined;
  if (rawHeaders && typeof (rawHeaders as { get?: unknown }).get === 'function') {
    const h = rawHeaders as { get: (name: string) => string | null };
    retryAfter = h.get('retry-after') ?? undefined;
  } else if (rawHeaders && typeof rawHeaders === 'object') {
    const h = rawHeaders as Record<string, string | undefined>;
    retryAfter = h['retry-after'] ?? h['Retry-After'];
  }

  if (!retryAfter) return undefined;

  // Retry-After can be seconds (number) or HTTP-date
  const seconds = Number(retryAfter);
  if (!isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  // Try parsing as HTTP-date
  const date = new Date(retryAfter);
  if (!isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }

  return undefined;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    let onAbort: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

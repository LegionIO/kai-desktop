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
  category: 'rate-limit' | 'overload' | 'server-error' | 'timeout' | 'network' | 'auth' | 'client-error' | 'unknown';
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

  // Auth errors — not transient
  if (statusCode === 401 || statusCode === 403) {
    return { statusCode, retryAfterMs, isTransient: false, category: 'auth', message };
  }

  // Client errors (4xx except rate limits) — not transient
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
    return { statusCode, retryAfterMs, isTransient: false, category: 'client-error', message };
  }

  // Rate limit (429)
  if (statusCode === 429) {
    return { statusCode, retryAfterMs, isTransient: true, category: 'rate-limit', message };
  }

  // Overload (529 — Anthropic-specific)
  if (statusCode === 529) {
    return { statusCode, retryAfterMs, isTransient: true, category: 'overload', message };
  }

  // Server errors (5xx)
  if (statusCode !== undefined && statusCode >= 500) {
    return { statusCode, retryAfterMs, isTransient: true, category: 'server-error', message };
  }

  // Timeout (408)
  if (statusCode === 408) {
    return { statusCode, retryAfterMs, isTransient: true, category: 'timeout', message };
  }

  // Network errors (no status code, but connection-related keywords)
  const lowerMessage = message.toLowerCase();
  if (
    lowerMessage.includes('econnreset') ||
    lowerMessage.includes('econnrefused') ||
    lowerMessage.includes('etimedout') ||
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

  // Default: not transient
  return { statusCode, retryAfterMs, isTransient: false, category: 'unknown', message };
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
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (options?.abortSignal?.aborted) throw error;

      lastError = error;
      const errorInfo = classifyError(error);

      // Don't retry non-transient errors
      if (!errorInfo.isTransient) throw error;

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

  // Check headers for Retry-After
  const headers = (e.headers ?? e.responseHeaders) as Record<string, string | undefined> | undefined;
  const retryAfter = headers?.['retry-after'] ?? headers?.['Retry-After'];

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

    const timer = setTimeout(resolve, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

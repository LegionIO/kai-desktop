import { createHmac, randomBytes } from 'node:crypto';
import type { BrowserLoadTiming, BrowserNetworkEntry } from '../../shared/browser.js';

export const MAX_BROWSER_NETWORK_REQUESTS_PER_TAB = 500;
/** Keep exact request identities for every admitted request. Diagnostic history
 * is intentionally much smaller, but active requests may not be evicted: a
 * terminal event must always be able to complete the exact request it names. */
export const MAX_BROWSER_ACTIVE_NETWORK_REQUESTS_PER_TAB = 4_096;
export const MAX_BROWSER_NETWORK_DIAGNOSTIC_RESULTS = 100;

const NETWORK_RESOURCE_TYPES = new Set([
  'mainFrame',
  'subFrame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xhr',
  'ping',
  'cspReport',
  'media',
  'webSocket',
  'other',
]);
const NAVIGATION_TYPES = new Set(['navigate', 'reload', 'back_forward', 'prerender']);
const NETWORK_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH']);
const MAX_NETWORK_ERROR_CHARS = 512;
const CANONICAL_REDACTED_NETWORK_URL = /^\[redacted (?:https?|wss?) origin [a-f0-9]{16}\](?:\/\[redacted-path\])?$/;

export type BrowserNetworkRedactionKey = Uint8Array;

/** Origin correlation is intentionally document-local. A process-global token
 * would let the model compare a redacted authenticated origin with candidate
 * origins opened in other tabs or later documents. */
export function createBrowserNetworkRedactionKey(): BrowserNetworkRedactionKey {
  return randomBytes(32);
}

export type TrackedBrowserNetworkRequest = {
  id: number;
  sequence: number;
  url: string;
  urlRedacted?: boolean;
  method: string;
  resourceType: string;
  startedAt: number;
  responseStartedAt?: number;
  completedAt?: number;
  statusCode?: number;
  fromCache?: boolean;
  responseBytes?: number;
  error?: string;
};

function boundedNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 100) / 100;
}

export function sanitizeBrowserNetworkUrl(
  value: string,
  redactionKey: BrowserNetworkRedactionKey,
): { url: string; redacted: boolean } {
  if (CANONICAL_REDACTED_NETWORK_URL.test(value)) return { url: value, redacted: true };
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
      return { url: '[redacted non-web URL]', redacted: true };
    }
    // Host labels and path segments can both carry password-reset codes,
    // account identifiers, signed-resource tokens, or page-selected secrets.
    // Correlate requests only inside the current tab document instead of
    // returning either attacker-controlled location component to the model.
    const hasPath = parsed.pathname !== '' && parsed.pathname !== '/';
    const scheme = parsed.protocol.slice(0, -1);
    const originToken = createHmac('sha256', redactionKey).update(parsed.origin).digest('hex').slice(0, 16);
    return { url: `[redacted ${scheme} origin ${originToken}]${hasPath ? '/[redacted-path]' : ''}`, redacted: true };
  } catch {
    return { url: '[redacted invalid network URL]', redacted: true };
  }
}

export function browserNetworkPageIdentity(value: string, redactionKey: BrowserNetworkRedactionKey): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'about:blank';
    return sanitizeBrowserNetworkUrl(parsed.origin, redactionKey).url;
  } catch {
    return 'about:blank';
  }
}

export function sanitizeBrowserNetworkError(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  const safe = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  if (!safe) return undefined;
  if (safe === 'net::OK') return undefined;
  // Chromium network codes are useful and carry no page-selected data. Do not
  // return the surrounding message: it may include a secret-bearing hostname
  // even when the URL has no path or query to trigger generic URL redaction.
  // Electron's webRequest failure value starts with one structured `net::ERR_`
  // token. Never search the rest of the string: URLs and page-selected error
  // text can contain attacker-chosen ERR_* substrings.
  const code = /^(?:Error:\s+)?(net::ERR_[A-Z0-9_]{1,64})(?=$|\s)/.exec(safe)?.[1];
  return (code ?? 'Network request failed.').slice(0, MAX_NETWORK_ERROR_CHARS);
}

export function responseContentLength(headers: Record<string, string[]> | undefined): number | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-length');
  const raw = entry?.[1]?.[0];
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function normalizeBrowserLoadTiming(value: unknown): BrowserLoadTiming {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const timing: BrowserLoadTiming = {};
  timing.navigationType =
    typeof record.navigationType === 'string' && NAVIGATION_TYPES.has(record.navigationType)
      ? (record.navigationType as Exclude<BrowserLoadTiming['navigationType'], 'unknown'>)
      : 'unknown';
  const fields: Array<[keyof BrowserLoadTiming, string]> = [
    ['timeToFirstByteMs', 'timeToFirstByteMs'],
    ['responseEndMs', 'responseEndMs'],
    ['domContentLoadedMs', 'domContentLoadedMs'],
    ['loadEventMs', 'loadEventMs'],
    ['durationMs', 'durationMs'],
    ['firstContentfulPaintMs', 'firstContentfulPaintMs'],
    ['transferSizeBytes', 'transferSizeBytes'],
    ['encodedBodySizeBytes', 'encodedBodySizeBytes'],
    ['decodedBodySizeBytes', 'decodedBodySizeBytes'],
  ];
  for (const [output, input] of fields) {
    const bounded = boundedNonNegativeNumber(record[input]);
    if (bounded !== undefined) Object.assign(timing, { [output]: bounded });
  }
  return timing;
}

/** Build load timing only from Electron main-process webRequest events. Remote
 * pages can replace `performance`, its methods, and returned entry objects, so
 * diagnostics must never execute page JavaScript merely to collect timing. */
export function browserLoadTimingFromNetworkRequests(
  tracked: Iterable<TrackedBrowserNetworkRequest>,
): BrowserLoadTiming {
  const navigation = [...tracked]
    .filter((request) => request.resourceType === 'mainFrame')
    .sort((left, right) => right.sequence - left.sequence)[0];
  if (!navigation) return {};
  return normalizeBrowserLoadTiming({
    navigationType: 'unknown',
    ...(navigation.responseStartedAt !== undefined
      ? { timeToFirstByteMs: navigation.responseStartedAt - navigation.startedAt }
      : {}),
    ...(navigation.completedAt !== undefined
      ? {
          responseEndMs: navigation.completedAt - navigation.startedAt,
          durationMs: navigation.completedAt - navigation.startedAt,
        }
      : {}),
  });
}

export function boundedNetworkMethod(value: string): string {
  const normalized = value.toUpperCase();
  // Request methods are page-controlled. Returning arbitrary alphabetic
  // methods would give a page a covert channel around URL/header redaction.
  return NETWORK_METHODS.has(normalized) ? normalized : 'OTHER';
}

export function boundedNetworkResourceType(value: string): string {
  return NETWORK_RESOURCE_TYPES.has(value) ? value : 'other';
}

export function snapshotBrowserNetworkRequests(
  tracked: Iterable<TrackedBrowserNetworkRequest>,
  limit: number,
  redactionKey: BrowserNetworkRedactionKey,
  currentTime = Date.now(),
): { entries: BrowserNetworkEntry[]; requestCount: number; inFlight: number; truncated: boolean } {
  const requests = [...tracked].sort((left, right) => right.sequence - left.sequence);
  const boundedLimit = Math.max(1, Math.min(MAX_BROWSER_NETWORK_DIAGNOSTIC_RESULTS, Math.floor(limit)));
  const entries = requests.slice(0, boundedLimit).map((request): BrowserNetworkEntry => {
    const sanitized = sanitizeBrowserNetworkUrl(request.url, redactionKey);
    const end = request.completedAt ?? currentTime;
    return {
      sequence: request.sequence,
      url: sanitized.url,
      urlRedacted: request.urlRedacted === true || sanitized.redacted,
      method: boundedNetworkMethod(request.method),
      resourceType: boundedNetworkResourceType(request.resourceType),
      ...(request.statusCode !== undefined ? { statusCode: request.statusCode } : {}),
      ...(request.fromCache !== undefined ? { fromCache: request.fromCache } : {}),
      ...(request.responseBytes !== undefined ? { responseBytes: request.responseBytes } : {}),
      ...(sanitizeBrowserNetworkError(request.error) ? { error: sanitizeBrowserNetworkError(request.error) } : {}),
      durationMs: Math.max(0, Math.round((end - request.startedAt) * 100) / 100),
      pending: request.completedAt === undefined,
    };
  });
  return {
    entries,
    requestCount: requests.length,
    inFlight: requests.filter((request) => request.completedAt === undefined).length,
    truncated: requests.length > entries.length,
  };
}

export function blocksBrowserNetworkIdle(request: TrackedBrowserNetworkRequest): boolean {
  return request.completedAt === undefined && browserNetworkResourceBlocksIdle(request.resourceType);
}

export function browserNetworkResourceBlocksIdle(resourceType: string): boolean {
  return resourceType !== 'webSocket' && resourceType !== 'media';
}

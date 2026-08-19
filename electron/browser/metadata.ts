export const MAX_BROWSER_TITLE_CHARS = 1_024;
export const MAX_BROWSER_URL_CHARS = 32 * 1_024;

function bounded(value: string, limit: number, fallback: string): string {
  const resolved = value || fallback;
  return resolved.length <= limit ? resolved : resolved.slice(0, limit);
}

/** Bound renderer-controlled metadata before it crosses IPC or reaches disk. */
export function boundedBrowserTitle(value: string, fallback = 'New Tab'): string {
  return bounded(value, MAX_BROWSER_TITLE_CHARS, fallback);
}

export function boundedBrowserUrl(value: string, fallback = 'about:blank'): string {
  return bounded(value, MAX_BROWSER_URL_CHARS, fallback);
}

const ALLOWED_NAVIGATE_SCHEMES = new Set(['http:', 'https:', 'about:']);

/**
 * Returns the URL only when it parses with an allow-listed scheme. Used by
 * computer-use `navigate` actions so model-supplied URLs cannot launch
 * arbitrary OS protocol handlers (file:, ms-settings:, javascript:, custom
 * app schemes, …).
 */
export function safeNavigateUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Bare host like `example.com` or `example.com/path` — assume https.
    if (/^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(?:[/?#].*)?$/.test(trimmed)) {
      try {
        parsed = new URL(`https://${trimmed}`);
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }
  return ALLOWED_NAVIGATE_SCHEMES.has(parsed.protocol) ? parsed.toString() : null;
}

/**
 * Provider hostnames blocked by the test-time HTTP egress firewall.
 *
 * Extracted from vitest.setup.ts so the same list is consumed by both the
 * `globalThis.fetch` wrapper and the `vi.mock('undici', …)` guard — defence
 * in depth against tests that pull `undici` directly and bypass the global
 * fetch.
 *
 * When adding a provider:
 *   1. Add the canonical hostname (string or regex) to BLOCKED_HOSTS.
 *   2. If the provider has per-tenant or regional subdomains, prefer a
 *      regex anchored on the apex (e.g. `\.googleapis\.com$`).
 *   3. Update `setup/msw.ts` so per-suite handlers exist for the new host.
 */

export const BLOCKED_HOSTS: ReadonlyArray<string | RegExp> = [
  // Anthropic
  'api.anthropic.com',
  // OpenAI
  'api.openai.com',
  // Google (Gemini + Vertex AI). Vertex regional endpoints use the
  // `<region>-aiplatform.googleapis.com` form (dash separator), so the regex
  // anchors on `[.-]aiplatform.googleapis.com$` to catch both regional and
  // the global `aiplatform.googleapis.com`.
  'generativelanguage.googleapis.com',
  /(?:^|[.-])aiplatform\.googleapis\.com$/,
  // Mistral
  'api.mistral.ai',
  // Cohere
  'api.cohere.ai',
  'api.cohere.com',
  // AWS Bedrock — any region, including `fips.` and other subdomain variants
  /^bedrock(-runtime)?\..+\.amazonaws\.com$/,
  // Azure OpenAI per-tenant
  /^[^.]+\.openai\.azure\.com$/,
];

/** Marker used by tests + the install self-test to identify firewall errors. */
export const HTTP_FIREWALL_ERROR_CODE = 'ECONNREFUSED';

/** Stamped on `globalThis.fetch` after the firewall installs so a future
 *  setup file (e.g. `setup-real-api.ts`) can assert the firewall was active
 *  before restoring. */
export const HTTP_FIREWALL_INSTALLED_SYMBOL = Symbol.for('kai.test.firewall.installed');

export function isBlockedHostname(hostname: string): boolean {
  return BLOCKED_HOSTS.some((pattern) => (typeof pattern === 'string' ? hostname === pattern : pattern.test(hostname)));
}

export function extractHostname(input: unknown): string | null {
  try {
    if (typeof input === 'string') return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (input && typeof input === 'object' && 'url' in (input as Record<string, unknown>)) {
      const raw = (input as { url: unknown }).url;
      if (typeof raw === 'string') return new URL(raw).hostname;
    }
    return null;
  } catch {
    return null;
  }
}

export function makeFirewallError(hostname: string, source = 'fetch'): Error & { code: string } {
  const err = new Error(
    `HTTP egress firewall (${source}): real provider request blocked for ${hostname}. ` +
      `Install msw handlers or add the hostname to the allowlist. ` +
      `(See test-utils/blocked-hosts.ts BLOCKED_HOSTS.)`,
  ) as Error & { code: string };
  err.code = HTTP_FIREWALL_ERROR_CODE;
  return err;
}

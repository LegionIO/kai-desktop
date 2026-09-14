/**
 * Provider model discovery — ask a configured provider which models it actually serves,
 * so the user doesn't hand-type 40+ catalog entries.
 *
 * Every supported provider exposes a list endpoint that is shaped either like OpenAI's
 * `GET /v1/models` (`{ data: [{ id }] }`) or Google's `models` list
 * (`{ models: [{ name }] }`). Anthropic and xAI both implement the OpenAI shape, so the
 * parsing collapses into those two cases.
 *
 * All network access goes through `safeFetch` so the SSRF guard (scheme checks +
 * private-IP rejection re-run on every redirect hop) applies — a provider `endpoint` is
 * user-supplied and could otherwise be pointed at internal infrastructure. Responses are
 * read through `readCappedText` so a hostile/huge body can't OOM the main process.
 */
import { isIP } from 'node:net';
import { safeFetch, readCappedText, isPrivateAddress } from '../utils/ssrf-guard.js';

/** Model lists are small JSON documents; 4 MiB is generous and bounds memory. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/**
 * Whether the configured endpoint is itself an explicit private/loopback IP literal.
 *
 * Local inference servers are a first-class case here — Ollama on `localhost:11434`, an
 * on-prem sidecar on `127.0.0.1` — and `safeFetch` rejects private targets by default. We
 * relax the guard ONLY when the operator's own configured host is already private, so:
 *   - a local provider can be enumerated, but
 *   - a PUBLIC endpoint still cannot redirect into the private network / cloud metadata
 *     service (the actual SSRF risk), because for those we keep the guard fully on.
 *
 * Deliberately IP-literal + `localhost` only: a hostname that merely RESOLVES to a private
 * address keeps the guard on, so DNS-rebinding through a public name isn't silently
 * whitelisted here.
 */
export function endpointIsExplicitlyLocal(rawBase: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawBase.trim());
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const family = isIP(host);
  if (family === 0) return false;
  return isPrivateAddress(host, family as 4 | 6);
}

export type DiscoveredModel = {
  /** Provider-native model id, e.g. `gpt-4o` / `claude-sonnet-4-20250514`. */
  id: string;
  /** Present only when the provider reports one. */
  displayName?: string;
  /** Present only when the provider reports a context window we can trust. */
  maxInputTokens?: number;
};

export type DiscoverResult = { ok: true; models: DiscoveredModel[] } | { ok: false; error: string };

type ProviderLike = {
  type: string;
  endpoint?: string;
  apiKey?: string;
  apiVersion?: string;
};

/** Default list endpoints per provider type, used when no custom endpoint is set. */
const DEFAULT_ENDPOINTS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
};

/**
 * Join a provider base URL with the list path, tolerating the several ways users write
 * endpoints: with/without a trailing slash, and with or without `/v1` already included
 * (a very common paste). Returns an absolute URL string.
 */
export function buildListUrl(rawBase: string, path: string): string {
  const base = rawBase.trim().replace(/\/+$/, '');
  const suffix = path.replace(/^\/+/, '');
  // If the base already ends in the API version segment the path starts with, don't
  // duplicate it (`https://x/v1` + `v1/models` must not become `https://x/v1/v1/models`).
  const versionMatch = suffix.match(/^(v\d+(?:beta)?)\//);
  if (versionMatch && new RegExp(`/${versionMatch[1]}$`).test(base)) {
    return `${base}/${suffix.slice(versionMatch[1].length + 1)}`;
  }
  return `${base}/${suffix}`;
}

/**
 * Parse either supported list shape into a normalized model array.
 * Unknown/extra fields are ignored; entries without a usable id are dropped.
 */
export function parseModelList(body: unknown): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();

  const push = (id: unknown, displayName?: unknown, ctx?: unknown) => {
    if (typeof id !== 'string') return;
    // Google returns fully-qualified resource names (`models/gemini-2.0-flash`); the
    // model id used in requests is the last segment.
    const clean = id.startsWith('models/') ? id.slice('models/'.length) : id;
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    const entry: DiscoveredModel = { id: clean };
    if (typeof displayName === 'string' && displayName.trim()) entry.displayName = displayName.trim();
    if (typeof ctx === 'number' && Number.isFinite(ctx) && ctx > 0) entry.maxInputTokens = Math.floor(ctx);
    out.push(entry);
  };

  const root = body as Record<string, unknown> | null;
  if (!root || typeof root !== 'object') return out;

  // OpenAI / Anthropic / xAI / most OpenAI-compatible gateways: { data: [{ id }] }
  if (Array.isArray(root.data)) {
    for (const item of root.data) {
      const m = item as Record<string, unknown>;
      push(m?.id, m?.display_name ?? m?.name, m?.context_length ?? m?.context_window);
    }
    return out;
  }

  // Google Generative Language: { models: [{ name, displayName, inputTokenLimit }] }
  if (Array.isArray(root.models)) {
    for (const item of root.models) {
      const m = item as Record<string, unknown>;
      push(m?.name ?? m?.id, m?.displayName, m?.inputTokenLimit);
    }
    return out;
  }

  return out;
}

/**
 * Build the request (url + headers) for a provider's model-list endpoint.
 * Returns null when the provider type has no discoverable HTTP list endpoint.
 */
export function buildDiscoveryRequest(
  provider: ProviderLike,
): { url: string; headers: Record<string, string>; base: string } | { error: string } | null {
  const type = provider.type;
  const key = provider.apiKey?.trim() ?? '';
  const base = provider.endpoint?.trim() || DEFAULT_ENDPOINTS[type] || '';

  if (type === 'amazon-bedrock') {
    // Bedrock lists models over the AWS control plane with SigV4 signing, not a bearer
    // token against a base URL. Out of scope for this path.
    return null;
  }

  if (!base) return { error: 'No endpoint configured for this provider.' };

  if (type === 'anthropic') {
    if (!key) return { error: 'An API key is required to list Anthropic models.' };
    return {
      url: buildListUrl(base, 'v1/models'),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', accept: 'application/json' },
      base,
    };
  }

  if (type === 'google') {
    if (!key) return { error: 'An API key is required to list Google models.' };
    // Google takes the key as a query param rather than a bearer header.
    const url = new URL(buildListUrl(base, 'v1beta/models'));
    url.searchParams.set('key', key);
    return { url: url.toString(), headers: { accept: 'application/json' }, base };
  }

  // openai-compatible: OpenAI, xAI, Ollama, Azure-style gateways, on-prem proxies.
  const headers: Record<string, string> = { accept: 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  let url = buildListUrl(base, 'v1/models');
  if (provider.apiVersion?.trim()) {
    // Azure-style deployments require the api-version query parameter.
    const withVersion = new URL(url);
    withVersion.searchParams.set('api-version', provider.apiVersion.trim());
    url = withVersion.toString();
  }
  return { url, headers, base };
}

/** Fetch and normalize the model list for one configured provider. */
export async function discoverProviderModels(provider: ProviderLike): Promise<DiscoverResult> {
  const req = buildDiscoveryRequest(provider);
  if (req === null) {
    return { ok: false, error: 'Model discovery is not supported for this provider type.' };
  }
  if ('error' in req) return { ok: false, error: req.error };

  try {
    const resp = await safeFetch(req.url, {
      headers: req.headers,
      timeoutMs: TIMEOUT_MS,
      // Only for an explicitly-local configured endpoint (see endpointIsExplicitlyLocal):
      // lets a localhost/on-prem inference server be enumerated while keeping the full
      // SSRF guard — including redirect-hop re-checks — for every public endpoint.
      allowPrivate: endpointIsExplicitlyLocal(req.base),
    });
    const text = await readCappedText(resp, MAX_BODY_BYTES);
    if (!resp.ok) {
      // Surface the provider's own message (truncated) — "401 invalid key" is far more
      // actionable than a generic failure, and this is an operator-facing settings flow.
      const detail = text.trim().slice(0, 300);
      return { ok: false, error: `HTTP ${resp.status}${detail ? `: ${detail}` : ''}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: 'Provider did not return JSON. Check the endpoint URL.' };
    }
    const models = parseModelList(parsed);
    if (models.length === 0) {
      return { ok: false, error: 'Provider returned no models in a recognized format.' };
    }
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

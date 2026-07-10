/**
 * Shared SSRF-safe fetch guard.
 *
 * Extracted from tools/web-fetch.ts so every main-process outbound fetch that
 * takes a caller-supplied URL (web_fetch tool, image:fetch/save handlers, …)
 * uses ONE hardened path: scheme allowlist + private/loopback/link-local IP
 * rejection (DNS-rebinding-safe via a connect-time lookup hook) + manual
 * redirect following with re-validation on every hop + a response byte cap.
 */
import { lookup as dnsLookup } from 'dns';
import type { LookupAddress } from 'dns';
import { BlockList, isIP } from 'net';
import type { LookupFunction } from 'net';
import { Agent, fetch as undiciFetch } from 'undici';

export const MAX_REDIRECTS = 5;

// Private / local address ranges. net.BlockList gives canonical IP parsing, so
// alternate textual forms (`0:0:0:0:0:0:0:1`, `::ffff:7f00:1`, …) are matched.
// IPv4 and IPv6 ranges are kept in SEPARATE BlockLists: a combined list makes
// `check(v4, 'ipv4')` also match the `::ffff:0:0/96` mapped range (BlockList
// treats a v4 as its v6-mapped form), which would wrongly reject EVERY public
// IPv4. The v4-mapped range therefore lives only in the ipv6 list.
const PRIVATE_V4 = new BlockList();
PRIVATE_V4.addSubnet('0.0.0.0', 8, 'ipv4');
PRIVATE_V4.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_V4.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE_V4.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE_V4.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_V4.addSubnet('192.168.0.0', 16, 'ipv4');

const PRIVATE_V6 = new BlockList();
PRIVATE_V6.addAddress('::', 'ipv6'); // unspecified
PRIVATE_V6.addAddress('::1', 'ipv6'); // loopback
PRIVATE_V6.addSubnet('fc00::', 7, 'ipv6'); // unique-local
PRIVATE_V6.addSubnet('fe80::', 10, 'ipv6'); // link-local
// IPv4-mapped IPv6 (::ffff:0:0/96) — blocked wholesale so a mapped form can't
// smuggle a private v4 past the check. (A stricter check would extract + re-test
// the embedded v4, but since we already block v4 mapped addresses entirely,
// rejecting the whole mapped range is safe: no legitimate outbound uses it.)
PRIVATE_V6.addSubnet('::ffff:0:0', 96, 'ipv6');

export function isPrivateAddress(addr: string, family: 4 | 6): boolean {
  return family === 6 ? PRIVATE_V6.check(addr, 'ipv6') : PRIVATE_V4.check(addr, 'ipv4');
}

/**
 * undici dispatcher whose socket-level DNS lookup rejects any resolution that
 * lands on a private/local address. The hook runs for the ACTUAL connection
 * (and every redirect hop), so the checked address is the dialled address —
 * closing the DNS-rebinding TOCTOU window.
 */
function buildGuardedDispatcher(): Agent {
  const guardedLookup = (
    hostname: string,
    opts: Parameters<LookupFunction>[1],
    cb: (err: NodeJS.ErrnoException | null, addrs?: LookupAddress[]) => void,
  ): void => {
    dnsLookup(hostname, { all: true, ...opts }, (err, addrs) => {
      if (err) return cb(err);
      for (const a of addrs as LookupAddress[]) {
        if (isPrivateAddress(a.address, a.family as 4 | 6)) {
          return cb(new Error(`Refusing to connect to private/local address ${a.address} for ${hostname}`));
        }
      }
      cb(null, addrs as LookupAddress[]);
    });
  };
  return new Agent({ connect: { lookup: guardedLookup as unknown as LookupFunction } });
}

export const guardedDispatcher = buildGuardedDispatcher();

/**
 * Validate a URL: parses, uses an allowed scheme, and — when private networks
 * are blocked — an IP-literal hostname is not private. Hostname resolution is
 * range-enforced at connect time by {@link guardedDispatcher}, but IP literals
 * bypass DNS lookup so they must be pre-checked here. Called on every hop.
 *
 * @param extraProtocols additional allowed protocols WITHOUT the trailing ':'
 *   (e.g. a brand media protocol). http/https are always allowed.
 */
export function isUrlAllowed(
  url: string,
  allowPrivate: boolean,
  extraProtocols: readonly string[] = [],
): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `Invalid URL: ${url}` };
  }
  const scheme = parsed.protocol.replace(/:$/, '');
  if (scheme !== 'http' && scheme !== 'https' && !extraProtocols.includes(scheme)) {
    return { ok: false, reason: `Disallowed URL scheme: ${parsed.protocol}` };
  }
  // Only http(s) hit the network + need the IP check; extra (e.g. media:) schemes
  // are handled by their own protocol handler, not this fetch path.
  if (!allowPrivate && (scheme === 'http' || scheme === 'https')) {
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const family = isIP(host);
    if (family !== 0 && isPrivateAddress(host, family as 4 | 6)) {
      return { ok: false, reason: `Fetching private/local network addresses is disabled: ${host}` };
    }
  }
  return { ok: true };
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  allowPrivate?: boolean;
  extraProtocols?: readonly string[];
}

/**
 * Fetch a caller-supplied URL with the full SSRF guard: scheme + IP-literal
 * checks re-run on every redirect hop, connect-time private-IP rejection, and
 * manual redirect following capped at MAX_REDIRECTS. Returns the final Response
 * (body not yet consumed — cap it with {@link readCappedArrayBuffer}).
 *
 * Throws on a disallowed URL / too many redirects / a blocked address.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const { headers, timeoutMs = 30000, allowPrivate = false, extraProtocols = [] } = opts;
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = isUrlAllowed(currentUrl, allowPrivate, extraProtocols);
    if (!check.ok) throw new Error(check.reason);

    const resp = (await undiciFetch(currentUrl, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
      ...(allowPrivate ? {} : { dispatcher: guardedDispatcher }),
    })) as unknown as Response;

    if (resp.status >= 301 && resp.status <= 308 && resp.status !== 304) {
      const location = resp.headers.get('location');
      if (!location) throw new Error(`HTTP ${resp.status} redirect missing Location header`);
      if (hop === MAX_REDIRECTS) throw new Error(`Too many redirects (> ${MAX_REDIRECTS})`);
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return resp;
  }
  throw new Error('Fetch failed: redirect loop');
}

/**
 * Read a Response body into a Buffer, rejecting an over-cap Content-Length up
 * front and aborting the stream once actual bytes exceed maxBytes — so a huge
 * or endless response can't OOM the main process.
 */
export async function readCappedArrayBuffer(resp: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(resp.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Response too large: Content-Length ${declared} exceeds ${maxBytes}`);
  }
  if (!resp.body) return Buffer.from(await resp.arrayBuffer());
  const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > maxBytes) {
        void reader.cancel();
        throw new Error(`Response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

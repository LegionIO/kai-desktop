import { z } from 'zod';
import { lookup as dnsLookup } from 'dns';
import type { LookupAddress } from 'dns';
import { BlockList, isIP } from 'net';
import type { LookupFunction } from 'net';
// Use undici's own fetch so the Agent dispatcher is compatible — Node's
// global fetch uses the bundled undici, which may be a different version
// than the npm package and rejects external dispatchers.
import { Agent, fetch as undiciFetch } from 'undici';
import sanitizeHtml from 'sanitize-html';
import type { ToolDefinition } from './types.js';
import type { AppConfig } from '../config/schema.js';
import { withBrandUserAgent } from '../utils/user-agent.js';

const MAX_REDIRECTS = 5;

// Private / local address ranges. Using net.BlockList gives us canonical
// IP parsing, so alternate textual forms (e.g. `0:0:0:0:0:0:0:1`, `0000::1`,
// `::ffff:7f00:1`) are matched correctly without ad-hoc string comparisons.
const PRIVATE_RANGES = new BlockList();
// IPv4
PRIVATE_RANGES.addSubnet('0.0.0.0', 8, 'ipv4');
PRIVATE_RANGES.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_RANGES.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE_RANGES.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE_RANGES.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_RANGES.addSubnet('192.168.0.0', 16, 'ipv4');
// IPv6
PRIVATE_RANGES.addAddress('::', 'ipv6'); // unspecified
PRIVATE_RANGES.addAddress('::1', 'ipv6'); // loopback
PRIVATE_RANGES.addSubnet('fc00::', 7, 'ipv6'); // unique-local
PRIVATE_RANGES.addSubnet('fe80::', 10, 'ipv6'); // link-local
// IPv4-mapped IPv6 (::ffff:0:0/96). The entire range is blocked so that a
// v4-mapped form can never be used to smuggle a private v4 past the check;
// the embedded v4 is effectively re-checked because every mapped address
// falls inside this subnet.
PRIVATE_RANGES.addSubnet('::ffff:0:0', 96, 'ipv6');

function isPrivateAddress(addr: string, family: 4 | 6): boolean {
  return PRIVATE_RANGES.check(addr, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * An undici dispatcher whose socket-level DNS lookup rejects any resolution
 * that lands on a private/local address. Because the lookup hook runs for the
 * *actual* connection (and for every redirect hop), the address that is
 * checked is the same address that is dialled — closing the DNS-rebinding
 * TOCTOU window that exists when resolution is done separately from fetch().
 */
function buildGuardedDispatcher(): Agent {
  // Node's `net.LookupFunction` type declares the single-result callback
  // signature, but undici invokes it with `{ all: true }` and consumes a
  // LookupAddress[] result — hence the cast on assignment.
  const guardedLookup = (
    hostname: string,
    opts: Parameters<LookupFunction>[1],
    cb: (err: NodeJS.ErrnoException | null, addrs?: LookupAddress[]) => void,
  ): void => {
    dnsLookup(hostname, { all: true, ...opts }, (err, addrs) => {
      if (err) return cb(err);
      for (const a of addrs as LookupAddress[]) {
        if (isPrivateAddress(a.address, a.family as 4 | 6)) {
          return cb(
            new Error(
              `Refusing to connect to private/local address ${a.address} for ${hostname}`,
            ),
          );
        }
      }
      cb(null, addrs as LookupAddress[]);
    });
  };

  return new Agent({ connect: { lookup: guardedLookup as unknown as LookupFunction } });
}

const guardedDispatcher = buildGuardedDispatcher();

/**
 * Validate that a URL parses and uses http(s), and — when private networks
 * are blocked — that an IP-literal hostname is not in a private range. The
 * hostname-resolution guard happens separately at connect time via
 * {@link guardedDispatcher} (which closes the DNS-rebinding TOCTOU), but
 * IP literals can bypass DNS lookup entirely so they must be pre-checked
 * here. Called on every redirect hop.
 */
function isUrlAllowed(
  url: string,
  allowPrivate: boolean,
): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `Invalid URL: ${url}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Only http(s) URLs are allowed (got ${parsed.protocol})` };
  }
  if (!allowPrivate) {
    // URL.hostname keeps surrounding brackets for IPv6 literals; strip them
    // so net.isIP recognises the address.
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const family = isIP(host);
    if (family !== 0 && isPrivateAddress(host, family as 4 | 6)) {
      return {
        ok: false,
        reason: `Fetching private/local network addresses is disabled (set tools.webFetch.allowPrivateNetworks to enable): ${host}`,
      };
    }
  }
  return { ok: true };
}

export function createWebFetchTool(getConfig: () => AppConfig): ToolDefinition {
  return {
    name: 'web_fetch',
    description: 'Fetch content from a URL. Returns the text content of the page with HTML tags stripped for readability.',
    inputSchema: z.object({
      url: z.string().url().describe('The URL to fetch'),
      maxLength: z.number().optional().default(50000).describe('Maximum content length to return'),
    }),
    execute: async (input) => {
      const { url, maxLength } = input as { url: string; maxLength: number };
      try {
        const cfg = getConfig().tools?.webFetch;
        const timeout = cfg?.timeout || 30000;
        const allowPrivate = cfg?.allowPrivateNetworks ?? false;

        let currentUrl = url;
        let resp: Response | undefined;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          // Scheme + IP-literal range re-validated on every hop; hostname
          // resolution range-enforcement happens at connect time inside
          // guardedDispatcher (no TOCTOU window).
          const check = isUrlAllowed(currentUrl, allowPrivate);
          if (!check.ok) return { error: check.reason };

          resp = (await undiciFetch(currentUrl, {
            headers: withBrandUserAgent(),
            signal: AbortSignal.timeout(timeout),
            redirect: 'manual',
            ...(allowPrivate ? {} : { dispatcher: guardedDispatcher }),
          })) as unknown as Response;

          if (resp.status >= 301 && resp.status <= 308 && resp.status !== 304) {
            const location = resp.headers.get('location');
            if (!location) return { error: `HTTP ${resp.status} redirect missing Location header` };
            if (hop === MAX_REDIRECTS) return { error: `Too many redirects (> ${MAX_REDIRECTS})` };
            currentUrl = new URL(location, currentUrl).toString();
            continue;
          }
          break;
        }

        if (!resp) return { error: 'Fetch failed: no response' };
        if (!resp.ok) return { error: `HTTP ${resp.status} ${resp.statusText}` };
        const contentType = resp.headers.get('content-type') ?? '';
        let content = await resp.text();

        if (contentType.includes('text/html')) {
          content = sanitizeHtml(content, {
            allowedTags: [],
            allowedAttributes: {},
          })
            .replace(/\s+/g, ' ')
            .trim();
        }

        if (content.length > maxLength) {
          content = content.slice(0, maxLength) + '\n\n[Truncated]';
        }

        return { url: currentUrl, contentType, length: content.length, content };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

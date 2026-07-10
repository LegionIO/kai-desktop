import { z } from 'zod';
// Use undici's own fetch so the Agent dispatcher is compatible — Node's
// global fetch uses the bundled undici, which may be a different version
// than the npm package and rejects external dispatchers.
import { fetch as undiciFetch } from 'undici';
import sanitizeHtml from 'sanitize-html';
import type { ToolDefinition } from './types.js';
import type { AppConfig } from '../config/schema.js';
import { withBrandUserAgent } from '../utils/user-agent.js';
import { isUrlAllowed, guardedDispatcher, MAX_REDIRECTS } from '../utils/ssrf-guard.js';

export function createWebFetchTool(getConfig: () => AppConfig): ToolDefinition {
  return {
    name: 'web_fetch',
    description:
      'Fetch content from a URL. Returns the text content of the page with HTML tags stripped for readability.',
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

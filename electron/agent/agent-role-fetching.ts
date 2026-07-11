/**
 * Agent Role Fetching — retrieves role template markdown from GitHub.
 *
 * Fetches the full markdown content for a matched role from the
 * msitarzewski/agency-agents repository. Includes in-memory caching.
 *
 * TLS verification is enforced. Environments with corporate MITM proxies
 * should set NODE_EXTRA_CA_CERTS to trust the proxy's CA rather than
 * disabling verification.
 */

import https from 'https';
import { ROLE_BASE_URL } from './agent-roles.js';

/** In-memory cache for fetched templates. */
const templateCache = new Map<string, string>();

/** Only follow redirects that stay on this host. */
const ALLOWED_REDIRECT_HOST = 'raw.githubusercontent.com';
/** Maximum redirect chain length. */
const MAX_REDIRECTS = 5;
/** Cap the response body — a role template is small markdown; an unexpectedly
 *  huge body must not bloat memory or the synthesized prompt context. */
const MAX_TEMPLATE_BYTES = 512 * 1024;

/**
 * Defense-in-depth validation of a roleId before it is interpolated into the
 * fetch URL (`${ROLE_BASE_URL}/${roleId}.md`). Today the only caller passes a
 * catalog-controlled id, but this function is exported, so a future untrusted
 * caller must not be able to path-traverse (`../`), alter the URL authority
 * (`@`, `\`, a scheme), or smuggle query/fragment/encoded bytes. The catalog id
 * shape is `division/role-name` segments of lowercase alphanumerics with
 * internal hyphens, single slashes, no leading/trailing/double slash, no dots.
 */
const VALID_ROLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

export function isValidRoleId(roleId: string): boolean {
  return VALID_ROLE_ID.test(roleId);
}

/**
 * Fetch a URL via https.get with TLS verification enabled.
 * Follows up to MAX_REDIRECTS same-host redirects.
 */
function httpsGet(url: string, timeoutMs = 8000, depth = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      // Follow redirect
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy();
        if (depth >= MAX_REDIRECTS) {
          reject(new Error('Too many redirects'));
          return;
        }
        let redirectUrl: URL;
        try {
          redirectUrl = new URL(res.headers.location, url);
        } catch {
          reject(new Error('Invalid redirect location'));
          return;
        }
        if (redirectUrl.hostname !== ALLOWED_REDIRECT_HOST) {
          reject(new Error(`Refusing to follow redirect to disallowed host: ${redirectUrl.hostname}`));
          return;
        }
        httpsGet(redirectUrl.toString(), timeoutMs, depth + 1)
          .then(resolve)
          .catch(reject);
        return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_TEMPLATE_BYTES) {
          req.destroy();
          reject(new Error(`Role template exceeds ${MAX_TEMPLATE_BYTES / 1024}KB limit`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', reject);
  });
}

/**
 * Fetch the full markdown template for a role from GitHub.
 * Returns the content string, or null on failure.
 */
export async function fetchRoleTemplate(roleId: string): Promise<string | null> {
  // Reject anything that isn't a well-formed catalog id BEFORE building the URL,
  // so an untrusted roleId can't traverse the path or alter the fetch target.
  if (!isValidRoleId(roleId)) {
    console.warn(`[RoleFetch] Refusing to fetch invalid roleId: ${JSON.stringify(roleId)}`);
    return null;
  }

  const cached = templateCache.get(roleId);
  if (cached) return cached;

  const url = `${ROLE_BASE_URL}/${roleId}.md`;

  try {
    const content = await httpsGet(url);
    templateCache.set(roleId, content);
    return content;
  } catch (error) {
    console.warn(`[RoleFetch] Error fetching ${url}:`, error);
    return null;
  }
}

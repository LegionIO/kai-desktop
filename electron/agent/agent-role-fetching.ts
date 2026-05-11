/**
 * Agent Role Fetching — retrieves role template markdown from GitHub.
 *
 * Fetches the full markdown content for a matched role from the
 * msitarzewski/agency-agents repository. Includes in-memory caching.
 *
 * Uses https.request directly (instead of fetch) so that rejectUnauthorized: false
 * is respected — Node's built-in fetch ignores the agent option.
 */

import https from 'https';
import { ROLE_BASE_URL } from './agent-roles.js';

/** In-memory cache for fetched templates. */
const templateCache = new Map<string, string>();

/**
 * Fetch a URL via https.request with TLS verification disabled.
 * Follows a single redirect if the response is 301/302/307/308.
 */
function httpsGet(url: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false }, (res) => {
      // Follow redirect
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy();
        httpsGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
        return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
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

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Resolve the one top-level document allowed to hold Kai's privileged preload. */
export function resolvePrimaryRendererUrl(rendererDirectory: string, developmentUrl?: string): string {
  return developmentUrl ? new URL(developmentUrl).href : pathToFileURL(join(rendererDirectory, 'index.html')).href;
}

/** Hash changes stay in the same document. Every other URL component must
 * match so another local file or a same-origin dev-server resource cannot gain
 * the primary renderer's IPC authority. */
export function isCanonicalPrimaryRendererUrl(candidate: string, canonicalUrl: string): boolean {
  try {
    const actual = new URL(candidate);
    const expected = new URL(canonicalUrl);
    actual.hash = '';
    expected.hash = '';
    return actual.href === expected.href;
  } catch {
    return false;
  }
}

function isPdfDataUrl(candidate: string): boolean {
  if (!candidate.toLowerCase().startsWith('data:')) return false;
  const comma = candidate.indexOf(',');
  if (comma < 0) return false;
  const mediaType = candidate.slice('data:'.length, comma).split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/pdf';
}

/** A `kai-media://…/<name>.pdf` URL for the offloaded-PDF preview subframe. Offload
 *  stores PDFs under files/ with a real `.pdf` extension, and the media protocol
 *  handler serves them inert (application/pdf) with realpath containment inside the
 *  media dir. Allowing this ONLY in a sandboxed subframe (never the top-level
 *  renderer) is equivalent to the existing PDF data:-URL allowance — the same native
 *  viewer, just sourced from disk instead of an inline base64 blob. Validated
 *  narrowly: exact scheme + a `.pdf` path with no traversal-looking segments. */
function isMediaPdfUrl(candidate: string): boolean {
  const prefix = __BRAND_MEDIA_PROTOCOL + '://';
  if (!candidate.startsWith(prefix)) return false;
  const path = candidate.slice(prefix.length).split(/[?#]/, 1)[0];
  if (!/\.pdf$/i.test(path)) return false;
  // No traversal / empty segments — the protocol handler is authoritative on
  // containment, but keep this allow-check conservative too.
  return !path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

/** Navigation policy for the privileged Kai renderer and its sandboxed preview
 * frames. Subframes need exact about documents for srcdoc/bootstrap content, PDF
 * data URLs for inline attachment previews, and kai-media:// PDF URLs for OFFLOADED
 * attachment previews. Other data/about URLs stay blocked, and no data/media URL may
 * replace the top-level privileged renderer. */
export function isAllowedPrimaryRendererFrameNavigation(
  candidate: string,
  canonicalUrl: string,
  isMainFrame: boolean,
): boolean {
  if (isCanonicalPrimaryRendererUrl(candidate, canonicalUrl)) return true;
  if (isMainFrame) return false;
  if (candidate === 'about:blank' || candidate === 'about:srcdoc') return true;
  return isPdfDataUrl(candidate) || isMediaPdfUrl(candidate);
}

export type PrimaryRendererFrameNavigationDisposition = 'allow' | 'block' | 'external';

/** Block every untrusted renderer navigation before Chromium issues it. Only a
 * top-level navigation is an app-level "open this link" request that may be
 * handed to the OS browser; a sandboxed artifact subframe can navigate itself
 * without a user gesture, so forwarding its URL would become an exfiltration
 * channel even though the embedded request itself was denied. */
export function primaryRendererFrameNavigationDisposition(
  candidate: string,
  canonicalUrl: string,
  isMainFrame: boolean,
): PrimaryRendererFrameNavigationDisposition {
  if (isAllowedPrimaryRendererFrameNavigation(candidate, canonicalUrl, isMainFrame)) return 'allow';
  return isMainFrame ? 'external' : 'block';
}

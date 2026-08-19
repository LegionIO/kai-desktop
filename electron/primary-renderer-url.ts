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

/** Navigation policy for the privileged Kai renderer and its sandboxed preview
 * frames. Subframes need exact about documents for srcdoc/bootstrap content and
 * PDF data URLs for the existing attachment preview. Other data/about URLs stay
 * blocked, and no data URL may replace the top-level privileged renderer. */
export function isAllowedPrimaryRendererFrameNavigation(
  candidate: string,
  canonicalUrl: string,
  isMainFrame: boolean,
): boolean {
  if (isCanonicalPrimaryRendererUrl(candidate, canonicalUrl)) return true;
  if (isMainFrame) return false;
  if (candidate === 'about:blank' || candidate === 'about:srcdoc') return true;
  return isPdfDataUrl(candidate);
}

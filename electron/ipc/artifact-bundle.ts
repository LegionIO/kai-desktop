import type { IpcMain } from 'electron';
import { app } from 'electron';
import { createHash } from 'crypto';

/**
 * Bundles model-generated React artifacts LOCALLY (esbuild + the React copies
 * already in node_modules) into a single self-contained IIFE.
 *
 * SECURITY: the whole point of this handler is to remove the artifact iframe's
 * network dependency. The previous renderer pulled React + Babel-standalone
 * from unpkg.com, which forced the iframe CSP to allow that origin — and any
 * allowed origin in a sandbox that runs untrusted model code is a
 * data-exfiltration channel (`fetch('https://unpkg.com/?<secret>')`, injected
 * `<script src>`, etc.). By bundling here we can serve the artifact with a
 * fully network-free CSP (`connect-src 'none'`, no remote `script-src`).
 *
 * The bundle contains no remote references: the only http(s) URLs in a
 * production React build are the `react.dev/errors/` decoder string (never
 * fetched) and XML namespace URIs — both inert, and blocked anyway by the
 * iframe's `connect-src 'none'`.
 */

export type BundleReactResult = { ok: true; code: string } | { ok: false; error: string };

/** Reject pathologically large sources before handing them to esbuild. */
const MAX_SOURCE_BYTES = 512 * 1024;

/** Bounded LRU-ish cache keyed by a hash of the raw source. */
const MAX_CACHE_ENTRIES = 50;
const cache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Refresh recency: re-insert so eviction targets genuinely cold entries.
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, code: string): void {
  cache.set(key, code);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Turn the raw artifact source into a bundle-able module:
 *  - `export default X`  → `const __ArtifactRoot = X` (esbuild strips exports
 *    from an IIFE anyway; we bind it to a known name we can reference).
 *  - `export const/let/var/function/class` → strip the leading `export`.
 * Then append a bootstrap that mounts the component and reports errors into
 * `#root` as a red <pre>.
 */
function wrapSource(source: string): string {
  const normalized = source
    .replace(/^\s*export\s+default\s+/m, 'const __ArtifactRoot = ')
    .replace(/^\s*export\s+(?=(const|let|var|function|class)\b)/gm, '');

  const bootstrap = `
import * as __ArtifactReact from 'react';
import { createRoot as __artifactCreateRoot } from 'react-dom/client';
;(function () {
  var __rootEl = document.getElementById('root');
  function __fail(msg) {
    if (__rootEl) {
      var pre = document.createElement('pre');
      pre.style.cssText = 'padding:1rem;color:#b91c1c;white-space:pre-wrap;word-break:break-word';
      pre.textContent = String(msg);
      __rootEl.innerHTML = '';
      __rootEl.appendChild(pre);
    }
  }
  try {
    var __c =
      (typeof __ArtifactRoot !== 'undefined' && __ArtifactRoot) ||
      (typeof App !== 'undefined' && App) ||
      (typeof Component !== 'undefined' && Component) ||
      null;
    if (!__c) {
      __fail('No component named App or Component was exported.');
      return;
    }
    if (!__rootEl) {
      __fail('Internal error: #root not found.');
      return;
    }
    __artifactCreateRoot(__rootEl).render(__ArtifactReact.createElement(__c));
  } catch (e) {
    __fail((e && e.stack) || e);
  }
})();
`;

  return `${normalized}\n${bootstrap}`;
}

async function bundleReact(source: string): Promise<BundleReactResult> {
  if (typeof source !== 'string') {
    return { ok: false, error: 'Invalid source.' };
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    return { ok: false, error: 'Artifact source exceeds the 512KB bundling limit.' };
  }

  const key = createHash('sha256').update(source).digest('hex');
  const cached = cacheGet(key);
  if (cached !== undefined) {
    return { ok: true, code: cached };
  }

  try {
    // Dynamic import so esbuild stays external (it locates its native binary
    // via a relative path and breaks if bundled into the main JS).
    const esbuild = await import('esbuild');
    // Resolve `react` / `react-dom/client` from the app's node_modules. In dev
    // this is the repo root; in a packaged build it's the asar root, where
    // react/react-dom ship as runtime dependencies.
    const resolveDir = app.getAppPath();

    const result = await esbuild.build({
      stdin: {
        contents: wrapSource(source),
        resolveDir,
        loader: 'jsx',
        sourcefile: 'artifact.jsx',
      },
      bundle: true,
      format: 'iife',
      minify: true,
      write: false,
      // Production React needs no `unsafe-eval`; dev React would. Force prod.
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    });

    const out = result.outputFiles?.[0]?.text;
    if (!out) {
      return { ok: false, error: 'Bundler produced no output.' };
    }
    cacheSet(key, out);
    return { ok: true, code: out };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export function registerArtifactBundleHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('artifact:bundle-react', (_event, payload: { source: string }): Promise<BundleReactResult> => {
    const source = payload && typeof payload === 'object' ? payload.source : undefined;
    return bundleReact(source as string);
  });
}

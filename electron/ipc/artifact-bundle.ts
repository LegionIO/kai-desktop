import type { IpcMain } from 'electron';
import { app } from 'electron';
import { createHash } from 'crypto';
import { sep } from 'path';

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

  // Does the artifact already import React itself? (default, namespace, or
  // named). If so, we must NOT also declare a `React` binding — that would be a
  // duplicate-declaration error. We only inject a `React` alias when absent, so
  // snippets that use a bare `React.*` without importing still resolve.
  const importsReact = /^\s*import\s+[^;]*\bfrom\s+['"]react['"]/m.test(source);
  const reactAlias = importsReact ? '' : `import * as React from 'react';\n`;

  // Internal-only bindings (double-underscore names avoid clashing with any
  // artifact identifier). `jsx: 'automatic'` handles JSX syntax itself.
  const prelude = `${reactAlias}import * as __ArtifactReact from 'react';\nimport { createRoot as __artifactCreateRoot } from 'react-dom/client';\n`;

  const bootstrap = `
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

  return `${prelude}${normalized}\n${bootstrap}`;
}

// Only these modules may be imported by (or on behalf of) artifact source. This
// prevents a malicious artifact from importing arbitrary local files — e.g.
// `import cfg from '/Users/.../.kai/config.json'` — which esbuild would
// otherwise resolve and inline into the bundle, exfiltrating secrets.
const IMPORT_ALLOWLIST = new Set([
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
]);

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
    type EsbuildPlugin = Parameters<typeof esbuild.build>[0] extends { plugins?: (infer P)[] } ? P : never;
    // Resolve `react` / `react-dom/client` from the app's node_modules. In dev
    // this is the repo root; in a packaged build the app path is inside
    // `app.asar`, which esbuild's native service cannot read — React is
    // asarUnpack'd (see electron-builder.yml), so point esbuild at the
    // unpacked path instead.
    const resolveDir = app.getAppPath().replace(/app\.asar(?=[/\\]|$)/, 'app.asar.unpacked');

    const result = await esbuild.build({
      stdin: {
        contents: wrapSource(source),
        resolveDir,
        loader: 'tsx',
        sourcefile: 'artifact.tsx',
      },
      bundle: true,
      format: 'iife',
      minify: true,
      write: false,
      // Automatic JSX runtime → artifact JSX doesn't need a `React` global.
      jsx: 'automatic',
      // Production React needs no `unsafe-eval`; dev React would. Force prod.
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
      // Allowlist plugin: reject any import from artifact source except React.
      // Prevents inlining arbitrary local files (secret exfiltration).
      plugins: [
        {
          name: 'artifact-import-allowlist',
          setup(build) {
            build.onResolve({ filter: /.*/ }, async (args) => {
              if (args.kind === 'entry-point') return null;
              // Avoid infinite recursion through build.resolve() below.
              if (args.pluginData === '__artifact_checked') return null;

              const isBare = !args.path.startsWith('.') && !args.path.startsWith('/');
              // React and react-dom pull in their own bare deps (e.g.
              // `scheduler`) with an importer inside node_modules — allow those.
              const importerInNodeModules = args.importer.split(sep).includes('node_modules');
              if (isBare) {
                if (importerInNodeModules || IMPORT_ALLOWLIST.has(args.path)) return null;
                // Bare specifier written in the artifact source: reject.
                return {
                  errors: [
                    { text: `Import of "${args.path}" is not allowed in React artifacts (only React is permitted).` },
                  ],
                };
              }
              // Relative/absolute import: resolve it, then reject anything that
              // lands outside node_modules (blocks pulling in arbitrary local
              // files like ~/.kai/config.json). React's own relative internals
              // resolve inside node_modules and pass.
              const resolved = await build.resolve(args.path, {
                kind: args.kind,
                importer: args.importer,
                resolveDir: args.resolveDir,
                pluginData: '__artifact_checked',
              });
              if (resolved.errors.length > 0) return resolved;
              if (!resolved.path.split(sep).includes('node_modules')) {
                return {
                  errors: [
                    { text: `Import of "${args.path}" is not allowed: only React may be bundled into an artifact.` },
                  ],
                };
              }
              return resolved;
            });
          },
        } as EsbuildPlugin,
      ],
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

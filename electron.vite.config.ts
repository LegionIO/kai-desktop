import { resolve } from 'path';
import { existsSync } from 'fs';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import autoprefixer from 'autoprefixer';
import { branding } from './branding.config';
import { resolveBranding } from './scripts/resolve-branding';
import pkg from './package.json';

// ---------------------------------------------------------------------------
// Build a Vite `define` map from branding.config.ts so that every key is
// available as a compile-time constant in all three Electron build targets.
//
//   branding.productName  →  __BRAND_PRODUCT_NAME  (string literal at build time)
//   branding.appSlug      →  __BRAND_APP_SLUG
//   …etc.
//
// If `branding.config.local.ts` exists, its exports are shallow-merged on
// top of the base config.  That file is gitignored so developers can add
// local overrides (e.g. an enterprise marketplace URL) without touching
// committed code.
// ---------------------------------------------------------------------------
function camelToScreamingSnake(s: string): string {
  return s.replace(/([A-Z])/g, '_$1').toUpperCase();
}

// Merge optional local overrides (gitignored)
let mergedBranding: Record<string, unknown> = { ...branding };
const localPath = resolve(__dirname, 'branding.config.local.ts');
if (existsSync(localPath)) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const local = require('./branding.config.local');
    const overrides = local.brandingLocal ?? local.default ?? {};
    mergedBranding = { ...mergedBranding, ...overrides };
    console.info('[branding] Merged local overrides from branding.config.local.ts');
  } catch (err) {
    console.warn('[branding] Failed to load branding.config.local.ts:', err);
  }
}

const resolved = resolveBranding(mergedBranding);
const brandDefines: Record<string, string> = {};
for (const [key, value] of Object.entries(resolved)) {
  brandDefines[`__BRAND_${camelToScreamingSnake(key)}`] = JSON.stringify(value);
}
brandDefines.__APP_VERSION = JSON.stringify(pkg.version);

export default defineConfig({
  main: {
    define: brandDefines,
    plugins: [
      // @mastra/core dynamically imports execa with /* @vite-ignore */ which
      // prevents Vite from bundling it. This plugin strips the ignore
      // directives and rewrites the indirect `import(mod)` to a direct
      // `import("execa")` so Rollup resolves and bundles it normally.
      {
        name: 'bundle-execa',
        transform(code, _id) {
          if (!code.includes('getExeca')) return null;
          const pattern =
            /const mod = "execa";\s*const execa = \(await import\(\s*\/\*\s*@vite-ignore\s*\*\/\s*\/\*\s*webpackIgnore:\s*true\s*\*\/\s*mod\s*\)\)\.execa;/s;
          if (!pattern.test(code)) return null;
          return {
            code: code.replace(
              pattern,
              `const execa = (await import("execa")).execa;`,
            ),
            map: null,
          };
        },
      },
    ],
    build: {
      // electron-builder + pnpm doesn't reliably include transitive
      // dependencies in the asar. Disable automatic externalization so
      // everything is bundled into the main JS, then only externalize
      // packages that must remain external (native addons, electron).
      externalizeDeps: false,
      rollupOptions: {
        external: [
          'electron',
          'original-fs',
          // esbuild must stay external — its JS API locates its native
          // binary via a relative path and breaks when bundled.
          'esbuild',
          // Native addons that can't be bundled
          'better-sqlite3',
          'tiktoken',
          // libsql uses platform-specific native binaries
          'libsql',
          /^@libsql\//,
        ],
        input: {
          index: resolve(__dirname, 'electron/main.ts'),
        },
      },
    },
  },
  preload: {
    define: brandDefines,
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts'),
        },
      },
    },
  },
  renderer: {
    root: 'src',
    plugins: [react()],
    define: brandDefines,
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/index.html'),
      },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    css: {
      postcss: {
        plugins: [tailwindcss(), autoprefixer()],
      },
    },
  },
});

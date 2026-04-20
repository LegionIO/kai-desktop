import { resolve } from 'path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import autoprefixer from 'autoprefixer';
import { branding } from './branding.config';
import pkg from './package.json';

// ---------------------------------------------------------------------------
// Build a Vite `define` map from branding.config.ts so that every key is
// available as a compile-time constant in all three Electron build targets.
//
//   branding.productName  →  __BRAND_PRODUCT_NAME  (string literal at build time)
//   branding.appSlug      →  __BRAND_APP_SLUG
//   …etc.
// ---------------------------------------------------------------------------
function camelToScreamingSnake(s: string): string {
  return s.replace(/([A-Z])/g, '_$1').toUpperCase();
}

const brandDefines: Record<string, string> = {};
for (const [key, value] of Object.entries(branding)) {
  brandDefines[`__BRAND_${camelToScreamingSnake(key)}`] = JSON.stringify(value);
}
brandDefines.__APP_VERSION = JSON.stringify(pkg.version);

export default defineConfig({
  main: {
    define: brandDefines,
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
          // PTY for workspace terminals
          '@lydell/node-pty',
          /^@lydell\/node-pty/,
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

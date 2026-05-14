import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import path from 'path';

import { branding } from './branding.config';
import { resolveBranding } from './scripts/resolve-branding';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(`${__dirname}/package.json`, 'utf8')) as { version: string };

/**
 * Mirror the `define()` map produced in `electron.vite.config.ts` so any test
 * that imports production code referencing `__BRAND_*` compile-time constants
 * can resolve them. Without this, those identifiers throw `ReferenceError`
 * the moment a test pulls in a module that uses them.
 *
 * The transform here intentionally matches the build's behaviour:
 *   branding.productName  →  __BRAND_PRODUCT_NAME
 *   branding.appSlug      →  __BRAND_APP_SLUG
 *   …etc.
 *
 * Local branding overrides (`branding.config.local.ts`) are NOT merged here —
 * tests should run against the committed defaults so CI stays deterministic.
 */
function camelToScreamingSnake(s: string): string {
  return s.replace(/([A-Z])/g, '_$1').toUpperCase();
}

const resolved = resolveBranding({ ...branding });
const _brandDefines: Record<string, string> = {};
for (const [key, value] of Object.entries(resolved)) {
  _brandDefines[`__BRAND_${camelToScreamingSnake(key)}`] = JSON.stringify(value);
}
_brandDefines.__APP_VERSION = JSON.stringify(pkg.version);

/**
 * Frozen brand define() map; re-exported so the per-slice vitest configs
 * (vitest.unit / .component / .integration) can reuse the same map
 * without re-deriving it from `branding.config.ts` themselves.
 */
export const brandDefines = _brandDefines;

export const baseConfig = defineConfig({
  test: {
    // Test files live alongside source code or in __tests__ directories
    include: ['electron/**/__tests__/**/*.test.ts', 'electron/**/*.test.ts'],
    // Nightly-only suites are opted out of the default run; trigger them
    // explicitly via the dedicated config (or a workflow on a schedule).
    exclude: ['**/*.nightly.test.ts', 'node_modules/**'],
    // Use Node environment for electron main-process tests
    environment: 'node',
    // Resolve .ts extensions
    globals: true,
    // Global setup: deterministic time/UUID, node-pty stub; msw is opt-in
    // (installed by individual suites that need it).
    setupFiles: ['./vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: brandDefines,
});

export default baseConfig;

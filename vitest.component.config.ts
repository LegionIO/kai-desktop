import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { brandDefines } from './vitest.config';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Component-test slice. Renders React components in jsdom and matches
 * against the testing-library matchers from `@testing-library/jest-dom`.
 *
 * Defined standalone rather than via `mergeConfig` so the `include` glob
 * here replaces the base config's electron-main-process include. The base
 * setup file is still loaded (for deterministic clock/UUID + pty stub)
 * and the jest-dom setup is appended.
 *
 * The `@` resolve alias mirrors the renderer build configuration in
 * `electron.vite.config.ts` so component source files that import via
 * `@/...` resolve identically in tests.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.component.test.tsx', 'src/**/*.test.tsx'],
    // `*.darwin.test.ts`: see comment in vitest.unit.config.ts.
    exclude: [
      '**/*.nightly.test.ts',
      'node_modules/**',
      ...(process.platform !== 'darwin' ? ['**/*.darwin.test.ts'] : []),
    ],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts', './test-utils/jest-dom-setup.ts'],
    // No component tests exist yet — the slice is scaffolding for future
    // React testing-library suites. Don't fail the run until one lands.
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  define: brandDefines,
});

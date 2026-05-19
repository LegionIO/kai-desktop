import { defineConfig } from 'vitest/config';

import { brandDefines } from './vitest.config';

/**
 * Component-test slice. Renders React components in jsdom and matches
 * against the testing-library matchers from `@testing-library/jest-dom`.
 *
 * Defined standalone rather than via `mergeConfig` so the `include` glob
 * here replaces the base config's electron-main-process include. The base
 * setup file is still loaded (for deterministic clock/UUID + pty stub)
 * and the jest-dom setup is appended.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.component.test.tsx', 'src/**/*.test.tsx'],
    exclude: ['**/*.nightly.test.ts', 'node_modules/**'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts', './test-utils/jest-dom-setup.ts'],
    // No component tests exist yet — the slice is scaffolding for future
    // React testing-library suites. Don't fail the run until one lands.
    passWithNoTests: true,
  },
  define: brandDefines,
});

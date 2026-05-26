import { defineConfig } from 'vitest/config';

import { brandDefines } from './vitest.config';

/**
 * Integration-test slice. Targets longer-running tests that wire multiple
 * subsystems together. Kept separate from the unit run so per-PR feedback
 * stays fast — call `pnpm test:integration` explicitly when needed.
 *
 * Defined standalone rather than via `mergeConfig` so the `include` glob
 * here replaces — instead of concatenating with — the base config's
 * default include.
 */
export default defineConfig({
  test: {
    include: ['electron/**/*.integration.test.ts'],
    exclude: ['**/*.nightly.test.ts', 'node_modules/**'],
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 30_000,
    // No integration tests exist yet — the slice is scaffolding for future
    // multi-subsystem suites. Don't fail the run until one lands.
    passWithNoTests: true,
  },
  define: brandDefines,
});

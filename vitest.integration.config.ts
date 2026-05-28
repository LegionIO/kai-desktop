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
    include: [
      'electron/**/*.integration.test.ts',
      // Real-API smoke tests live under `integration-real/`. Each file's own
      // `describe.skipIf(...)` gate keeps them dormant unless
      // `RUN_REAL_API_TESTS=1` is set in the environment — local dev runs
      // see them in the list but skip every test inside.
      'electron/__tests__/integration-real/**/*.real.test.ts',
    ],
    // `*.darwin.test.ts`: see comment in vitest.unit.config.ts.
    exclude: [
      '**/*.nightly.test.ts',
      'node_modules/**',
      ...(process.platform !== 'darwin' ? ['**/*.darwin.test.ts'] : []),
    ],
    environment: 'node',
    globals: true,
    setupFiles: [
      './vitest.setup.ts',
      // Sequenced AFTER vitest.setup.ts so the egress firewall installs,
      // self-tests, and then THIS file conditionally restores real fetch
      // when `RUN_REAL_API_TESTS=1`. Defense-in-depth: every real test
      // independently skips on the same env flag.
      './electron/__tests__/integration-real/setup-real-api.ts',
    ],
    // Real-API calls can take 20-30s on cold paths (especially the streaming
    // smoke). Push the timeout up so a slow but successful response doesn't
    // get killed mid-flight.
    testTimeout: 60_000,
    // No integration tests exist yet — the slice is scaffolding for future
    // multi-subsystem suites. Don't fail the run until one lands.
    passWithNoTests: true,
  },
  define: brandDefines,
});

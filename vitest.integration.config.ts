import { defineConfig, mergeConfig } from 'vitest/config';

import { baseConfig } from './vitest.config';

/**
 * Integration-test slice. Targets longer-running tests that wire multiple
 * subsystems together. Kept separate from the unit run so per-PR feedback
 * stays fast — call `pnpm test:integration` explicitly when needed.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['electron/**/*.integration.test.ts'],
      exclude: ['**/*.nightly.test.ts', 'node_modules/**'],
      environment: 'node',
      testTimeout: 30_000,
    },
  }),
);

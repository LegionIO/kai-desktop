import { defineConfig } from 'vitest/config';

import { brandDefines } from './vitest.config';

/**
 * Unit-test slice of the suite. Targets pure logic in the electron main
 * process and the shared test-utils helpers. Excludes anything that needs
 * a browser DOM (component tests) or external systems (integration tests).
 *
 * Defined standalone rather than via `mergeConfig` so the `include` glob
 * here replaces — instead of concatenating with — the base config's
 * default include. Brand `define()` map and the global setup file are
 * re-imported from `vitest.config.ts`.
 */
export default defineConfig({
  test: {
    include: ['electron/**/*.test.ts', 'test-utils/**/*.test.ts'],
    exclude: [
      '**/*.component.test.tsx',
      '**/*.integration.test.ts',
      '**/*.nightly.test.ts',
      'electron/__tests__/canaries/**',
      'node_modules/**',
    ],
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
  },
  define: brandDefines,
});

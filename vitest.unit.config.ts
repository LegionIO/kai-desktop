import { defineConfig, mergeConfig } from 'vitest/config';

import { baseConfig } from './vitest.config';

/**
 * Unit-test slice of the suite. Targets pure logic in the electron main
 * process and the shared test-utils helpers. Excludes anything that needs
 * a browser DOM (component tests) or external systems (integration tests).
 *
 * Pulls in the brand `define()` map and the global setup file (msw, pty
 * stub, deterministic clock/UUID) from `baseConfig`.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: [
        'electron/**/*.test.ts',
        'test-utils/**/*.test.ts',
      ],
      exclude: [
        '**/*.component.test.tsx',
        '**/*.integration.test.ts',
        '**/*.nightly.test.ts',
        'electron/__tests__/canaries/**',
        'node_modules/**',
      ],
      environment: 'node',
    },
  }),
);

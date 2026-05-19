import { defineConfig, mergeConfig } from 'vitest/config';

import { brandDefines } from './vitest.config';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Component-test slice. Renders React components in jsdom and matches
 * against the testing-library matchers from `@testing-library/jest-dom`.
 *
 * The brand `define()` map and the global setup (msw + deterministic
 * clock/UUID) are inherited from `baseConfig` via `mergeConfig`. We append
 * an extra setup file that wires `@testing-library/jest-dom/vitest`.
 */
const baseSetupFiles =
  (baseConfig.test?.setupFiles as string[] | undefined) ?? [];

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['src/**/*.component.test.tsx', 'src/**/*.test.tsx'],
      exclude: ['**/*.nightly.test.ts', 'node_modules/**'],
      environment: 'jsdom',
      setupFiles: [...baseSetupFiles, './test-utils/jest-dom-setup.ts'],
    },
  }),
);

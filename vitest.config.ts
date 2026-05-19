import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files live alongside source code or in __tests__ directories
    include: ['electron/**/__tests__/**/*.test.ts', 'electron/**/*.test.ts'],
    // Use Node environment for electron main-process tests
    environment: 'node',
    // Resolve .ts extensions
    globals: true,
    // Global setup: deterministic time/UUID, node-pty stub
    setupFiles: ['./vitest.setup.ts'],
  },
  define: {
    // Brand placeholders so production code referencing __BRAND_* constants can
    // be imported under test without triggering "X is not defined" errors.
    __BRAND_NAME__: JSON.stringify('Kai'),
    __BRAND_VERSION__: JSON.stringify('test'),
    __BRAND_BUILD__: JSON.stringify('test-build'),
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files live alongside source code or in __tests__ directories
    include: ['electron/**/__tests__/**/*.test.ts', 'electron/**/*.test.ts'],
    // Use Node environment for electron main-process tests
    environment: 'node',
    // Resolve .ts extensions
    globals: true,
  },
});

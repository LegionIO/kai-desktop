import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // Test files live alongside source code or in __tests__ directories
    include: [
      'electron/**/__tests__/**/*.test.ts',
      'electron/**/*.test.ts',
      'src/**/__tests__/**/*.test.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
    ],
    // Use Node environment by default - this is correct for electron/** tests.
    // src/** tests should use @vitest-environment jsdom annotation per-file.
    environment: 'node',
    // Resolve .ts extensions
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});

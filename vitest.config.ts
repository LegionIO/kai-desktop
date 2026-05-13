import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    // Test files live alongside source code or in __tests__ directories
    include: [
      'electron/**/__tests__/**/*.test.ts',
      'electron/**/*.test.ts',
      'src/**/__tests__/**/*.test.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
    ],
    // Use jsdom for React component tests
    environment: 'jsdom',
    // Resolve .ts/.tsx extensions
    globals: true,
    // Setup file for React testing
    setupFiles: ['./vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@electron': path.resolve(__dirname, './electron'),
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
});

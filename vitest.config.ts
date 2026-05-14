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
    // Use Node environment by default - correct for electron/** tests.
    // src/** React component tests declare @vitest-environment jsdom per-file.
    environment: 'node',
    globals: true,
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

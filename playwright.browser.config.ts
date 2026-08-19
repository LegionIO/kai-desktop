import { defineConfig } from '@playwright/test';

/** Opt-in native Electron coverage for the in-app browser (requires a display). */
export default defineConfig({
  testDir: './e2e',
  testMatch: /browser-sidebar\.local\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 90_000,
  expect: { timeout: 15_000 },
});

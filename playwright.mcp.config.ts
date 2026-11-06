import { defineConfig } from '@playwright/test';

/** Controlled local OAuth and native sign-in window coverage; requires a display. */
export default defineConfig({
  testDir: './e2e',
  testMatch: /mcp-oauth\.local\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 90_000,
  expect: { timeout: 15_000 },
});

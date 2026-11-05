import { defineConfig } from '@playwright/test';

/** Controlled local OAuth qualification across desktop, browser and terminal. */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'mcp-oauth.local.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: 'list',
});

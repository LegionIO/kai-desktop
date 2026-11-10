import { defineConfig } from '@playwright/test';

/** Opt-in local Electron, stdio MCP and HTTPS/OAuth coverage. No external accounts. */
export default defineConfig({
  testDir: './e2e',
  testMatch: /plugin-bridge\.local\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 120_000,
  expect: { timeout: 15_000 },
});

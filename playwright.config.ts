/**
 * Playwright configuration for the IPC seam smoke test.
 *
 * Scope: This config drives a single, fast Electron round-trip test that
 * validates the contextBridge wiring between the main and renderer processes.
 * It is NOT a packaging-level end-to-end suite — packaging integration is
 * asserted by the `pr-mac-build` job, which runs `electron-builder` to
 * produce the signed DMG. See TESTING.md for the full distinction.
 *
 * Determinism is the priority:
 *   - retries: 0          — flakes must surface, not be masked
 *   - workers: 1          — one Electron app instance at a time
 *   - fullyParallel: false — sequential within the single project
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // Generous per-test timeout: the unpackaged Electron binary spends a few
  // seconds bootstrapping the user-data directory, plugin scaffolding, and
  // the main window. This timeout is *upper bound*; a healthy run takes
  // well under 30 seconds.
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  projects: [
    {
      name: 'electron-ipc-seam',
    },
  ],
});

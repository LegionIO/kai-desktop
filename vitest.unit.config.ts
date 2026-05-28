import { defineConfig } from 'vitest/config';

import { brandDefines } from './vitest.config';

/**
 * Unit-test slice of the suite. Targets pure logic in the electron main
 * process and the shared test-utils helpers. Excludes anything that needs
 * a browser DOM (component tests) or external systems (integration tests).
 *
 * Defined standalone rather than via `mergeConfig` so the `include` glob
 * here replaces — instead of concatenating with — the base config's
 * default include. Brand `define()` map and the global setup file are
 * re-imported from `vitest.config.ts`.
 *
 * Coverage is reporting-only: no thresholds, no failure gate. The
 * `pnpm test:coverage` script and the PR coverage workflow both consume
 * the `json-summary` reporter; the `html` reporter is for local browsing.
 */
export default defineConfig({
  test: {
    include: ['electron/**/*.test.ts', 'test-utils/**/*.test.ts', 'scripts/__tests__/**/*.test.ts'],
    // `*.darwin.test.ts` files load platform-specific native bindings
    // (e.g. `@mastra/libsql` → `@libsql/darwin-{arm64,x64}`) at module
    // evaluation time. Excluded on non-darwin runners so Linux CI (incl.
    // the coverage workflow) does not crash with `Cannot find module
    // '@libsql/darwin-x64'`. Kai ships macOS-only per CLAUDE.md, so the
    // contract is exercised on the `pr-mac-build` CI job.
    exclude: [
      '**/*.component.test.tsx',
      '**/*.integration.test.ts',
      '**/*.nightly.test.ts',
      'electron/__tests__/canaries/**',
      'node_modules/**',
      ...(process.platform !== 'darwin' ? ['**/*.darwin.test.ts'] : []),
    ],
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['json-summary', 'html'],
      reportsDirectory: './coverage',
      // Reporting only — no thresholds. Exclude generated, vendored, and
      // non-instrumentable surfaces so the headline number reflects the
      // code that actually ships in the main process unit slice.
      exclude: [
        // Test plumbing
        '**/__tests__/**',
        '**/__fixtures__/**',
        '**/*.test.ts',
        '**/*.test.tsx',
        'test-utils/**',
        // `vitest.*.ts` catches both root `vitest.config.ts`/`vitest.setup.ts`
        // and the slice configs (`vitest.unit.config.ts` etc.); the previous
        // `vitest.*.config.ts` entry was a redundant subset.
        'vitest.*.ts',
        // Build output and tooling
        'out/**',
        'dist/**',
        'build/**',
        'coverage/**',
        'node_modules/**',
        'scripts/**',
        // Renderer code is covered by the component slice, not here
        'src/**',
        // E2E and Playwright artifacts
        'e2e/**',
        'playwright.config.ts',
        // Native / platform-specific surfaces that v8 cannot instrument
        // meaningfully (Swift bridge stubs, native dictation hosts, etc.)
        'electron/dictation/native/**',
        // Build-time templates and configuration
        'electron-builder.template.yml',
        'electron.vite.config.ts',
        'branding.config.ts',
        'branding.d.ts',
        '**/*.d.ts',
      ],
    },
  },
  define: brandDefines,
});

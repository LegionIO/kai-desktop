/**
 * Setup file for the real-API integration slice. Loaded by
 * vitest.integration.config.ts AFTER the global vitest.setup.ts.
 *
 * Purpose: the global setup installs an HTTP egress firewall that blocks
 * provider hostnames so the rest of the suite stays hermetic. The real-API
 * smoke tests are the one place that explicitly opts INTO real provider
 * traffic — but only when `RUN_REAL_API_TESTS=1` is set (the nightly
 * workflow exports it; local `pnpm test:unit` and `pnpm test:integration`
 * runs do not).
 *
 * When that gate is set, we restore `globalThis.fetch` to undici's stock
 * fetch implementation, which is what Node ships under the hood anyway.
 * This restores real network behavior for THIS slice only without touching
 * the global vitest.setup.ts file.
 *
 * When the gate is NOT set, the firewall stays in place; every `*.real.test.ts`
 * file's own `describe.skipIf(...)` short-circuit means no test will issue
 * traffic — but leaving the firewall installed is the safer default for
 * defense-in-depth.
 */

import { fetch as undiciFetch } from 'undici';

if (process.env.RUN_REAL_API_TESTS === '1') {
  // Undici's fetch is the same implementation Node's stock `globalThis.fetch`
  // wraps; assigning it directly back to the global undoes the firewall.
  // `as unknown as typeof globalThis.fetch` because undici's fetch types are
  // structurally compatible but the WHATWG types diverge on edge fields.
  globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;
}

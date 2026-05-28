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
 * Load-order contract: this file MUST run after `vitest.setup.ts` so the
 * firewall stamp exists before we clobber `globalThis.fetch`. The order
 * is fixed by the `setupFiles` array in `vitest.integration.config.ts`;
 * we assert the stamp below as a fail-loud guard against future
 * reorderings.
 *
 * When the gate is NOT set, the firewall stays in place; every
 * `*.real.test.ts` file's own `describe.skipIf(...)` short-circuit means
 * no test will issue traffic — but leaving the firewall installed is the
 * safer default for defense-in-depth.
 */

import { fetch as undiciFetch } from 'undici';
import { HTTP_FIREWALL_INSTALLED_SYMBOL } from '../../../test-utils/blocked-hosts.js';

if (process.env.RUN_REAL_API_TESTS === '1') {
  // Defence in depth: refuse to restore if the firewall stamp is missing.
  // That state means vitest.setup.ts didn't run before this file (e.g. a
  // future reorder of `setupFiles`) or a transitive dep stamped over
  // `globalThis.fetch` after the firewall installed. Either case is a
  // configuration bug that must surface loudly — silently restoring would
  // leave a hole.
  const stampedFetch = globalThis.fetch as unknown as Record<symbol, unknown>;
  if (!stampedFetch?.[HTTP_FIREWALL_INSTALLED_SYMBOL]) {
    throw new Error(
      'setup-real-api: HTTP egress firewall stamp not found on globalThis.fetch — refusing ' +
        'to restore the real undici fetch. Check setupFiles ordering in vitest.integration.config.ts ' +
        '(vitest.setup.ts MUST come before setup-real-api.ts).',
    );
  }

  // Undici's fetch is the same implementation Node's stock `globalThis.fetch`
  // wraps; assigning it directly back to the global undoes the firewall.
  // The `as unknown as typeof globalThis.fetch` cast bridges the gap
  // between undici's Response type (which exposes `arrayBuffer` differently)
  // and lib.dom's Response type. The two are structurally compatible at
  // runtime — only the TypeScript declarations diverge.
  globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;
}

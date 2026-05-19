/**
 * Global vitest setup. Imported via `setupFiles` in vitest.config.ts.
 *
 * Provides deterministic globals (system time, UUIDs) and module-level stubs
 * (node-pty) so individual tests don't have to repeat the same scaffolding.
 *
 * Note: msw's HTTP mock server is NOT installed globally — see the comment
 * on the `httpMock` export below. Tests that need HTTP mocking opt in by
 * registering handlers through `httpMock.use(...)`; the canary suite calls
 * `httpMock.server.listen()` / `close()` in its own setup so the rest of
 * the suite never sees the fetch interceptor.
 */

import { vi, beforeEach, afterEach } from 'vitest';
import { setupHttpMock } from './test-utils/http-mock.js';

// Freeze system time globally so date-dependent assertions are deterministic.
beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});

// Spy on crypto.randomUUID so tests can assert against deterministic IDs.
// Tests that need real UUIDs can call `vi.unstubAllGlobals()` themselves.
let __uuidCounter = 0;
vi.stubGlobal('crypto', {
  ...globalThis.crypto,
  randomUUID: vi.fn(
    () =>
      `00000000-0000-0000-0000-${String(++__uuidCounter).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`,
  ),
});

// Stub node-pty globally — the real PTY only runs in the macOS node-pty smoke job.
vi.mock('@lydell/node-pty', async () => {
  const { createPtyStub } = await import('./test-utils/pty-stub.js');
  const stub = createPtyStub();
  return {
    spawn: vi.fn(() => stub.ptyProcess),
    // Tests that need fine-grained control over events can import this.
    __stub: stub,
  };
});

// ── HTTP mocking ──────────────────────────────────────────────────────────
// Single shared msw harness, exported but not started here.
//
// Why not start it globally? msw 2.x patches `globalThis.fetch` via
// `@mswjs/interceptors`. That interceptor breaks chunked-transfer / SSE
// responses on loopback connections — tests that spin up a local MCP
// server and stream tool events back to a client transport hang because
// the wrapped response body never flushes. Even `'bypass'` mode keeps the
// fetch wrapper installed.
//
// Per-suite opt-in is the documented escape hatch: call
// `httpMock.server.listen({ onUnhandledRequest: 'error' })` inside a
// `beforeAll` and `httpMock.server.close()` in `afterAll`. The canary
// tests under `electron/__tests__/canaries/` do exactly that.
//
// Fail-closed for real providers is still in effect via the DNS firewall
// below (L2) and per-test `expectHit` / `expectNoUnhandled` assertions in
// suites that do opt in (L1). Plus the canary tests themselves serve as
// the L3 watchdog against handler drift.
export const httpMock = setupHttpMock();

// Reset hit counters between tests in case a suite holds the server open
// across multiple tests.
afterEach(() => {
  httpMock.reset();
});

// ── DNS firewall (L2 watchdog) ────────────────────────────────────────────
// Hard guard against the known provider hostnames. Patches
// `node:dns.lookup` so anything that resolves these hostnames — fetch,
// undici, the AWS SDK's raw http.request — gets ENOTFOUND before a packet
// goes out. This is now the primary fail-closed mechanism since msw is
// opt-in.
const BLOCKED_HOSTS = [
  /^api\.anthropic\.com$/,
  /^api\.openai\.com$/,
  /^bedrock-runtime\.[^.]+\.amazonaws\.com$/,
  /^[^.]+\.openai\.azure\.com$/,
];

try {
  const dns = await import('node:dns');
  const origLookup = dns.lookup;
  const wrappedLookup = ((
    hostname: string,
    options: unknown,
    cb?: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ) => {
    if (BLOCKED_HOSTS.some((re) => re.test(hostname))) {
      const callback = typeof options === 'function' ? (options as typeof cb) : cb;
      const err = new Error(
        `HTTP mock watchdog (DNS firewall): real provider DNS resolution blocked for ${hostname}. ` +
          `Register an msw handler in your test or call httpMock.use(...).`,
      ) as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      if (callback) callback(err, '', 0);
      return;
    }
    // @ts-expect-error variadic delegation
    return origLookup(hostname, options, cb);
  }) as unknown as typeof dns.lookup;

  Object.defineProperty(dns, 'lookup', {
    configurable: true,
    writable: true,
    value: wrappedLookup,
  });
} catch {
  // dns module unavailable — fall back to L1 + L3 watchdogs only.
}

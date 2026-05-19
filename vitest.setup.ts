/**
 * Global vitest setup. Imported via `setupFiles` in vitest.config.ts.
 *
 * Provides deterministic globals (system time, UUIDs), module-level stubs
 * (node-pty), and an HTTP mocking server (msw) so individual tests don't
 * have to repeat the same scaffolding.
 */

import { vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
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
// Single shared msw server for the whole vitest worker. Tests import this
// `httpMock` instead of calling `setupHttpMock()` themselves so handlers and
// watchdog state are wired into the lifecycle below.
export const httpMock = setupHttpMock();

// `unhandledRequest: 'error'` makes any HTTP request that no handler claims
// fail the test loudly — egress-leak fail-closed.
beforeAll(() => {
  httpMock.server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  httpMock.server.resetHandlers();
  httpMock.reset();
});

afterAll(() => {
  httpMock.server.close();
});

// ── DNS firewall (L2 watchdog) ────────────────────────────────────────────
// Best-effort guard against real provider hostnames leaking through any test
// path that bypasses fetch (e.g. the AWS SDK using a raw http.request). We
// patch node:dns.lookup so the known provider DNS names resolve to a closed
// loopback port. msw itself intercepts before DNS for fetch, so this layer
// only catches non-fetch escapes.
//
// If a clean implementation can't keep msw happy we silently skip this — the
// per-test call-count assertions (L1) and the canary tests (L3) still gate
// real egress.
const BLOCKED_HOSTS = [
  /^api\.anthropic\.com$/,
  /^api\.openai\.com$/,
  /^bedrock-runtime\.[^.]+\.amazonaws\.com$/,
  /^[^.]+\.openai\.azure\.com$/,
];

try {
  // Loaded lazily so test environments without `node:dns` don't crash.
  const dns = await import('node:dns');
  const origLookup = dns.lookup;
  const wrappedLookup = ((
    hostname: string,
    options: unknown,
    cb?: (
      err: NodeJS.ErrnoException | null,
      address: string,
      family: number,
    ) => void,
  ) => {
    if (BLOCKED_HOSTS.some((re) => re.test(hostname))) {
      const callback =
        typeof options === 'function' ? (options as typeof cb) : cb;
      const err = new Error(
        `HTTP mock watchdog (DNS firewall): real provider DNS resolution blocked for ${hostname}. ` +
          `Register an msw handler in your test or set KAI_HTTP_MOCK_BACKEND=msw.`,
      ) as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      if (callback) callback(err, '', 0);
      return;
    }
    // Delegate to the real lookup for everything else.
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

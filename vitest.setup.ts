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

// ── HTTP egress firewall (L2 watchdog) ────────────────────────────────────
// Wraps `globalThis.fetch` so any request to a known provider hostname
// fails-closed with an ECONNREFUSED-shaped error before bytes go out. This
// is the primary fail-closed mechanism since msw is opt-in (see the comment
// above the `httpMock` export).
//
// Coordination with msw:
//   • This wrapper installs once at module load.
//   • Suites that need real HTTP mocking call `httpMock.server.listen()` in
//     their own `beforeAll`. msw replaces `globalThis.fetch` with its own
//     interceptor at that point, capturing OUR wrapper as the passthrough
//     target. Registered handlers serve responses; unregistered requests
//     either surface msw's `onUnhandledRequest: 'error'` (when the suite
//     opts into that) or fall through to our wrapper and get blocked.
//   • Suites that do NOT call `server.listen()` see our wrapper as the
//     front line. Any provider-bound fetch throws immediately.
//
// Why `globalThis.fetch` and not `node:dns`? Node 22 marks
// `dns.lookup` non-configurable, and the previous `Object.defineProperty`
// approach silently failed (the try/catch swallowed the TypeError). The
// `fetch` global is writable and is what every SDK in this repo routes
// through, so wrapping it is both reliable and easy to verify.
const BLOCKED_HOSTS: Array<string | RegExp> = [
  'api.anthropic.com',
  'api.openai.com',
  /^bedrock-runtime\.[^.]+\.amazonaws\.com$/,
  /^[^.]+\.openai\.azure\.com$/,
];

function isBlockedHostname(hostname: string): boolean {
  return BLOCKED_HOSTS.some((pattern) => (typeof pattern === 'string' ? hostname === pattern : pattern.test(hostname)));
}

function extractHostname(input: RequestInfo | URL): string | null {
  try {
    if (typeof input === 'string') return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    // Request object – has a `url` string.
    return new URL((input as Request).url).hostname;
  } catch {
    return null;
  }
}

/**
 * Marker so tests can recognise a firewall-injected error vs. a real
 * network error. The new dns-firewall canary asserts on this.
 */
export const HTTP_FIREWALL_ERROR_CODE = 'ECONNREFUSED';

function makeFirewallError(hostname: string): Error & { code: string } {
  const err = new Error(
    `HTTP egress firewall: real provider request blocked for ${hostname}. ` +
      `Egress to provider hostname blocked — install msw handlers or add hostname to allowlist. ` +
      `(See vitest.setup.ts BLOCKED_HOSTS.)`,
  ) as Error & { code: string };
  err.code = HTTP_FIREWALL_ERROR_CODE;
  return err;
}

const __realFetch = globalThis.fetch.bind(globalThis);
const __firewallFetch: typeof globalThis.fetch = async (input, init) => {
  const hostname = extractHostname(input as RequestInfo | URL);
  if (hostname && isBlockedHostname(hostname)) {
    throw makeFirewallError(hostname);
  }
  return __realFetch(input as RequestInfo | URL, init);
};
globalThis.fetch = __firewallFetch;

// Fail-loud install self-test. If the wrapper isn't actually attached (e.g.
// future Node makes `fetch` non-configurable or a transitive dep stamps over
// it after this file runs), the suite must refuse to start rather than
// quietly let traffic out.
{
  let blocked = false;
  try {
    await globalThis.fetch('https://api.anthropic.com/_canary_probe');
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code === HTTP_FIREWALL_ERROR_CODE) {
      blocked = true;
    }
  }
  if (!blocked) {
    throw new Error('HTTP egress firewall failed to install — test hermeticity compromised. ' + 'See vitest.setup.ts.');
  }
}

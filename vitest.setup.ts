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
import type * as Undici from 'undici';
import { setupHttpMock } from './test-utils/http-mock.js';
import {
  BLOCKED_HOSTS,
  HTTP_FIREWALL_ERROR_CODE,
  HTTP_FIREWALL_INSTALLED_SYMBOL,
  extractHostname,
  isBlockedHostname,
  makeFirewallError,
} from './test-utils/blocked-hosts.js';

// Freeze system time globally so date-dependent assertions are deterministic.
beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});

// Kai is a macOS-only product. Several modules under test guard native paths with
// `process.platform === 'darwin'`. CI runs on Linux runners, so force the platform
// to darwin here to keep platform-gated code paths exercised everywhere tests run.
//
// DOM-specific setup is handled in a separate setupFile (`test-utils/jest-dom-setup.ts`)
// loaded only by `vitest.component.config.ts`; don't duplicate it here.
if (process.platform !== 'darwin') {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
}

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
// Defence-in-depth against `undici` direct imports: the L2 wrapper only
// covers `globalThis.fetch`. A test calling `import { request } from 'undici'`
// would bypass it. The `vi.mock('undici', …)` block below routes every
// undici client API through the same firewall check.
//
// Why `globalThis.fetch` and not `node:dns`? Node 22 marks
// `dns.lookup` non-configurable, and the previous `Object.defineProperty`
// approach silently failed (the try/catch swallowed the TypeError). The
// `fetch` global is writable and is what every SDK in this repo routes
// through, so wrapping it is both reliable and easy to verify.

// Re-export so canary suites that still import these from `vitest.setup.ts`
// keep compiling. New code should import from `test-utils/blocked-hosts.ts`.
export { HTTP_FIREWALL_ERROR_CODE, HTTP_FIREWALL_INSTALLED_SYMBOL };

const __realFetch = globalThis.fetch.bind(globalThis);
const __firewallFetch: typeof globalThis.fetch = async (input, init) => {
  const hostname = extractHostname(input as RequestInfo | URL);
  if (hostname && isBlockedHostname(hostname)) {
    throw makeFirewallError(hostname, 'fetch');
  }
  return __realFetch(input as RequestInfo | URL, init);
};

// Stamp the wrapper so any later setup file that reassigns `globalThis.fetch`
// (e.g. `electron/__tests__/integration-real/setup-real-api.ts`) can assert
// the firewall was actually installed before replacing it.
(__firewallFetch as unknown as Record<symbol, unknown>)[HTTP_FIREWALL_INSTALLED_SYMBOL] = true;
globalThis.fetch = __firewallFetch;

// ── undici guard ──────────────────────────────────────────────────────────
// `globalThis.fetch` wrapping above only catches code that uses the global.
// A test or transitive dep that does `import { request } from 'undici'` (or
// `new Pool(...)`, `new Agent(...)`) bypasses the global entirely. Route
// every undici client API through the same blocked-host check.
//
// `fetch` from undici is wired to delegate to `globalThis.fetch` so the L2
// wrapper above still runs; the rest throw the firewall error eagerly.
//
// Tests that genuinely need real provider HTTP (the `integration-real/`
// suite) opt in by re-assigning `globalThis.fetch = undiciFetch` inside
// their own setup file — at which point this mock is still active for
// `request`/`stream`/etc but `fetch` is bypassed via the global swap.
vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof Undici>('undici');

  type FetchInput = Parameters<typeof actual.fetch>[0];
  type FetchInit = Parameters<typeof actual.fetch>[1];

  // undici's Response type narrows differently from lib.dom Response; cast
  // through `unknown` so the dual-shape return doesn't trip the strict
  // structural compatibility check.
  const wrappedFetch = ((input: FetchInput, init?: FetchInit) =>
    globalThis.fetch(
      input as unknown as RequestInfo | URL,
      init as RequestInit | undefined,
    )) as unknown as typeof actual.fetch;

  const guard = (url: unknown, source: string): void => {
    const hostname = extractHostname(url);
    if (hostname && isBlockedHostname(hostname)) {
      throw makeFirewallError(hostname, source);
    }
  };

  const guardedRequest: typeof actual.request = ((url: unknown, opts?: unknown) => {
    guard(url, 'undici.request');
    return (actual.request as unknown as (u: unknown, o?: unknown) => unknown)(url, opts);
  }) as typeof actual.request;

  const guardedStream: typeof actual.stream = ((url: unknown, opts: unknown, factory: unknown) => {
    guard(url, 'undici.stream');
    return (actual.stream as unknown as (u: unknown, o: unknown, f: unknown) => unknown)(url, opts, factory);
  }) as typeof actual.stream;

  const guardedPipeline: typeof actual.pipeline = ((url: unknown, opts: unknown, handler: unknown) => {
    guard(url, 'undici.pipeline');
    return (actual.pipeline as unknown as (u: unknown, o: unknown, h: unknown) => unknown)(url, opts, handler);
  }) as typeof actual.pipeline;

  const guardedConnect: typeof actual.connect = ((opts: unknown, callback?: unknown) => {
    const target =
      typeof opts === 'string'
        ? opts
        : opts && typeof opts === 'object' && 'origin' in (opts as Record<string, unknown>)
          ? (opts as { origin: unknown }).origin
          : null;
    guard(target, 'undici.connect');
    return (actual.connect as unknown as (o: unknown, c?: unknown) => unknown)(opts, callback);
  }) as typeof actual.connect;

  // Pool / Client / Agent: throw on construction if origin is blocked.
  class GuardedPool extends actual.Pool {
    constructor(origin: string | URL, opts?: ConstructorParameters<typeof actual.Pool>[1]) {
      guard(origin, 'undici.Pool');
      super(origin, opts);
    }
  }

  class GuardedClient extends actual.Client {
    constructor(origin: string | URL, opts?: ConstructorParameters<typeof actual.Client>[1]) {
      guard(origin, 'undici.Client');
      super(origin, opts);
    }
  }

  return {
    ...actual,
    fetch: wrappedFetch,
    request: guardedRequest,
    stream: guardedStream,
    pipeline: guardedPipeline,
    connect: guardedConnect,
    Pool: GuardedPool,
    Client: GuardedClient,
  };
});

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
    throw new Error(
      'HTTP egress firewall failed to install — test hermeticity compromised. ' +
        'See vitest.setup.ts / test-utils/blocked-hosts.ts.',
    );
  }
  // Sanity: the stamp must round-trip. If a transitive dep clobbered fetch
  // between install and this assertion, we want to know.
  if (!(globalThis.fetch as unknown as Record<symbol, unknown>)[HTTP_FIREWALL_INSTALLED_SYMBOL]) {
    throw new Error(
      'HTTP egress firewall stamp missing on globalThis.fetch — a transitive dep replaced fetch ' +
        'after install. See test-utils/blocked-hosts.ts HTTP_FIREWALL_INSTALLED_SYMBOL.',
    );
  }
}

// Suppress unused-import warning on BLOCKED_HOSTS (re-exported for canary tests).
export { BLOCKED_HOSTS };

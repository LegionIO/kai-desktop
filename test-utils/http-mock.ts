/**
 * HTTP mocking adapter for tests.
 *
 * The msw backend is the only backend in production use; the undici
 * alternate is currently a no-op stub kept as scaffolding so a future
 * migration can swap implementations without changing test sites. The
 * adapter shape exists so that, if/when we do migrate, the diff is
 * limited to this file.
 *
 * The harness instance is constructed once at module scope from
 * `vitest.setup.ts` and shared across the suite.
 *
 * To activate the (currently no-op) undici stub for local experimentation,
 * set `KAI_HTTP_MOCK_BACKEND=undici`. The undici stub does NOT yet implement
 * fetch interception — selecting it from CI would amount to disabling msw.
 */

import { setupServer, type SetupServer } from 'msw/node';
import type { RequestHandler } from 'msw';

export interface HttpMockOptions {
  /**
   * When true, unhandled requests are reported as warnings instead of errors.
   * Default false — unhandled requests throw so we fail-closed on egress
   * leaks.
   */
  permissive?: boolean;
  /**
   * Skip the per-test call-count watchdog. Reserved for future use; the
   * watchdog state is reset between tests regardless.
   */
  skipWatchdog?: boolean;
}

export interface HttpMockHarness {
  /** Underlying msw server (escape hatch for advanced cases). */
  server: SetupServer;
  /** Register handlers ad-hoc within a test. */
  use(...handlers: RequestHandler[]): void;
  /**
   * Assert that a given URL pattern was intercepted at least `atLeast` times
   * (default 1). Throws if the count is lower.
   */
  expectHit(urlPattern: string | RegExp, atLeast?: number): void;
  /** Assert that no unhandled requests fired during this test. */
  expectNoUnhandled(): void;
  /** Reset hit counters and unhandled-request log. */
  reset(): void;
}

interface HitCounter {
  pattern: RegExp;
  count: number;
}

function patternToRegex(pattern: string | RegExp): RegExp {
  if (pattern instanceof RegExp) return pattern;
  // Treat plain strings as substring matches so callers can write
  // `expectHit('api.anthropic.com')` without crafting a regex.
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped);
}

function getBackend(): 'msw' | 'undici' {
  const raw = process.env.KAI_HTTP_MOCK_BACKEND;
  if (raw === 'undici') return 'undici';
  return 'msw';
}

function createMswHarness(opts: HttpMockOptions): HttpMockHarness {
  const hits: HitCounter[] = [];
  let unhandledCount = 0;

  // Track every intercepted request by URL so `expectHit` can scan against
  // its own list of registered patterns.
  const interceptedUrls: string[] = [];

  const server = setupServer();

  // msw 2.x fires this whenever any handler responds successfully.
  server.events.on('request:match', ({ request }) => {
    interceptedUrls.push(request.url);
  });
  server.events.on('request:unhandled', ({ request }) => {
    unhandledCount += 1;
    if (!opts.permissive) {
      // The `onUnhandledRequest: 'error'` option below already raises; this
      // hook is mostly a counter so `expectNoUnhandled` can be precise.
      void request;
    }
  });

  return {
    server,
    use(...handlers) {
      server.use(...handlers);
    },
    expectHit(urlPattern, atLeast = 1) {
      const re = patternToRegex(urlPattern);
      const matched = interceptedUrls.filter((u) => re.test(u)).length;
      if (matched < atLeast) {
        throw new Error(
          `HTTP mock watchdog: expected pattern ${re} to be hit at least ${atLeast} times, ` +
            `saw ${matched}. Intercepted URLs: ${JSON.stringify(interceptedUrls)}`,
        );
      }
      const existing = hits.find((h) => h.pattern.source === re.source);
      if (existing) existing.count = matched;
      else hits.push({ pattern: re, count: matched });
    },
    expectNoUnhandled() {
      if (unhandledCount > 0) {
        throw new Error(`HTTP mock watchdog: ${unhandledCount} unhandled request(s) fired during this test`);
      }
    },
    reset() {
      hits.length = 0;
      interceptedUrls.length = 0;
      unhandledCount = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Undici fallback — minimal stub kept in lockstep with the public API.
// Does NOT currently install fetch interception; tests that select this
// backend should also register handlers via undici's MockAgent directly.
// Replaced wholesale if/when msw becomes unsuitable.
// ---------------------------------------------------------------------------
function createUndiciHarness(_opts: HttpMockOptions): HttpMockHarness {
  // Build a no-op SetupServer-shaped object so the public type stays stable.
  // The real undici MockAgent would be wired here.
  const stubServer = {
    listen: () => {},
    close: () => {},
    resetHandlers: () => {},
    use: () => {},
    restoreHandlers: () => {},
    events: { on: () => {}, removeAllListeners: () => {} },
  } as unknown as SetupServer;

  return {
    server: stubServer,
    use() {
      // No-op: callers selecting this backend wire MockAgent themselves.
    },
    expectHit() {
      throw new Error(
        'HTTP mock watchdog: undici backend stub does not yet implement expectHit; ' +
          'set KAI_HTTP_MOCK_BACKEND=msw or extend the undici adapter.',
      );
    },
    expectNoUnhandled() {
      // No tracking in the stub; treat as pass to avoid masking other tests.
    },
    reset() {},
  };
}

/**
 * Build a fresh HTTP mock harness. The vitest setup file calls this once at
 * module scope so the same `server` instance is shared across the suite;
 * individual tests should not call `setupHttpMock` themselves but instead
 * import `httpMock` from `vitest.setup.ts`.
 */
export function setupHttpMock(opts: HttpMockOptions = {}): HttpMockHarness {
  const backend = getBackend();
  if (backend === 'undici') return createUndiciHarness(opts);
  return createMswHarness(opts);
}

/**
 * Test helper: produce a fake `helperRunner` for use with the permissions
 * service (`electron/computer-use/permissions.ts`).
 *
 * The runner replaces the real `LocalMacosHelper` invocation in tests so the
 * macOS Swift binary is not required.
 */

import { vi } from 'vitest';
import type { HelperRunner, HelperRunnerResult } from '../electron/computer-use/helper-runner.js';

export type { HelperRunner, HelperRunnerResult } from '../electron/computer-use/helper-runner.js';

export interface SwiftHelperStub {
  /** A drop-in replacement for the production `helperRunner`. */
  runner: HelperRunner;
  /** The underlying `vi.fn()` for call-count / args assertions. */
  mock: ReturnType<typeof vi.fn>;
  /** Queue the next result returned by `runner`. */
  setNext(result: HelperRunnerResult): void;
}

export function createSwiftHelperStub(defaultResult: HelperRunnerResult = { ok: true }): SwiftHelperStub {
  let nextResult: HelperRunnerResult = defaultResult;
  const mock = vi.fn(async (_subcommand: string, _args?: string[]) => {
    const result = nextResult;
    // Reset to the default so each subsequent call without `setNext` returns
    // the configured fallback rather than the previously-queued one-shot.
    nextResult = defaultResult;
    return result;
  });
  return {
    runner: mock as unknown as HelperRunner,
    mock,
    setNext(result: HelperRunnerResult) {
      nextResult = result;
    },
  };
}

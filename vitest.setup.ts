/**
 * Global vitest setup. Imported via `setupFiles` in vitest.config.ts.
 *
 * Provides deterministic globals (system time, UUIDs) and module-level stubs
 * (node-pty) so individual tests don't have to repeat the same scaffolding.
 */

import { vi, beforeEach } from 'vitest';

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

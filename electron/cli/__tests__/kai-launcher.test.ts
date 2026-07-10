/**
 * Behavioral test for the `bin/kai` POSIX launcher shim. Runs the actual script
 * with `sh` and asserts the KAI_APP_BINARY override path (which short-circuits
 * before any OS-specific resolution, so it's deterministic on any host).
 *
 * NOTE: the OS-branch resolution (self-relative / fixed install dirs) is NOT
 * tested here — on a macOS dev host the Darwin branch finds the REAL installed
 * Kai.app (via /Applications or Spotlight) and would launch it, so those paths
 * are host-dependent. They're validated in Docker (Linux) + manually on macOS
 * instead. POSIX-only; skipped on win32 (the shim is sh).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SHIM = resolve(__dirname, '../../../bin/kai');
const isWin = process.platform === 'win32';

function runShim(env: NodeJS.ProcessEnv, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('sh', [SHIM, ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

describe.skipIf(isWin)('bin/kai POSIX launcher', () => {
  it('honors KAI_APP_BINARY override and prepends --kai-cli, passing args through', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kai-shim-'));
    try {
      const bin = join(dir, 'fakeapp');
      writeFileSync(bin, '#!/bin/sh\necho "OVERRIDE args: $*"\n', { mode: 0o755 });
      chmodSync(bin, 0o755);
      const { code, out } = runShim({ KAI_APP_BINARY: bin }, ['hello', 'world']);
      expect(code).toBe(0);
      expect(out).toContain('OVERRIDE args: --kai-cli hello world');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // NOTE: only the KAI_APP_BINARY override path is exercised. Any path that
  // reaches the shim's OS-specific resolution would, on a macOS dev host with
  // Kai installed, find and LAUNCH the real Kai.app (via /Applications or
  // Spotlight) — slow, and it pops keychain prompts. Fixed-location and
  // self-relative resolution are validated in Docker (Linux) + manually on macOS.
});

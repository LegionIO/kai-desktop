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
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SHIM = resolve(__dirname, '../../../bin/kai');
const CMD = resolve(__dirname, '../../../bin/kai.cmd');
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

/**
 * Contract test for the Windows `bin/kai.cmd` launcher. cmd.exe cannot be run
 * on a non-Windows host (and Wine has no arm64 build), and no Windows VM is
 * reachable from CI, so we can't execute it end-to-end here. Instead we assert
 * the batch file's load-bearing INVARIANTS against its text — the same contract
 * the Linux launcher proves by execution (scripts/validate-linux-launcher.sh):
 * the 4-tier resolution order, `--kai-cli %*` forwarding, not-found → exit 127
 * with guidance, plus two Windows-specific correctness guards that are easy to
 * regress silently. This runs on every platform so an edit to kai.cmd that
 * breaks the contract fails a normal `pnpm test`, not only a Windows smoke run.
 */
describe('bin/kai.cmd Windows launcher contract', () => {
  const cmd = readFileSync(CMD, 'utf-8');

  it('resolves the app exe in the documented 4-tier order', () => {
    // 1. explicit KAI_APP_BINARY override
    expect(cmd).toMatch(/if defined KAI_APP_BINARY/i);
    // 2. self-relative: <app>\resources\bin\kai.cmd -> <app>\Kai.exe (two dirs up)
    expect(cmd).toMatch(/%~dp0\.\.\\\.\./);
    expect(cmd).toMatch(/%APP_DIR%\\Kai\.exe/i);
    // 3. fixed install locations (per-user then machine-wide)
    expect(cmd).toMatch(/%LOCALAPPDATA%\\Programs\\Kai\\Kai\.exe/i);
    expect(cmd).toMatch(/%ProgramFiles%\\Kai\\Kai\.exe/i);
  });

  it('forwards --kai-cli then all args to the resolved exe', () => {
    expect(cmd).toMatch(/"%KAI_EXE%"\s+--kai-cli\s+%\*/);
  });

  it('fails with exit 127 + guidance when nothing resolves', () => {
    expect(cmd).toMatch(/exit \/b 127/i);
    expect(cmd.toLowerCase()).toContain('could not locate the kai app binary');
    // The override-guidance so a user knows the escape hatch.
    expect(cmd).toMatch(/KAI_APP_BINARY/);
  });

  it('propagates the app exit code (exit /b %ERRORLEVEL% at top level)', () => {
    expect(cmd).toMatch(/exit \/b %ERRORLEVEL%/i);
    // The real invoke must NOT be inside a parenthesized block, or %ERRORLEVEL%
    // would expand at parse-time to a stale value. Assert the invoke line is not
    // indented under an `if (` block (it sits at column 0).
    expect(cmd).toMatch(/\n"%KAI_EXE%" --kai-cli %\*/);
  });

  it('disables delayed expansion so paths/args with "!" are not corrupted', () => {
    expect(cmd).toMatch(/setlocal\s+DisableDelayedExpansion/i);
  });
});

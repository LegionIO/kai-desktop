/**
 * Test for scripts/check-lockfile-registry.mjs — the pre-commit guard that keeps
 * the committed pnpm-lock.yaml registry-agnostic (integrity-only), so it works
 * across public npm AND the on-prem Optum mirror. The registry host(s) are read
 * from the live pnpm config (not hardcoded), so the guard here runs the real
 * script against temp lockfiles via a spawned process.
 *
 * We can't easily inject a fake pnpm config from the test, so the "catches a
 * registry URL" case uses a KNOWN public-registry host that the tarball-field
 * rule catches independent of config (any `tarball: https://…`), plus asserts
 * the clean repo lockfile passes.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'check-lockfile-registry.mjs');
const REPO_ROOT = join(__dirname, '..', '..');

/** Run the guard with a given pnpm-lock.yaml content in an isolated repo dir.
 *  Returns { code, out }. The script resolves the lockfile relative to its OWN
 *  location, so we copy it into a temp "scripts/" sibling of the fixture. */
function runGuard(lockContent: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lockguard-'));
  try {
    const scriptsDir = join(dir, 'scripts');
    execFileSync('mkdir', ['-p', scriptsDir]);
    copyFileSync(SCRIPT, join(scriptsDir, 'check-lockfile-registry.mjs'));
    // Copy the repo package.json so corepack resolves pnpm from the pinned
    // `packageManager` field (this corporate network can't reach npmjs.org to
    // auto-download pnpm). The guard tolerates pnpm being unavailable anyway —
    // this just keeps the test's `pnpm config` call from spewing corepack noise.
    copyFileSync(join(REPO_ROOT, 'package.json'), join(dir, 'package.json'));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), lockContent);
    try {
      const out = execFileSync('node', [join(scriptsDir, 'check-lockfile-registry.mjs')], {
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-lockfile-registry guard', () => {
  it('passes an integrity-only lockfile (no baked-in URLs)', () => {
    const clean = [
      "lockfileVersion: '9.0'",
      'packages:',
      '  foo@1.0.0:',
      '    resolution: {integrity: sha512-AAAA==}',
    ].join('\n');
    expect(runGuard(clean).code).toBe(0);
  });

  it('allows a benign deprecated-message npmjs.com/support URL', () => {
    const withDeprecated = [
      'packages:',
      '  bar@2.0.0:',
      '    resolution: {integrity: sha512-BBBB==}',
      '    deprecated: Package no longer supported. Contact Support at https://www.npmjs.com/support for more info.',
    ].join('\n');
    // npmjs.com/support is not a registry-tarball host and isn't a `tarball:` field.
    expect(runGuard(withDeprecated).code).toBe(0);
  });

  it('FAILS a lockfile with a baked-in tarball URL', () => {
    const withTarball = [
      'packages:',
      '  baz@3.0.0:',
      "    resolution: {tarball: 'https://example-registry.internal/api/npm/x/-/baz-3.0.0.tgz'}",
    ].join('\n');
    const r = runGuard(withTarball);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/tarball URL/i);
  });

  it('the actual committed repo lockfile is registry-agnostic', () => {
    // Run the guard against the real repo lockfile in-place (its true home).
    try {
      execFileSync('node', [SCRIPT], { encoding: 'utf8', cwd: REPO_ROOT });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      throw new Error(
        `repo pnpm-lock.yaml failed the registry-agnostic guard:\n${err.stdout ?? ''}${err.stderr ?? ''}`,
      );
    }
  });
});

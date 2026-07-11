/**
 * Tests for the pure/sync surface of shell-env.ts — binary resolution and
 * resolved-process-env construction that spawned CLI tools/agents depend on.
 *
 * NOTE on the search PATH: resolveBinaryPathSync searches
 * getResolvedProcessEnv(env).PATH, and getResolvedProcessEnv OVERRIDES the
 * passed env's PATH with getResolvedShellPathSync() (the cached resolved PATH,
 * or process.env.PATH when no cache). So the search PATH is driven by
 * process.env.PATH here — not by the `env` arg's PATH (whose non-PATH vars are
 * still preserved for the spawn-env use case). Tests set process.env.PATH.
 *
 * The async login-shell probe (execFile) is not exercised (needs a real shell).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, delimiter } from 'path';
import { resolveBinaryPathSync, binaryExistsInResolvedPath, getResolvedProcessEnv } from '../shell-env.js';

let dir: string;
let originalPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kai-shellenv-'));
  originalPath = process.env.PATH;
  process.env.PATH = dir; // drive the resolved search PATH deterministically
});
afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(dir, { recursive: true, force: true });
});

function makeExecutable(name: string, targetDir = dir): string {
  const p = join(targetDir, name);
  writeFileSync(p, '#!/bin/sh\necho hi\n');
  chmodSync(p, 0o755);
  return p;
}

describe('resolveBinaryPathSync', () => {
  it('returns null for a blank/whitespace name', () => {
    expect(resolveBinaryPathSync('')).toBeNull();
    expect(resolveBinaryPathSync('   ')).toBeNull();
  });

  it('resolves a bare name found on the resolved PATH', () => {
    makeExecutable('mytool');
    expect(resolveBinaryPathSync('mytool')).toBe(join(dir, 'mytool'));
  });

  it('returns null when a matching name is present but not executable (POSIX)', () => {
    if (process.platform === 'win32') return;
    const p = join(dir, 'nope');
    writeFileSync(p, 'data');
    chmodSync(p, 0o644);
    expect(resolveBinaryPathSync('nope')).toBeNull();
  });

  it('returns null when the name is not on PATH at all', () => {
    expect(resolveBinaryPathSync('ghost-binary-xyz')).toBeNull();
  });

  it('treats a name containing a separator as an explicit path (executable → returned, else null)', () => {
    const exe = makeExecutable('direct');
    expect(resolveBinaryPathSync(exe)).toBe(exe);
    expect(resolveBinaryPathSync(join(dir, 'missing'))).toBeNull();
  });

  it('does NOT resolve a directory as an executable (isFile guard)', () => {
    if (process.platform === 'win32') return; // X_OK/F_OK semantics differ
    // A subdirectory named like a binary must not resolve as executable.
    mkdirSync(join(dir, 'subdirtool'));
    expect(resolveBinaryPathSync('subdirtool')).toBeNull();
    // And an explicit path to a directory is not "executable".
    expect(resolveBinaryPathSync(dir)).toBeNull();
  });

  it('searches multiple resolved PATH entries in order (first match wins)', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'kai-shellenv2-'));
    try {
      makeExecutable('t'); // in `dir` (first on PATH)
      makeExecutable('t', dir2); // also in dir2
      process.env.PATH = [dir, dir2].join(delimiter);
      expect(resolveBinaryPathSync('t')).toBe(join(dir, 't'));
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe('binaryExistsInResolvedPath', () => {
  it('is true when resolvable, false otherwise', () => {
    makeExecutable('present');
    expect(binaryExistsInResolvedPath('present')).toBe(true);
    expect(binaryExistsInResolvedPath('absent-binary-xyz')).toBe(false);
  });
});

describe('getResolvedProcessEnv', () => {
  it('preserves the input env non-PATH vars and overrides PATH with the resolved shell PATH', () => {
    const resolved = getResolvedProcessEnv({ PATH: '/should/be/overridden', MY_VAR: 'keep' } as NodeJS.ProcessEnv);
    // Non-PATH vars survive.
    expect(resolved.MY_VAR).toBe('keep');
    // PATH is the resolved shell PATH (driven by process.env.PATH = dir here),
    // NOT the passed env's PATH.
    expect(typeof resolved.PATH).toBe('string');
    expect((resolved.PATH ?? '').split(delimiter)).toContain(dir);
    expect((resolved.PATH ?? '').split(delimiter)).not.toContain('/should/be/overridden');
  });
});

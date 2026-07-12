/**
 * Tests for safeReadFileWithin (electron/utils/safe-file-read.ts) — the
 * symlink/TOCTOU-safe bounded file read used by the main-process media protocol
 * handler. It must read regular files inside the root, and refuse (return null)
 * for symlinks that escape the root, paths outside the root, directories, and
 * missing files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { safeReadFileWithin } from '../safe-file-read.js';

let root: string;
let outside: string;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'kai-safe-read-'));
  root = join(base, 'root');
  outside = join(base, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
});
afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }));

describe('safeReadFileWithin', () => {
  it('reads a regular file inside the root', () => {
    const f = join(root, 'ok.txt');
    writeFileSync(f, 'hello');
    expect(safeReadFileWithin(root, f)?.toString()).toBe('hello');
  });

  it('reads a nested file inside the root', () => {
    mkdirSync(join(root, 'sub'), { recursive: true });
    const f = join(root, 'sub', 'nested.bin');
    writeFileSync(f, Buffer.from([1, 2, 3, 4]));
    expect([...(safeReadFileWithin(root, f) ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it('returns null for a missing file', () => {
    expect(safeReadFileWithin(root, join(root, 'nope.txt'))).toBeNull();
  });

  it('returns null for a directory', () => {
    expect(safeReadFileWithin(root, root)).toBeNull();
  });

  it('returns null for a path outside the root', () => {
    const f = join(outside, 'secret.txt');
    writeFileSync(f, 'secret');
    expect(safeReadFileWithin(root, f)).toBeNull();
  });

  it('refuses a symlink inside the root that points OUTSIDE it (escape)', () => {
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'top-secret');
    const link = join(root, 'escape.txt');
    symlinkSync(secret, link);
    // realpath(link) resolves outside root -> containment fails -> null.
    expect(safeReadFileWithin(root, link)).toBeNull();
  });

  it('follows a symlink whose target is itself inside the root (realpath stays contained)', () => {
    const target = join(root, 'real.txt');
    writeFileSync(target, 'inside');
    const link = join(root, 'link.txt');
    symlinkSync(target, link);
    // realpath(link) resolves to real.txt (inside root) BEFORE the O_NOFOLLOW
    // open, so containment passes and the canonical (non-symlink) file is read.
    // O_NOFOLLOW only guards a swap between the realpath check and the open
    // (TOCTOU), not a pre-existing link to a legitimate in-root target.
    expect(safeReadFileWithin(root, link)?.toString()).toBe('inside');
    expect(safeReadFileWithin(root, target)?.toString()).toBe('inside');
  });
});

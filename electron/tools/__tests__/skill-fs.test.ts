/**
 * Tests for skill-fs.ts — the symlink-safe, containment-enforcing fs primitives
 * that skills use to read their manifest / bundled files and write skill-local
 * files. These are security-critical: a skill dir is user/marketplace-installed,
 * so a planted symlink at a manifest/file/write path must NOT redirect a read
 * out of the skill root (exfil) or a write out of it (arbitrary-file clobber).
 * Both use realpath + O_NOFOLLOW + a canonical containment check; lock every
 * rejection branch + the happy path + the macOS /tmp→/private symlink case.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readContainedFileSync,
  writeContainedFileSync,
  SKILL_MANIFEST_MAX_BYTES,
  SKILL_FILE_MAX_BYTES,
} from '../skill-fs.js';

let skillDir: string;
let outsideDir: string;

beforeEach(() => {
  skillDir = mkdtempSync(join(tmpdir(), 'kai-skill-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'kai-outside-'));
});
afterEach(() => {
  rmSync(skillDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe('readContainedFileSync', () => {
  it('reads a regular file inside the skill dir', () => {
    const p = join(skillDir, 'skill.json');
    writeFileSync(p, '{"name":"x"}', 'utf-8');
    expect(readContainedFileSync(skillDir, p, SKILL_MANIFEST_MAX_BYTES)).toBe('{"name":"x"}');
  });

  it('returns null for a missing file', () => {
    expect(readContainedFileSync(skillDir, join(skillDir, 'nope.json'), SKILL_MANIFEST_MAX_BYTES)).toBeNull();
  });

  it('returns null for a non-existent skill root', () => {
    expect(readContainedFileSync(join(skillDir, 'gone'), join(skillDir, 'x'), 1000)).toBeNull();
  });

  it('rejects a symlinked LEAF pointing at an out-of-tree secret (O_NOFOLLOW)', () => {
    const secret = join(outsideDir, 'secret.txt');
    writeFileSync(secret, 'SKILL_FS_SECRET', 'utf-8');
    const linkPath = join(skillDir, 'skill.json');
    symlinkSync(secret, linkPath); // manifest is a symlink out of the tree
    expect(readContainedFileSync(skillDir, linkPath, SKILL_MANIFEST_MAX_BYTES)).toBeNull();
  });

  it('rejects a symlinked leaf even when it points BACK into the skill dir (O_NOFOLLOW rejects any symlink leaf)', () => {
    const real = join(skillDir, 'real.json');
    writeFileSync(real, 'IN_TREE', 'utf-8');
    const linkPath = join(skillDir, 'skill.json');
    symlinkSync(real, linkPath);
    // O_NOFOLLOW fails on ANY symlink leaf — even an in-tree target. (Skills must
    // ship regular files, not symlinks.)
    expect(readContainedFileSync(skillDir, linkPath, SKILL_MANIFEST_MAX_BYTES)).toBeNull();
  });

  it('rejects a directory (not a regular file)', () => {
    const sub = join(skillDir, 'subdir');
    mkdirSync(sub);
    expect(readContainedFileSync(skillDir, sub, SKILL_MANIFEST_MAX_BYTES)).toBeNull();
  });

  it('rejects a file over maxBytes', () => {
    const p = join(skillDir, 'big.json');
    writeFileSync(p, 'x'.repeat(100), 'utf-8');
    expect(readContainedFileSync(skillDir, p, 10)).toBeNull();
    // ...but reads it under a larger cap.
    expect(readContainedFileSync(skillDir, p, 1000)).toHaveLength(100);
  });

  it('reads a file in a nested subdir of the skill root (contained, not a symlink)', () => {
    const sub = join(skillDir, 'assets');
    mkdirSync(sub);
    const p = join(sub, 'data.txt');
    writeFileSync(p, 'NESTED_OK', 'utf-8');
    expect(readContainedFileSync(skillDir, p, SKILL_FILE_MAX_BYTES)).toBe('NESTED_OK');
  });

  it('reads correctly even when the skill dir is under a symlinked ancestor (macOS /tmp→/private)', () => {
    // tmpdir() on macOS is often /var/folders (symlink to /private/var/...).
    // realpath on both sides must make containment pass for a genuine in-tree file.
    const p = join(skillDir, 'skill.json');
    writeFileSync(p, 'TMP_ANCESTOR_OK', 'utf-8');
    // sanity: skillDir realpath differs from its literal form on macOS
    void realpathSync(skillDir);
    expect(readContainedFileSync(skillDir, p, SKILL_MANIFEST_MAX_BYTES)).toBe('TMP_ANCESTOR_OK');
  });
});

describe('writeContainedFileSync', () => {
  it('writes a direct child of the skill dir', () => {
    const p = join(skillDir, 'out.txt');
    writeContainedFileSync(skillDir, p, 'WRITTEN');
    expect(readFileSync(p, 'utf-8')).toBe('WRITTEN');
  });

  it('throws when the parent is not the skill root (nested path)', () => {
    const sub = join(skillDir, 'nested');
    mkdirSync(sub);
    expect(() => writeContainedFileSync(skillDir, join(sub, 'x.txt'), 'data')).toThrow(/escapes/);
  });

  it('throws when the parent does not exist', () => {
    expect(() => writeContainedFileSync(skillDir, join(skillDir, 'gone', 'x.txt'), 'data')).toThrow();
  });

  it('rejects writing THROUGH a symlink at the target path (O_NOFOLLOW)', () => {
    const secret = join(outsideDir, 'target.txt');
    writeFileSync(secret, 'ORIGINAL', 'utf-8');
    const linkPath = join(skillDir, 'evil.txt');
    symlinkSync(secret, linkPath); // planted symlink at the write target
    expect(() => writeContainedFileSync(skillDir, linkPath, 'HIJACKED')).toThrow();
    // The out-of-tree target must be untouched.
    expect(readFileSync(secret, 'utf-8')).toBe('ORIGINAL');
  });

  it('throws when the parent dir is a symlink pointing outside the skill root', () => {
    // skillDir/link -> outsideDir; writing skillDir/link/x.txt must be rejected
    // because realpath(parent) leaves the skill root.
    const linkDir = join(skillDir, 'linkdir');
    symlinkSync(outsideDir, linkDir);
    expect(() => writeContainedFileSync(skillDir, join(linkDir, 'x.txt'), 'data')).toThrow(/escapes/);
  });
});

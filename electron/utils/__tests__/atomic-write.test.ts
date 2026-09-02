import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  symlinkSync,
  lstatSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { atomicWriteFile, atomicWriteFileSync, isUnsupportedDirFsyncError } from '../atomic-write.js';

describe('isUnsupportedDirFsyncError (dir-fsync log classification)', () => {
  it('classifies as unsupported only the errnos that mean "directory fsync unsupported"', () => {
    for (const code of ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF', 'EISDIR']) {
      expect(isUnsupportedDirFsyncError(Object.assign(new Error(code), { code }))).toBe(true);
    }
  });

  it('does NOT classify access-control or genuine I/O failures as "unsupported"', () => {
    // These get the "failed (write already committed)" log message; NONE propagate
    // — the dir-fsync is best-effort AFTER the rename has committed the write (R28P25).
    for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EROFS', 'EDQUOT', undefined]) {
      expect(isUnsupportedDirFsyncError(Object.assign(new Error(String(code)), code ? { code } : {}))).toBe(false);
    }
    expect(isUnsupportedDirFsyncError('not an error')).toBe(false);
    expect(isUnsupportedDirFsyncError(undefined)).toBe(false);
  });
});

describe('atomicWriteFileSync', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes new file contents', () => {
    const dest = join(dir, 'out.json');
    atomicWriteFileSync(dest, '{"a":1}');
    expect(readFileSync(dest, 'utf-8')).toBe('{"a":1}');
  });

  it('overwrites an existing file', () => {
    const dest = join(dir, 'out.json');
    writeFileSync(dest, 'old');
    atomicWriteFileSync(dest, 'new');
    expect(readFileSync(dest, 'utf-8')).toBe('new');
  });

  it('leaves no temp file behind on success', () => {
    const dest = join(dir, 'out.json');
    atomicWriteFileSync(dest, 'data');
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('accepts a Uint8Array payload', () => {
    const dest = join(dir, 'bin');
    atomicWriteFileSync(dest, new Uint8Array([1, 2, 3]));
    expect([...readFileSync(dest)]).toEqual([1, 2, 3]);
  });

  it('writes durably with fsync:true (contents + no temp leftover)', () => {
    const dest = join(dir, 'durable.json');
    atomicWriteFileSync(dest, '{"durable":true}', { fsync: true });
    expect(readFileSync(dest, 'utf-8')).toBe('{"durable":true}');
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('throws and cleans up the temp file when the destination dir is missing', () => {
    const dest = join(dir, 'does-not-exist', 'out.json');
    expect(() => atomicWriteFileSync(dest, 'x')).toThrow();
    // No stray temp files in the (existing) parent dir.
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
    expect(existsSync(dest)).toBe(false);
  });

  it('applies the restricted mode to the final file (POSIX)', () => {
    if (process.platform === 'win32') return; // POSIX perms only
    const dest = join(dir, 'secret.json');
    atomicWriteFileSync(dest, '{"key":"secret"}', { mode: 0o600 });
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(readFileSync(dest, 'utf-8')).toBe('{"key":"secret"}');
  });

  it('replaces a pre-existing looser file with the restricted mode (POSIX)', () => {
    if (process.platform === 'win32') return;
    const dest = join(dir, 'secret.json');
    writeFileSync(dest, 'old', { mode: 0o644 });
    expect(statSync(dest).mode & 0o777).toBe(0o644);
    atomicWriteFileSync(dest, 'new', { mode: 0o600 });
    // rename replaces the inode, so the new file carries the temp's 0o600 —
    // never a window where the secret sits at 0o644.
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(readFileSync(dest, 'utf-8')).toBe('new');
  });

  it('replaces a symlinked destination with a real file instead of following it (POSIX)', () => {
    if (process.platform === 'win32') return;
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'original-outside');
    const dest = join(dir, 'link.json');
    symlinkSync(outside, dest);
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);

    atomicWriteFileSync(dest, 'payload');

    // rename replaces the symlink itself with the real temp file; the symlink
    // target must NOT be overwritten (no write-through-symlink).
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest, 'utf-8')).toBe('payload');
    expect(readFileSync(outside, 'utf-8')).toBe('original-outside');
  });

  it('writes asynchronously with restrictive permissions and no temp residue', async () => {
    const dest = join(dir, 'async.json');
    await atomicWriteFile(dest, '{"async":true}', { mode: 0o600 });

    expect(readFileSync(dest, 'utf8')).toBe('{"async":true}');
    expect(readdirSync(dir).filter((file) => file.includes('.tmp-'))).toEqual([]);
    if (process.platform !== 'win32') expect(statSync(dest).mode & 0o777).toBe(0o600);
  });

  it('async atomicWriteFile honors { fsync: true } (durable write, correct contents, no residue) (R28P49)', async () => {
    const dest = join(dir, 'async-durable.json');
    // fsync durability isn't directly observable, but the write must still land
    // correctly and leave no temp file — proving the sync()+dir-fsync path runs
    // without corrupting the write or throwing on a normal filesystem.
    await atomicWriteFile(dest, '{"durable":true}', { fsync: true });
    expect(readFileSync(dest, 'utf8')).toBe('{"durable":true}');
    expect(readdirSync(dir).filter((file) => file.includes('.tmp-'))).toEqual([]);
  });
});

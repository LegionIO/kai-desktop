import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { atomicWriteFileSync } from '../atomic-write.js';

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

  it('throws and cleans up the temp file when the destination dir is missing', () => {
    const dest = join(dir, 'does-not-exist', 'out.json');
    expect(() => atomicWriteFileSync(dest, 'x')).toThrow();
    // No stray temp files in the (existing) parent dir.
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
    expect(existsSync(dest)).toBe(false);
  });
});

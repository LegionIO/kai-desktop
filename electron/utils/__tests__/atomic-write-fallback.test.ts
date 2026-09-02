import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as FsModule from 'fs';

// R34P2: on a platform WITHOUT O_NOFOLLOW (notably Windows), atomicWriteFileSync
// takes a fallback branch that writes the temp with writeFileSync(path). That path
// must STILL fsync the temp before the rename when { fsync: true } is requested —
// otherwise the post-update ledger's durability guarantee is silently dropped there
// and a crash/power-loss can lose it. We can't observe O_NOFOLLOW absence on macOS,
// so force it by mocking fs so `constants.O_NOFOLLOW` is undefined (→ the module's
// `?? 0` makes O_NOFOLLOW === 0, selecting the fallback), and spy on fsyncSync.

const fsyncCalls: number[] = [];

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof FsModule>('fs');
  return {
    ...actual,
    // Drop O_NOFOLLOW so the module computes O_NOFOLLOW === 0 (the Windows fallback).
    constants: { ...actual.constants, O_NOFOLLOW: undefined },
    fsyncSync: (fd: number) => {
      fsyncCalls.push(fd);
      return actual.fsyncSync(fd);
    },
  };
});

// Import AFTER the mock so the module captures the patched O_NOFOLLOW at load.
const { atomicWriteFileSync } = await import('../atomic-write.js');
const { mkdtempSync, rmSync, readFileSync, readdirSync } = await vi.importActual<typeof FsModule>('fs');
const { tmpdir } = await import('os');
const { join } = await import('path');

describe('atomicWriteFileSync fallback (no O_NOFOLLOW / Windows) durability (R34P2)', () => {
  let dir: string;

  beforeEach(() => {
    fsyncCalls.length = 0;
    dir = mkdtempSync(join(tmpdir(), 'atomic-write-fallback-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fsyncs the temp file before rename when fsync:true (contents land, no residue)', () => {
    const dest = join(dir, 'durable.json');
    atomicWriteFileSync(dest, '{"durable":true}', { fsync: true });
    // The fallback path must have flushed the temp fd at least once.
    expect(fsyncCalls.length).toBeGreaterThanOrEqual(1);
    expect(readFileSync(dest, 'utf-8')).toBe('{"durable":true}');
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('does NOT fsync when fsync is not requested', () => {
    const dest = join(dir, 'plain.json');
    atomicWriteFileSync(dest, '{"plain":true}');
    expect(fsyncCalls.length).toBe(0);
    expect(readFileSync(dest, 'utf-8')).toBe('{"plain":true}');
  });
});

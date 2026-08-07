import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, utimesSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureHeapSnapshot,
  enforceHeapSnapshotRetention,
  heapSnapshotDir,
  snapshotFileName,
} from '../heap-snapshot';

describe('snapshotFileName', () => {
  it('produces a sortable UTC-stamped .heapsnapshot name', () => {
    const name = snapshotFileName(new Date('2026-08-06T04:20:56.000Z'));
    expect(name).toMatch(/^heap-20260806T042056\.heapsnapshot$/);
  });
});

describe('enforceHeapSnapshotRetention', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kai-heapsnap-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Write a snapshot file with a controlled size and mtime (older index = older).
  function makeSnap(name: string, bytes: number, ageIndex: number): void {
    const p = join(dir, name);
    writeFileSync(p, Buffer.alloc(bytes, 1));
    const t = new Date(2026, 0, 1, 0, ageIndex); // increasing minute = newer
    utimesSync(p, t, t);
  }

  it('evicts oldest beyond maxCount', () => {
    makeSnap('heap-20260101T000000.heapsnapshot', 10, 0);
    makeSnap('heap-20260101T000001.heapsnapshot', 10, 1);
    makeSnap('heap-20260101T000002.heapsnapshot', 10, 2);
    makeSnap('heap-20260101T000003.heapsnapshot', 10, 3);

    const evicted = enforceHeapSnapshotRetention(dir, { maxCount: 2, maxTotalBytes: 0 });

    expect(evicted.sort()).toEqual([
      'heap-20260101T000000.heapsnapshot',
      'heap-20260101T000001.heapsnapshot',
    ]);
    expect(readdirSync(dir).sort()).toEqual([
      'heap-20260101T000002.heapsnapshot',
      'heap-20260101T000003.heapsnapshot',
    ]);
  });

  it('honors the count ceiling even when an unlink FAILS on an older snapshot', () => {
    // A failed unlink must not be counted as removed — otherwise (4 files, cap 2) one failed
    // deletion + one successful one would stop with 3 still on disk. Make the OLDEST snapshot
    // an un-removable non-empty DIRECTORY (rmSync without recursive throws) to simulate that.
    const unremovable = join(dir, 'heap-20260101T000000.heapsnapshot');
    mkdirSync(unremovable);
    writeFileSync(join(unremovable, 'blocker'), 'x'); // non-empty → rmSync (no recursive) throws
    const oldT = new Date(2026, 0, 1, 0, 0);
    utimesSync(unremovable, oldT, oldT);
    makeSnap('heap-20260101T000001.heapsnapshot', 10, 1);
    makeSnap('heap-20260101T000002.heapsnapshot', 10, 2);
    makeSnap('heap-20260101T000003.heapsnapshot', 10, 3);

    enforceHeapSnapshotRetention(dir, { maxCount: 2, maxTotalBytes: 0 });

    // The undeletable dir remains (unlink failed), but the count sweep kept dropping the
    // NEXT-oldest real files until the on-disk count reached the cap: dir + 1 file = 2.
    const remaining = readdirSync(dir).filter((n) => n.endsWith('.heapsnapshot')).sort();
    expect(remaining).toEqual([
      'heap-20260101T000000.heapsnapshot', // the undeletable dir
      'heap-20260101T000003.heapsnapshot', // newest real file
    ]);
    // cleanup: make the dir removable for afterEach
    rmSync(unremovable, { recursive: true, force: true });
  });

  it('evicts oldest beyond maxTotalBytes', () => {
    makeSnap('heap-20260101T000000.heapsnapshot', 100, 0);
    makeSnap('heap-20260101T000001.heapsnapshot', 100, 1);
    makeSnap('heap-20260101T000002.heapsnapshot', 100, 2);

    // Cap 250 → must drop the oldest (100) to reach 200.
    const evicted = enforceHeapSnapshotRetention(dir, { maxCount: 0, maxTotalBytes: 250 });

    expect(evicted).toEqual(['heap-20260101T000000.heapsnapshot']);
    expect(readdirSync(dir).length).toBe(2);
  });

  it('keeps the sole newest snapshot even if it alone exceeds the byte cap', () => {
    makeSnap('heap-20260101T000000.heapsnapshot', 100, 0);
    makeSnap('heap-20260101T000001.heapsnapshot', 5000, 1); // huge newest

    const evicted = enforceHeapSnapshotRetention(dir, { maxCount: 0, maxTotalBytes: 250 });

    // Oldest dropped, but the newest (over-cap) is retained — never evict the last.
    expect(evicted).toEqual(['heap-20260101T000000.heapsnapshot']);
    expect(readdirSync(dir)).toEqual(['heap-20260101T000001.heapsnapshot']);
  });

  it('ignores non-snapshot files in the directory', () => {
    makeSnap('heap-20260101T000000.heapsnapshot', 10, 0);
    writeFileSync(join(dir, 'notes.txt'), 'keep me');
    writeFileSync(join(dir, 'index.json'), '{}');

    enforceHeapSnapshotRetention(dir, { maxCount: 1, maxTotalBytes: 0 });

    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    expect(existsSync(join(dir, 'index.json'))).toBe(true);
  });

  it('is a no-op when limits are 0 (unlimited)', () => {
    makeSnap('heap-20260101T000000.heapsnapshot', 10, 0);
    makeSnap('heap-20260101T000001.heapsnapshot', 10, 1);
    const evicted = enforceHeapSnapshotRetention(dir, { maxCount: 0, maxTotalBytes: 0 });
    expect(evicted).toEqual([]);
    expect(readdirSync(dir).length).toBe(2);
  });
});

describe('captureHeapSnapshot', () => {
  let logsDir: string;

  beforeEach(() => {
    logsDir = mkdtempSync(join(tmpdir(), 'kai-heapsnap-logs-'));
  });
  afterEach(() => rmSync(logsDir, { recursive: true, force: true }));

  it('writes into logs/heap-snapshots and returns path + size + evictions', async () => {
    // Fake "take" writes a small file so statSync has a real size.
    const take = vi.fn(async (filePath: string) => {
      writeFileSync(filePath, Buffer.alloc(2048, 7));
    });

    const result = await captureHeapSnapshot(
      logsDir,
      take,
      { maxCount: 3, maxTotalBytes: 0 },
      new Date('2026-08-06T04:20:56.000Z'),
    );

    expect(take).toHaveBeenCalledTimes(1);
    expect(result.path.startsWith(heapSnapshotDir(logsDir))).toBe(true);
    expect(result.path).toMatch(/heap-20260806T042056-\d+\.heapsnapshot$/);
    expect(result.bytes).toBe(2048);
    expect(existsSync(result.path)).toBe(true);
  });

  it('captures FIRST (no pre-eviction) — existing snapshots survive until post-retention', async () => {
    // Capture-first design: the old snapshots are the fallback, not pre-deleted. On a
    // SUCCESSFUL capture, `take` sees them still present; post-retention then enforces the
    // ceiling (keep newest maxCount).
    const dir = heapSnapshotDir(logsDir);
    mkdirSync(dir, { recursive: true });
    const older = join(dir, 'heap-20260806T000000.heapsnapshot');
    const newer = join(dir, 'heap-20260806T000100.heapsnapshot');
    writeFileSync(older, Buffer.alloc(10, 1));
    writeFileSync(newer, Buffer.alloc(10, 1));
    utimesSync(older, new Date(2026, 7, 6, 0, 0), new Date(2026, 7, 6, 0, 0));
    utimesSync(newer, new Date(2026, 7, 6, 0, 1), new Date(2026, 7, 6, 0, 1));

    let countAtCapture = -1;
    const take = vi.fn(async (filePath: string) => {
      countAtCapture = readdirSync(dir).filter((n) => n.endsWith('.heapsnapshot')).length;
      writeFileSync(filePath, Buffer.alloc(2048, 7));
    });

    const result = await captureHeapSnapshot(logsDir, take, { maxCount: 2, maxTotalBytes: 0 });

    expect(countAtCapture).toBe(2); // NOT pre-deleted — both existing present during capture
    expect(result.evicted).toContain('heap-20260806T000000.heapsnapshot'); // post-retention trims oldest
    expect(readdirSync(dir).filter((n) => n.endsWith('.heapsnapshot')).length).toBe(2); // ceiling held
  });

  it('frees space incrementally on failure (evicts oldest, retries) and keeps the newer one', async () => {
    // Capture-first; on failure evict the OLDEST snapshot and retry. Two existing snapshots:
    // first attempt fails, we evict the oldest to free space, the retry succeeds → the newer
    // pre-existing snapshot is preserved through the transient failure + the new one lands.
    const dir = heapSnapshotDir(logsDir);
    mkdirSync(dir, { recursive: true });
    const older = join(dir, 'heap-20260806T000000.heapsnapshot');
    const newer = join(dir, 'heap-20260806T000100.heapsnapshot');
    writeFileSync(older, Buffer.alloc(10, 1));
    writeFileSync(newer, Buffer.alloc(10, 1));
    utimesSync(older, new Date(2026, 7, 6, 0, 0), new Date(2026, 7, 6, 0, 0));
    utimesSync(newer, new Date(2026, 7, 6, 0, 1), new Date(2026, 7, 6, 0, 1));

    let attempt = 0;
    const take = vi.fn(async (filePath: string) => {
      attempt++;
      if (attempt === 1) throw new Error('ENOSPC: no space');
      writeFileSync(filePath, Buffer.alloc(2048, 7));
    });

    const result = await captureHeapSnapshot(logsDir, take, { maxCount: 2, maxTotalBytes: 0 });

    expect(attempt).toBe(2); // evicted the oldest + retried
    expect(result.evicted).toContain('heap-20260806T000000.heapsnapshot'); // OLDEST evicted
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(newer)).toBe(true); // the NEWER pre-existing snapshot preserved
  });

  it('a persistently-failing capture NEVER deletes the last valid snapshot (keeps >=1)', async () => {
    // With one existing snapshot and a capture that always fails, the incremental evict loop
    // must NOT delete that sole snapshot (never leave zero diagnostics). It gives up + throws,
    // and the pre-existing snapshot survives.
    const dir = heapSnapshotDir(logsDir);
    mkdirSync(dir, { recursive: true });
    const sole = join(dir, 'heap-20260806T000000.heapsnapshot');
    writeFileSync(sole, Buffer.alloc(10, 1));
    const take = vi.fn(async () => {
      throw new Error('takeHeapSnapshot failed');
    });
    await expect(
      captureHeapSnapshot(logsDir, take, { maxCount: 1, maxTotalBytes: 0 }),
    ).rejects.toThrow(/out of space|takeHeapSnapshot failed/);
    expect(take).toHaveBeenCalledTimes(1); // only 1 existing → never evicted → no retry
    expect(existsSync(sole)).toBe(true); // the sole valid snapshot is preserved
  });
});

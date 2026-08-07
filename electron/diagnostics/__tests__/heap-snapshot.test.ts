import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, utimesSync } from 'fs';
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

  it('propagates a capture failure (caller re-arms)', async () => {
    const take = vi.fn(async () => {
      throw new Error('takeHeapSnapshot failed');
    });
    await expect(
      captureHeapSnapshot(logsDir, take, { maxCount: 3, maxTotalBytes: 0 }),
    ).rejects.toThrow('takeHeapSnapshot failed');
  });
});

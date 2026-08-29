import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  utimesSync,
  mkdirSync,
  chmodSync,
  statSync,
  symlinkSync,
  readFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureHeapSnapshot,
  enforceHeapSnapshotRetention,
  heapSnapshotDir,
  HeapSnapshotTimeoutError,
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

    expect(evicted.sort()).toEqual(['heap-20260101T000000.heapsnapshot', 'heap-20260101T000001.heapsnapshot']);
    expect(readdirSync(dir).sort()).toEqual(['heap-20260101T000002.heapsnapshot', 'heap-20260101T000003.heapsnapshot']);
  });

  it('tightens surviving snapshots to 0600 (hardens files left too-open by a prior release)', () => {
    makeSnap('heap-20260101T000000.heapsnapshot', 10, 0);
    makeSnap('heap-20260101T000001.heapsnapshot', 10, 1);
    // Simulate a world/group-readable file from before the 0600 change.
    chmodSync(join(dir, 'heap-20260101T000001.heapsnapshot'), 0o644);

    enforceHeapSnapshotRetention(dir, { maxCount: 5, maxTotalBytes: 0 });

    const mode = statSync(join(dir, 'heap-20260101T000001.heapsnapshot')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('does not chmod through a snapshot-named symlink (symlink-safety)', () => {
    // A symlink named like a snapshot must NOT have its target chmodded — that
    // would let anyone who can drop a symlink in the dir repoint our chmod.
    makeSnap('heap-20260101T000000.heapsnapshot', 10, 0); // real, keeps retention non-trivial
    const targetPath = join(dir, 'secret-target');
    writeFileSync(targetPath, 'sensitive');
    chmodSync(targetPath, 0o644);
    symlinkSync(targetPath, join(dir, 'heap-20260101T000002.heapsnapshot'));

    enforceHeapSnapshotRetention(dir, { maxCount: 5, maxTotalBytes: 0 });

    // The symlink target keeps its original mode — lstat-guarded chmod skipped it.
    expect(statSync(targetPath).mode & 0o777).toBe(0o644);
  });

  it('excludes a snapshot-named symlink from the retention inventory', () => {
    // A symlink to a HUGE target must not (a) count toward the byte cap nor
    // (b) be treated as an evictable snapshot — its target size/mtime must not
    // drive eviction, and a real snapshot must be preferred for keeping.
    const realNewer = join(dir, 'heap-20260101T000003.heapsnapshot');
    writeFileSync(realNewer, Buffer.alloc(10, 1));
    const t = new Date(2026, 0, 1, 0, 3);
    utimesSync(realNewer, t, t);
    // A symlink pointing at a large file, named like an OLDER snapshot.
    const bigTarget = join(dir, 'big-target');
    writeFileSync(bigTarget, Buffer.alloc(100000, 1));
    symlinkSync(bigTarget, join(dir, 'heap-20260101T000000.heapsnapshot'));

    // Byte cap far below the symlink target size: if the symlink were counted,
    // the sweep would try to evict to satisfy it. It must be ignored entirely.
    const evicted = enforceHeapSnapshotRetention(dir, { maxCount: 0, maxTotalBytes: 50 });

    // The symlink is not inventory → not evicted; the real file is the sole
    // snapshot and is preserved (never evict the last real one).
    expect(evicted).toEqual([]);
    expect(existsSync(realNewer)).toBe(true);
    expect(existsSync(bigTarget)).toBe(true);
  });

  it('honors the count ceiling even when an unlink FAILS on an older snapshot', () => {
    // A failed unlink must not be counted as removed — otherwise (4 files, cap 2) one failed
    // deletion + one successful one would stop with 3 still on disk. Simulate an un-removable
    // OLDEST snapshot by putting it in a read-only SUBDIR and pointing retention at that subdir,
    // then dropping write perm so unlink(oldest) throws EACCES while the newer ones (created
    // before the chmod, but unlink still needs dir write) — so instead we make ONLY the oldest
    // unremovable via the immutable trick: a real file whose unlink we force to fail by removing
    // the file first and leaving a same-named DIRECTORY is what the old test did, but directories
    // are no longer inventory. Instead: chmod the oldest file 0000 is insufficient (unlink checks
    // dir perms, not file perms). Use a read-only containing dir for the whole sweep.
    const roDir = join(dir, 'ro');
    mkdirSync(roDir);
    const mk = (name: string, ageIndex: number): void => {
      const p = join(roDir, name);
      writeFileSync(p, Buffer.alloc(10, 1));
      const t = new Date(2026, 0, 1, 0, ageIndex);
      utimesSync(p, t, t);
    };
    mk('heap-20260101T000000.heapsnapshot', 0);
    mk('heap-20260101T000001.heapsnapshot', 1);
    // Read-only dir → every unlink inside it fails (EACCES). The sweep must not
    // mis-count a failed unlink as freed and spin or over-report.
    chmodSync(roDir, 0o500);
    try {
      const evicted = enforceHeapSnapshotRetention(roDir, { maxCount: 1, maxTotalBytes: 0 });
      // Nothing could actually be deleted (dir read-only), so no evictions are
      // reported and both files remain — the sweep tolerates the failure without
      // spinning or falsely claiming the cap was met.
      expect(evicted).toEqual([]);
      const remaining = readdirSync(roDir)
        .filter((n) => n.endsWith('.heapsnapshot'))
        .sort();
      expect(remaining).toEqual(['heap-20260101T000000.heapsnapshot', 'heap-20260101T000001.heapsnapshot']);
    } finally {
      chmodSync(roDir, 0o700); // restore for afterEach cleanup
    }
  });

  it('never deletes the NEWEST snapshot to satisfy the count cap when older ones are undeletable', () => {
    // maxCount:1 with a read-only dir: no unlink can succeed, so the newest is
    // preserved and the sweep tolerates exceeding the cap rather than spinning.
    const roDir = join(dir, 'ro2');
    mkdirSync(roDir);
    const mk = (name: string, ageIndex: number): void => {
      const p = join(roDir, name);
      writeFileSync(p, Buffer.alloc(10, 1));
      const t = new Date(2026, 0, 1, 0, ageIndex);
      utimesSync(p, t, t);
    };
    mk('heap-20260101T000000.heapsnapshot', 0);
    mk('heap-20260101T000005.heapsnapshot', 5); // newest
    chmodSync(roDir, 0o500);
    try {
      const evicted = enforceHeapSnapshotRetention(roDir, { maxCount: 1, maxTotalBytes: 0 });

      expect(evicted).not.toContain('heap-20260101T000005.heapsnapshot'); // newest preserved
      const remaining = readdirSync(roDir)
        .filter((n) => n.endsWith('.heapsnapshot'))
        .sort();
      expect(remaining).toContain('heap-20260101T000005.heapsnapshot');
    } finally {
      chmodSync(roDir, 0o700); // restore for afterEach cleanup
    }
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
    await expect(captureHeapSnapshot(logsDir, take, { maxCount: 1, maxTotalBytes: 0 })).rejects.toThrow(
      /out of space|takeHeapSnapshot failed/,
    );
    expect(take).toHaveBeenCalledTimes(1); // only 1 existing → never evicted → no retry
    expect(existsSync(sole)).toBe(true); // the sole valid snapshot is preserved
  });

  it('rejects (does not hang) when take never settles, and leaves no partial behind', async () => {
    // The real bug: a renderer at the heap limit dies mid-serialization, so
    // webContents.takeHeapSnapshot NEITHER resolves NOR rejects. Without a
    // timeout the await hangs forever. With timeoutMs the capture must reject
    // with HeapSnapshotTimeoutError so the caller's failure path runs, and the
    // 0-byte partial must be cleaned up.
    vi.useFakeTimers();
    try {
      const take = vi.fn(
        (filePath: string) =>
          new Promise<void>(() => {
            // Simulate a hung capture that opened a 0-byte partial then never returns.
            writeFileSync(filePath, Buffer.alloc(0));
          }),
      );
      const promise = captureHeapSnapshot(
        logsDir,
        take,
        { maxCount: 3, maxTotalBytes: 0 },
        new Date('2026-08-06T04:20:56.000Z'),
        5000,
      );
      // Attach the rejection assertion BEFORE advancing timers so the rejection
      // is always observed (no unhandled-rejection warning).
      const assertion = expect(promise).rejects.toBeInstanceOf(HeapSnapshotTimeoutError);
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(take).toHaveBeenCalledTimes(1);
      // No leftover heapsnapshot file (the partial was rm'd on failure).
      const dir = heapSnapshotDir(logsDir);
      const leftovers = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.heapsnapshot')) : [];
      expect(leftovers).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT retry when take() reports the native command still pending (grace exceeded)', async () => {
    // If the grace expires with the native op still pending, take() throws
    // HeapSnapshotNativePendingError. captureHeapSnapshot must NOT enter the
    // evict-and-retry loop (a retry would start a 2nd concurrent capture) — even
    // with existing snapshots present that would otherwise be eviction fodder.
    const dir = heapSnapshotDir(logsDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'heap-20260806T000000.heapsnapshot'), Buffer.alloc(10, 1));
    writeFileSync(join(dir, 'heap-20260806T000100.heapsnapshot'), Buffer.alloc(10, 1));
    const take = vi.fn(async () => {
      const err = new Error('heap snapshot native command still pending after 2000ms grace');
      err.name = 'HeapSnapshotNativePendingError';
      throw err;
    });

    await expect(captureHeapSnapshot(logsDir, take, { maxCount: 3, maxTotalBytes: 0 })).rejects.toThrow(
      /still pending/,
    );
    expect(take).toHaveBeenCalledTimes(1); // NO retry — did not start a 2nd capture
  });

  it('defers onNativeSettled until the carried native-pending promise settles (fence held to true completion)', async () => {
    // The deeper fence fix: when take() throws a native-pending error carrying the
    // still-unsettled native promise, captureHeapSnapshot must NOT fire
    // onNativeSettled (which releases the monitor's single-flight fence) until that
    // native promise actually settles — otherwise cooldown could start a 2nd
    // concurrent capture while the first is still retained in the renderer.
    let resolveNative: (() => void) | undefined;
    const nativePending = new Promise<void>((resolve) => {
      resolveNative = resolve;
    });
    const take = vi.fn(async () => {
      const err = new Error('heap snapshot native command still pending after 10ms grace') as Error & {
        nativePending?: Promise<unknown>;
      };
      err.name = 'HeapSnapshotNativePendingError';
      err.nativePending = nativePending;
      throw err;
    });
    let settledFired = false;
    const onNativeSettled = vi.fn(() => {
      settledFired = true;
    });

    const capturePromise = captureHeapSnapshot(
      logsDir,
      take,
      { maxCount: 3, maxTotalBytes: 0 },
      new Date('2026-08-06T04:20:56.000Z'),
      0,
      onNativeSettled,
    );
    // captureHeapSnapshot rejects promptly (take() didn't hang)...
    await expect(capturePromise).rejects.toThrow(/still pending/);
    // ...but the fence-release callback must NOT have fired yet — the native op is
    // still pending, so the fence stays held.
    await Promise.resolve(); // flush any microtasks
    expect(settledFired).toBe(false);
    expect(onNativeSettled).not.toHaveBeenCalled();
    // Now the native op truly settles → onNativeSettled fires exactly once.
    resolveNative?.();
    await nativePending;
    await new Promise((r) => setTimeout(r, 0)); // let the allSettled chain flush
    expect(onNativeSettled).toHaveBeenCalledTimes(1);
  });

  it('holds onNativeSettled to true native settle even when the OUTER timeout wins the race (production interleaving)', async () => {
    // The production path always supplies a positive timeout. When it fires, the
    // BOUNDED wrapper's own timer wins the outer Promise.race with
    // HeapSnapshotTimeoutError BEFORE take() (the CDP seam) throws its
    // grace-expiry HeapSnapshotNativePendingError — so runCapture's catch never
    // sees the native-pending error. The wrapper's INTERNAL native-settlement
    // tracking is then the only thing gating fence release, and it MUST chain onto
    // the carried nativePending rather than settling at take()'s grace-expiry.
    // Otherwise onNativeSettled fires while the real native op is still retained.
    let resolveNative: (() => void) | undefined;
    const nativePending = new Promise<void>((resolve) => {
      resolveNative = resolve;
    });
    // take() ignores the abort and keeps "running" a while, then rejects with a
    // native-pending error carrying the still-unsettled real native promise —
    // exactly what makeCdpHeapSnapshotTake does after its own grace. It rejects
    // AFTER the outer timeout has already fired.
    const take = vi.fn(
      (_filePath: string, _signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => {
            const err = new Error('heap snapshot native command still pending after 10ms grace') as Error & {
              nativePending?: Promise<unknown>;
            };
            err.name = 'HeapSnapshotNativePendingError';
            err.nativePending = nativePending;
            reject(err);
          }, 150); // >> the 30ms outer timeout below; wide gap so load jitter can't reorder
        }),
    );
    let settledFired = false;
    const onNativeSettled = vi.fn(() => {
      settledFired = true;
    });

    const capturePromise = captureHeapSnapshot(
      logsDir,
      take,
      { maxCount: 3, maxTotalBytes: 0 },
      new Date('2026-08-06T04:20:56.000Z'),
      30, // positive timeout — the OUTER wrapper rejects with HeapSnapshotTimeoutError first
      onNativeSettled,
    );
    // The outer timeout wins → captureHeapSnapshot rejects with the TIMEOUT error
    // (not the native-pending error).
    await expect(capturePromise).rejects.toBeInstanceOf(HeapSnapshotTimeoutError);
    // The fence must still be HELD: take() hasn't even rejected yet, and the real
    // native op is still pending.
    expect(settledFired).toBe(false);
    // Let take() reject (grace-expiry native-pending) and give the tracked chain
    // ample time. The fence must STILL be held — the tracked settlement chains onto
    // nativePending, which is unresolved. Wide margin (well past take()'s 150ms
    // rejection) so this is robust under full-suite load.
    await new Promise((r) => setTimeout(r, 300));
    expect(onNativeSettled).not.toHaveBeenCalled();
    // Now the REAL native op settles → onNativeSettled finally fires.
    resolveNative?.();
    await nativePending;
    await new Promise((r) => setTimeout(r, 0));
    expect(onNativeSettled).toHaveBeenCalledTimes(1);
  });

  it('late timeout cleanup does not delete a DIFFERENT file that took the path', async () => {
    // After a timeout, the abandoned native settling triggers cleanupLate. If a
    // DIFFERENT file (different inode) now occupies filePath (a later capture
    // reused the timestamp+random suffix), cleanupLate must NOT delete it.
    let capturedPath = '';
    let releaseNative: (() => void) | undefined;
    const take = vi.fn(
      (filePath: string) =>
        new Promise<void>((resolve) => {
          capturedPath = filePath;
          writeFileSync(filePath, Buffer.alloc(0)); // our partial
          releaseNative = resolve as () => void; // settle later, AFTER we swap the file
        }),
    );
    const promise = captureHeapSnapshot(
      logsDir,
      take,
      { maxCount: 3, maxTotalBytes: 0 },
      new Date('2026-08-06T04:20:56.000Z'),
      50, // short real-timer timeout
    );
    const assertion = expect(promise).rejects.toBeInstanceOf(HeapSnapshotTimeoutError);
    await assertion; // timeout fires (captures our partial's inode) + rejects
    // Replace the file at the path with a DIFFERENT inode (rm + recreate).
    rmSync(capturedPath, { force: true });
    writeFileSync(capturedPath, 'REPLACEMENT');
    // Now let the abandoned native settle → cleanupLate runs. It must see the
    // different inode and leave the replacement alone.
    releaseNative?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(capturedPath)).toBe(true);
    expect(readFileSync(capturedPath, 'utf8')).toBe('REPLACEMENT');
  });

  it('does not time out a capture that completes within the bound', async () => {
    const take = vi.fn(async (filePath: string) => {
      writeFileSync(filePath, Buffer.alloc(2048, 7));
    });
    const result = await captureHeapSnapshot(
      logsDir,
      take,
      { maxCount: 3, maxTotalBytes: 0 },
      new Date('2026-08-06T04:20:56.000Z'),
      30000,
    );
    expect(result.bytes).toBe(2048);
    expect(existsSync(result.path)).toBe(true);
  });

  it('surfaces a SYNCHRONOUS take() throw as a normal rejection (no unhandled timeout)', async () => {
    // A destroyed WebContents makes takeHeapSnapshot throw synchronously. The bounded
    // wrapper must fold that into the raced promise (so it rejects here) and clear its
    // timer — NOT let the timeout promise reject later unhandled. Track unhandled
    // rejections for the duration to assert none escape.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const take = vi.fn((): Promise<void> => {
        throw new Error('Object has been destroyed');
      });
      await expect(
        captureHeapSnapshot(logsDir, take, { maxCount: 3, maxTotalBytes: 0 }, new Date(), 5000),
      ).rejects.toThrow(/Object has been destroyed/);
      // Let any errant timeout rejection (if the timer were left armed) surface.
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does NOT delete a pre-existing destination when take() fails EEXIST (O_EXCL collision)', async () => {
    // The O_EXCL sink refuses a pre-existing path with EEXIST. The failure
    // cleanup must NOT rmSync that path — it belongs to a real prior snapshot
    // (or a symlink O_EXCL protected), not this attempt.
    const dir = heapSnapshotDir(logsDir);
    mkdirSync(dir, { recursive: true });
    // Pre-create the exact file take() will target (fixed date + we stub random).
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.123);
    try {
      const collidePath = join(dir, snapshotFileName(new Date('2026-08-06T04:20:56.000Z'), '-123'));
      writeFileSync(collidePath, 'PRECIOUS');
      const take = vi.fn(async () => {
        const err = new Error('EEXIST: file already exists') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      });

      await expect(
        captureHeapSnapshot(logsDir, take, { maxCount: 3, maxTotalBytes: 0 }, new Date('2026-08-06T04:20:56.000Z')),
      ).rejects.toThrow(/EEXIST/);
      // The pre-existing file is preserved (not deleted by failure cleanup).
      expect(existsSync(collidePath)).toBe(true);
      expect(readFileSync(collidePath, 'utf8')).toBe('PRECIOUS');
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('does NOT delete the destination when a RETRY (after ENOSPC) fails EEXIST', async () => {
    // First attempt ENOSPC → evict oldest + retry. If the retry then fails
    // EEXIST (a concurrent writer created the path), the retry cleanup must NOT
    // rmSync it. Provide two existing snapshots so the evict-and-retry loop runs.
    const dir = heapSnapshotDir(logsDir);
    mkdirSync(dir, { recursive: true });
    const older = join(dir, 'heap-20260806T000000.heapsnapshot');
    const newer = join(dir, 'heap-20260806T000100.heapsnapshot');
    writeFileSync(older, Buffer.alloc(10, 1));
    writeFileSync(newer, Buffer.alloc(10, 1));
    utimesSync(older, new Date(2026, 7, 6, 0, 0), new Date(2026, 7, 6, 0, 0));
    utimesSync(newer, new Date(2026, 7, 6, 0, 1), new Date(2026, 7, 6, 0, 1));

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const collidePath = join(dir, snapshotFileName(new Date('2026-08-06T04:20:56.000Z'), '-500'));
      let attempt = 0;
      const take = vi.fn(async () => {
        attempt++;
        if (attempt === 1) {
          const e = new Error('ENOSPC: no space') as NodeJS.ErrnoException;
          e.code = 'ENOSPC';
          throw e;
        }
        // Between attempt 1 and the retry, a concurrent writer created the path.
        // The retry's O_EXCL open (simulated) fails EEXIST — cleanup must NOT
        // delete this concurrently-created file.
        writeFileSync(collidePath, 'CONCURRENT');
        const e = new Error('EEXIST: file already exists') as NodeJS.ErrnoException;
        e.code = 'EEXIST';
        throw e;
      });

      await expect(
        captureHeapSnapshot(logsDir, take, { maxCount: 3, maxTotalBytes: 0 }, new Date('2026-08-06T04:20:56.000Z')),
      ).rejects.toThrow(/EEXIST/);
      // The concurrently-created destination survives the retry's failure cleanup.
      expect(existsSync(collidePath)).toBe(true);
      expect(readFileSync(collidePath, 'utf8')).toBe('CONCURRENT');
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('refuses to capture when the snapshot dir is a symlink', async () => {
    // If `heap-snapshots` is a pre-planted symlink, dumps would land on / chmod
    // its target. captureHeapSnapshot must reject before writing anything.
    const realElsewhere = join(logsDir, 'elsewhere');
    mkdirSync(realElsewhere);
    symlinkSync(realElsewhere, heapSnapshotDir(logsDir));
    const take = vi.fn(async (filePath: string) => writeFileSync(filePath, Buffer.alloc(10, 1)));

    await expect(captureHeapSnapshot(logsDir, take, { maxCount: 3, maxTotalBytes: 0 })).rejects.toThrow(
      /not a real directory|possible symlink/,
    );
    expect(take).not.toHaveBeenCalled(); // bailed before any capture
  });

  it('does NOT delete a pre-existing destination when take() fails PREFLIGHT (never opened the sink)', async () => {
    // A CdpCaptureUnavailableError (destroyed target / debugger attached /
    // aborted) rejects BEFORE the sink is opened — no file of ours exists at
    // `path`, so any same-name file there is someone else's. The failure
    // cleanup must not delete it.
    const dir = heapSnapshotDir(logsDir);
    mkdirSync(dir, { recursive: true });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.777);
    try {
      const collidePath = join(dir, snapshotFileName(new Date('2026-08-06T04:20:56.000Z'), '-777'));
      writeFileSync(collidePath, 'PREEXISTING');
      const take = vi.fn(async () => {
        // Mimic makeCdpHeapSnapshotTake's preflight rejection (matched by name).
        const err = new Error('heap snapshot capture unavailable: webContents destroyed');
        err.name = 'CdpCaptureUnavailableError';
        throw err;
      });

      await expect(
        captureHeapSnapshot(logsDir, take, { maxCount: 3, maxTotalBytes: 0 }, new Date('2026-08-06T04:20:56.000Z')),
      ).rejects.toThrow(/capture unavailable/);
      expect(existsSync(collidePath)).toBe(true);
      expect(readFileSync(collidePath, 'utf8')).toBe('PREEXISTING');
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('DELETES our partial when a post-open error merely MENTIONS "capture unavailable" in its text', async () => {
    // destinationNotOurs must classify by STRUCTURED fields (code/name) only —
    // NOT loose message text. A post-open CDP/stream error whose message happens
    // to contain "capture unavailable"/"file already exists" is still OURS (the
    // sink was opened) and its partial must be cleaned up.
    const dir = heapSnapshotDir(logsDir);
    mkdirSync(dir, { recursive: true });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.321);
    try {
      const ourPath = join(dir, snapshotFileName(new Date('2026-08-06T04:20:56.000Z'), '-321'));
      const take = vi.fn(async (filePath: string) => {
        writeFileSync(filePath, Buffer.alloc(0)); // our 0-byte partial
        // Plain Error, no EEXIST code, no CdpCaptureUnavailableError name — but
        // the message coincidentally contains the old regex trigger words.
        throw new Error('stream failed: file already exists in mirror / capture unavailable downstream');
      });

      await expect(
        captureHeapSnapshot(logsDir, take, { maxCount: 3, maxTotalBytes: 0 }, new Date('2026-08-06T04:20:56.000Z')),
      ).rejects.toThrow(/stream failed/);
      // Our partial was deleted (not misclassified as "not ours").
      expect(existsSync(ourPath)).toBe(false);
    } finally {
      randomSpy.mockRestore();
    }
  });
});

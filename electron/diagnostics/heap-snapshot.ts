/**
 * Renderer heap-snapshot capture for the memory-diagnostics investigation.
 *
 * A slow renderer leak (see window-health heap-heartbeat) climbs to the V8 heap
 * limit over hours and OOM-aborts — the MB trajectory proves the climb but only
 * a `.heapsnapshot` names the RETAINING objects. This module captures one on
 * demand (driven by the heartbeat crossing a threshold) into
 * `~/.kai/logs/heap-snapshots/`, then GCs old snapshots by count and total
 * bytes. Snapshots are large (multi-GB for a multi-GB heap), so capture is
 * gated by the caller (cooldown + one-shot latch) and retention is aggressive.
 *
 * The `takeHeapSnapshot(webContents, filePath)` seam is injected so the policy
 * (threshold, cooldown, retention sweep) is unit-testable without Electron.
 */
import { mkdirSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';

export interface HeapSnapshotRetention {
  /** Keep the newest N snapshots; evict oldest first. 0 = unlimited. */
  maxCount: number;
  /** Cap total snapshot bytes on disk; evict oldest first. 0 = unlimited. */
  maxTotalBytes: number;
}

export interface HeapSnapshotResult {
  path: string;
  bytes: number;
  evicted: string[];
}

const SNAPSHOT_EXT = '.heapsnapshot';
// Match only files this module wrote, so a stray file in the dir is never
// touched by the retention sweep.
const SNAPSHOT_RE = /^heap-\d{8}T\d{6}(?:-\d+)?\.heapsnapshot$/;

/** `~/.kai/logs/heap-snapshots` — colocated with the other diagnostic logs. */
export function heapSnapshotDir(logsDir: string): string {
  return join(logsDir, 'heap-snapshots');
}

/** Filesystem-safe, sortable timestamp name: heap-YYYYMMDDThhmmss.heapsnapshot. */
export function snapshotFileName(now: Date, suffix = ''): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `heap-${stamp}${suffix}${SNAPSHOT_EXT}`;
}

interface SnapshotFile {
  name: string;
  path: string;
  bytes: number;
  mtimeMs: number;
}

function listSnapshots(dir: string): SnapshotFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // dir may not exist yet
  }
  const out: SnapshotFile[] = [];
  for (const name of names) {
    if (!SNAPSHOT_RE.test(name)) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      out.push({ name, path, bytes: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* file vanished between readdir and stat — skip */
    }
  }
  // Oldest first (front = eviction candidate).
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out;
}

/**
 * Evict oldest snapshots until BOTH the count and total-byte ceilings hold.
 * Pure w.r.t. policy; deletes files as a side effect. Returns evicted names.
 * Best-effort: a failed unlink is skipped (its bytes still count, so the sweep
 * can't spin) rather than throwing.
 *
 * `reserveSlots` (default 0) shrinks the effective count ceiling to
 * `maxCount - reserveSlots` to make room for that many INCOMING snapshots BEFORE a capture.
 * Unlike passing a reduced maxCount, a reserved ceiling of 0 means "evict ALL" (a full slot
 * reserved for the one incoming), NOT "unlimited" — so reserving the sole slot at maxCount:1
 * actually clears the directory. reserveSlots is ignored when maxCount is 0 (unlimited).
 */
export function enforceHeapSnapshotRetention(
  dir: string,
  retention: HeapSnapshotRetention,
  reserveSlots = 0,
): string[] {
  const files = listSnapshots(dir);
  const evicted: string[] = [];
  // Effective count ceiling: 0 (unlimited) stays unlimited; otherwise subtract the reserved
  // slots, clamped at 0 — and a reserved-to-0 ceiling means EVICT ALL (distinct from unlimited).
  const reservedCeiling = retention.maxCount > 0 ? Math.max(0, retention.maxCount - reserveSlots) : 0;
  const evictAllForReserve = retention.maxCount > 0 && reservedCeiling === 0;
  // Victims whose unlink FAILED — set aside so the byte loop neither retries them forever
  // nor mis-accounts their bytes as freed. Their bytes stay counted against the cap.
  const failed: SnapshotFile[] = [];

  // Delete the front (oldest) file. Returns the victim IFF it was actually removed (so the
  // caller subtracts its bytes only then); a failed unlink is moved to `failed` and returns
  // null — the file stays on disk and its bytes still count, so the sweep can't spin on it.
  const dropFront = (list: SnapshotFile[]): SnapshotFile | null => {
    const victim = list.shift();
    if (!victim) return null;
    try {
      rmSync(victim.path, { force: true });
      evicted.push(victim.name);
      return victim;
    } catch {
      failed.push(victim);
      return null;
    }
  };

  // Count ceiling (using the reserved ceiling — see reserveSlots). A FAILED unlink leaves the
  // file on disk (moved to `failed`), so the on-disk count is files.length + failed.length —
  // drive the loop on THAT, not files.length alone. Otherwise a failed unlink followed by a
  // successful one would stop with the cap still violated. Bounded by guard: once every
  // remaining `files` entry has failed to unlink, dropFront can't shrink `files`, so stop.
  if (retention.maxCount > 0 || evictAllForReserve) {
    let guard = 0;
    while (files.length + failed.length > reservedCeiling && files.length > 0 && guard < 1000) {
      dropFront(files); // always shifts one off `files` (deleted → evicted, or failed → `failed`)
      guard++;
    }
  }

  // Byte ceiling — recompute from the surviving set PLUS any file whose unlink failed
  // during the count sweep (still on disk, so its bytes still count against the cap).
  if (retention.maxTotalBytes > 0) {
    let total = files.reduce((sum, f) => sum + f.bytes, 0) + failed.reduce((sum, f) => sum + f.bytes, 0);
    // Never evict the sole newest snapshot to satisfy bytes — a single snapshot
    // larger than the cap is kept (it's the one the user needs), matching the
    // "keep latest" intent. Stop when one file remains.
    let guard = 0;
    while (total > retention.maxTotalBytes && files.length > 1 && guard < 1000) {
      const before = files.length;
      const removedVictim = dropFront(files);
      // Subtract bytes ONLY when the file was actually deleted — else an oversized file
      // that couldn't be removed would be counted as freed and the loop would falsely
      // report the cap satisfied while the file remains on disk.
      if (removedVictim) total -= removedVictim.bytes;
      // If dropFront made no progress (list unchanged), bail to avoid spinning.
      if (files.length === before) break;
      guard++;
    }
  }

  return evicted;
}

/**
 * Capture a renderer heap snapshot and enforce retention. `take` is the
 * Electron seam: `(filePath) => webContents.takeHeapSnapshot(filePath)`.
 * Returns the written path + size and any evicted files, or throws if the
 * capture itself failed (caller logs and re-arms).
 */
export async function captureHeapSnapshot(
  logsDir: string,
  take: (filePath: string) => Promise<void>,
  retention: HeapSnapshotRetention,
  now: Date = new Date(),
): Promise<HeapSnapshotResult> {
  const dir = heapSnapshotDir(logsDir);
  mkdirSync(dir, { recursive: true });

  // Disambiguate same-second captures with a short random suffix.
  const path = join(dir, snapshotFileName(now, `-${Math.floor(Math.random() * 1000)}`));

  // Capture FIRST, evict-and-retry-once on failure — do NOT pre-delete existing snapshots.
  // Pre-eviction was two-sided-wrong: (a) it can't reserve BYTE headroom for the unknown
  // incoming size (a 5.5 GiB snapshot under a 6 GiB cap still leaves no room for the next
  // ~5.5 GiB), and (b) deleting the sole existing snapshot BEFORE a capture that then
  // transiently FAILS destroys the only good one, leaving none. Instead: try the capture
  // with the old snapshots intact (they're the fallback); only if it fails do we evict ALL
  // existing snapshots (freeing their space + count) and retry ONCE — resolving the ENOSPC
  // loop (an old disk-filler is cleared) without risking a good snapshot on a transient error.
  let evictedForRetry: string[] = [];
  try {
    await take(path);
  } catch {
    // Remove any partial from the failed attempt so it doesn't linger / re-consume space.
    try {
      rmSync(path, { force: true });
    } catch {
      /* best-effort */
    }
    // Free space by evicting EVERYTHING currently retained (count ceiling 0 via reserveSlots
    // = maxCount), then retry the capture once. If maxCount is 0 (unlimited) there's no count
    // to reduce — still evict the OLDEST to free bytes for the retry.
    evictedForRetry = enforceHeapSnapshotRetention(
      dir,
      retention.maxCount > 0 ? retention : { ...retention, maxCount: 1 },
      retention.maxCount > 0 ? retention.maxCount : 1,
    );
    try {
      await take(path);
    } catch (secondErr) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* best-effort */
      }
      throw secondErr; // still failing after freeing space — surface it (caller re-arms)
    }
  }

  let bytes = 0;
  try {
    bytes = statSync(path).size;
  } catch {
    /* stat best-effort */
  }

  const evicted = enforceHeapSnapshotRetention(dir, retention);
  // Report everything evicted across the retry + final passes (dedup).
  const allEvicted =
    evictedForRetry.length > 0 ? [...new Set([...evictedForRetry, ...evicted])] : evicted;
  return { path, bytes, evicted: allEvicted };
}

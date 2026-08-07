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
 */
export function enforceHeapSnapshotRetention(dir: string, retention: HeapSnapshotRetention): string[] {
  const files = listSnapshots(dir);
  const evicted: string[] = [];
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

  // Count ceiling.
  if (retention.maxCount > 0) {
    while (files.length > retention.maxCount) {
      if (files.length === 0) break;
      dropFront(files);
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
  try {
    await take(path);
  } catch (err) {
    // take() can fail AFTER writing a partial file (e.g. ENOSPC, or a renderer teardown
    // mid-write). Retention below never runs on the throw path, so that partial would
    // linger — and the caller's retry cooldown would then create ANOTHER partial every
    // minute, accumulating multi-GB and re-consuming any freed space. Remove the partial
    // before rethrowing so a failed capture leaves no residue.
    try {
      rmSync(path, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }

  let bytes = 0;
  try {
    bytes = statSync(path).size;
  } catch {
    /* stat best-effort */
  }

  const evicted = enforceHeapSnapshotRetention(dir, retention);
  return { path, bytes, evicted };
}

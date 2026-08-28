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
import { mkdirSync, readdirSync, statSync, rmSync, chmodSync, lstatSync } from 'fs';
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

/** Whether a capture error looks DISK-SPACE related (worth evicting old snapshots + retrying).
 *  A non-space error (renderer destroyed, snapshotting unsupported, permission) is NOT helped
 *  by eviction — evicting then would pointlessly delete valid diagnostics. Best-effort match
 *  on the common ENOSPC/quota signals (code or message). */
function isDiskSpaceError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') return true;
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /ENOSPC|EDQUOT|no space|disk (is )?full|quota exceeded/i.test(msg);
}

/** Whether a capture error is the O_EXCL "path already exists" failure. When the
 *  sink opens with O_CREAT|O_EXCL and the destination already exists (a real
 *  snapshot from a same-second collision, or a pre-planted symlink), the open
 *  fails EEXIST — and the destination was NOT created by this attempt, so the
 *  failure-cleanup must NOT delete it (that would destroy exactly what O_EXCL
 *  protected). */
function isFileExistsError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code === 'EEXIST') return true;
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /EEXIST|file already exists/i.test(msg);
}

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
      // lstat (NOT stat) so a snapshot-named SYMLINK is not followed: otherwise
      // its target's size/mtime would drive eviction (a huge or future-dated
      // target could evict real snapshots while the symlink survives), and later
      // chmod could touch the target. Only real regular files are inventory.
      const st = lstatSync(path);
      if (!st.isFile()) continue;
      out.push({ name, path, bytes: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* file vanished between readdir and lstat — skip */
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

  // Count ceiling. A FAILED unlink leaves the file on disk (moved to `failed`), so the
  // on-disk count is files.length + failed.length — drive the loop on THAT, not files.length
  // alone. Otherwise a failed unlink followed by a successful one would stop with the cap
  // still violated. Bounded by guard: once every remaining `files` entry has failed to
  // unlink, dropFront can't shrink `files`, so stop.
  if (retention.maxCount > 0) {
    let guard = 0;
    // Stop while more than ONE deletable file remains: never delete the NEWEST remaining snapshot to
    // satisfy the COUNT cap. If older files are UNDELETABLE (moved to `failed`, still counting toward
    // the cap), deleting the newest would leave only stale data — better to tolerate exceeding the
    // cap than to evict the freshest snapshot the user actually needs. (`files` is oldest→newest, so
    // stopping at length 1 preserves the newest survivor.)
    while (files.length + failed.length > retention.maxCount && files.length > 1 && guard < 1000) {
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

  // Harden the perms of every SURVIVING snapshot to 0600. A file written by a
  // PRIOR release (or the abandoned-native late writer) may be group/world
  // readable; heap dumps can contain credentials + conversation content, so
  // tighten them during the sweep. Include `failed` (eviction-failed files that
  // remain on disk) so a survivor isn't left too-open. Only touch REGULAR files,
  // checked with lstat (NOT stat) so a snapshot-named SYMLINK is skipped rather
  // than followed — chmod on a symlink target would let an attacker who can
  // create a symlink in the dir repoint our chmod at an arbitrary file. Skips
  // directories too (chmod 0600 on a dir would make it untraversable).
  // Best-effort / POSIX-only.
  for (const f of [...files, ...failed]) {
    try {
      if (lstatSync(f.path).isFile()) chmodSync(f.path, 0o600);
    } catch {
      /* best-effort */
    }
  }

  return evicted;
}

/** Thrown when a `take` call exceeds the configured timeout. Distinct so callers
 *  can tell a HUNG capture (renderer serializing itself into an OOM, promise never
 *  settles) apart from a normal rejection. NOT a disk-space error, so the
 *  evict-and-retry loop correctly skips it. */
export class HeapSnapshotTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`heap snapshot capture timed out after ${timeoutMs}ms`);
    this.name = 'HeapSnapshotTimeoutError';
  }
}

/**
 * Capture a renderer heap snapshot and enforce retention. `take` is the
 * Electron seam: `(filePath) => webContents.takeHeapSnapshot(filePath)`.
 * Returns the written path + size and any evicted files, or throws if the
 * capture itself failed (caller logs and re-arms).
 *
 * `timeoutMs` (>0) bounds each `take` call. This is essential: a renderer at
 * the V8 heap limit dies mid-serialization, and `webContents.takeHeapSnapshot`
 * then NEITHER resolves NOR rejects — without a timeout the await hangs forever,
 * the caller's `.catch`/`failed`-log never runs, and a 0-byte partial is left on
 * disk (the observed "triggered×N, captured×0, failed×0" bug). On timeout we
 * reject with HeapSnapshotTimeoutError so the normal failure path (partial
 * cleanup + caller re-arm) engages.
 */
export async function captureHeapSnapshot(
  logsDir: string,
  /** The capture seam. Receives the destination path and an AbortSignal that is
   *  aborted when the bounded timeout fires — a well-behaved `take` tears its
   *  capture down on abort (detach + close) instead of leaving it running. */
  take: (filePath: string, signal?: AbortSignal) => Promise<void>,
  retention: HeapSnapshotRetention,
  now: Date = new Date(),
  timeoutMs = 0,
  /** Invoked exactly when the NATIVE capture promise settles (resolve/reject),
   *  INCLUDING a late settle after the bounded timeout already rejected. Lets the
   *  caller release a single-flight fence on true native completion rather than a
   *  fixed timer. Fires at most once; never fires if the native op never settles. */
  onNativeSettled?: () => void,
): Promise<HeapSnapshotResult> {
  const dir = heapSnapshotDir(logsDir);
  // 0700 so heap dumps (which can contain credentials + conversation content)
  // aren't group/world-traversable. Files themselves are written 0600 by the sink.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The final-component O_NOFOLLOW on the sink only guards the FILE, not the
  // snapshot DIRECTORY: if `heap-snapshots` is itself a pre-planted symlink,
  // recursive mkdir succeeds through it and chmod/writes would land on the
  // link's target (redirecting dumps outside the protected tree + chmodding the
  // target). Refuse to proceed unless the dir is a REAL directory (lstat, not
  // stat, so a symlink is rejected rather than followed).
  let dirStat;
  try {
    dirStat = lstatSync(dir);
  } catch (err) {
    throw new Error(`heap snapshot dir is unusable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error(`heap snapshot dir is not a real directory (possible symlink): ${dir}`);
  }
  // mkdir's mode is create-only — a dir left 0755 by a PRIOR release keeps that
  // mode, so tighten an existing dir too (best-effort; POSIX-only).
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort on platforms without POSIX perms */
  }

  // Native promises from every bounded attempt (initial + eviction/retry). The fence
  // release (onNativeSettled) waits for ALL of them so a retry can't overlap.
  const abandonedNatives: Array<Promise<unknown>> = [];
  // Fire onNativeSettled exactly once, after this function's flow completes AND every
  // native attempt has settled — so the single-flight fence is held for the WHOLE
  // capture (incl. the ENOSPC evict/retry loop and any abandoned post-timeout native
  // op), never released mid-retry.
  let settledNotified = false;
  const notifyWhenAllNativesSettle = (): void => {
    if (settledNotified || !onNativeSettled) return;
    settledNotified = true;
    void Promise.allSettled(abandonedNatives).then(() => onNativeSettled());
  };

  // Bound each capture attempt. A hung takeHeapSnapshot must reject, not hang.
  const takeBounded =
    timeoutMs > 0
      ? (filePath: string): Promise<void> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let timedOut = false;
          // Abort the capture on timeout so a well-behaved `take` tears down
          // (detach + close the sink) rather than leaving the native op running.
          // This is the PRIMARY cancellation path; the late-settler below is a
          // backstop for a `take` that ignores the signal or writes anyway.
          const ac = new AbortController();
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              try {
                ac.abort();
              } catch {
                /* best-effort */
              }
              reject(new HeapSnapshotTimeoutError(timeoutMs));
            }, timeoutMs);
            // Never let the timeout timer hold the process open on its own.
            (timer as { unref?: () => void }).unref?.();
          });
          // Invoke `take` INSIDE a resolved-promise callback so a SYNCHRONOUS throw
          // (e.g. takeHeapSnapshot on an already-destroyed WebContents) becomes a
          // rejection of the raced promise rather than escaping this function — which
          // would leave `timeout` unhandled (its timer still armed) to reject later as
          // a spurious unhandled rejection.
          const native = Promise.resolve().then(() => take(filePath, ac.signal));
          // The Promise.race abandons `native` on timeout, but the NATIVE capture keeps
          // running and may finish AFTER we've rejected + removed the partial — leaving
          // an untracked file at `filePath` outside retention. So when the timeout wins,
          // attach a late settler that removes whatever the abandoned capture eventually
          // wrote. Swallow its rejection so it never surfaces unhandled.
          // If the timeout won the race, the native capture was abandoned but may
          // still WRITE (then resolve OR reject with a partial left behind) or RECREATE
          // the file at `filePath`. On EITHER late outcome, remove whatever it wrote so
          // no untracked file escapes retention. (Not timed-out ⇒ the race resolved
          // normally and the file is a real tracked snapshot — leave it.)
          const cleanupLate = (): void => {
            if (!timedOut) return;
            try {
              rmSync(filePath, { force: true });
            } catch {
              /* best-effort late cleanup */
            }
          };
          // Track this attempt's native promise so the caller's fence is released only
          // after EVERY native attempt (initial + eviction/retry) has settled — not
          // per-attempt (which would clear the fence while the retry loop still runs a
          // capture on the same webContents). Also clean up a late-written file.
          const settled = native.then(cleanupLate, cleanupLate);
          abandonedNatives.push(settled);
          // Whichever settles first wins; clear the timer in finally so a resolved
          // capture leaves no dangling handle.
          return Promise.race([native, timeout]).finally(() => {
            if (timer) clearTimeout(timer);
          });
        }
      : take;

  // Disambiguate same-second captures with a short random suffix.
  const path = join(dir, snapshotFileName(now, `-${Math.floor(Math.random() * 1000)}`));

  // Capture FIRST, then free space INCREMENTALLY on failure — do NOT pre-delete existing
  // snapshots. Pre-eviction was two-sided-wrong: it can't reserve BYTE headroom for the
  // unknown incoming size, and deleting a good snapshot before a capture that then FAILS
  // loses it. And evicting EVERYTHING before a retry destroys ALL diagnostics when the
  // retry also fails (a doubly-failing destroyed renderer). Instead: try with the old
  // snapshots intact (the fallback); on failure evict the OLDEST ONE and retry, repeating —
  // but NEVER delete the LAST remaining valid snapshot (always keep ≥1 good diagnostic). If
  // freeing everything-but-one still doesn't let the capture succeed, surface the failure
  // with that last snapshot preserved.
  const evictedForRetry: string[] = [];
  let captured = false;
  let firstErr: unknown;
  try {
    try {
      await takeBounded(path);
      captured = true;
    } catch (err) {
      firstErr = err;
    }
    if (!captured) {
      // Remove the failed attempt's partial — UNLESS the failure was EEXIST,
      // which means our O_EXCL open refused a pre-existing destination we did
      // NOT create; deleting it would destroy a real snapshot / the symlink
      // O_EXCL was protecting. Surface EEXIST as-is (caller re-arms next tick
      // with a fresh timestamp).
      if (isFileExistsError(firstErr)) {
        throw firstErr;
      }
      try {
        rmSync(path, { force: true });
      } catch {
        /* best-effort */
      }
      // ONLY evict-and-retry for a DISK-SPACE failure — eviction can't help a destroyed
      // renderer / unsupported-snapshot / permission error, and would pointlessly delete valid
      // diagnostics. Surface a non-space error immediately (the old snapshots are preserved).
      if (!isDiskSpaceError(firstErr)) {
        throw firstErr;
      }
      let guard = 0;
      while (!captured && guard < 64) {
        guard++;
        // Evict the OLDEST snapshot to free space — but stop before the last one (keep ≥1).
        const existing = listSnapshots(dir); // oldest-first
        if (existing.length <= 1) break; // don't delete the sole remaining valid snapshot
        const victim = existing[0];
        try {
          rmSync(victim.path, { force: true });
          evictedForRetry.push(victim.name);
        } catch {
          break; // can't free the oldest (e.g. permission) — stop rather than spin
        }
        try {
          await takeBounded(path);
          captured = true;
        } catch (retryErr) {
          try {
            rmSync(path, { force: true }); // drop this retry's partial before the next evict
          } catch {
            /* best-effort */
          }
          // If the retry now fails for a NON-space reason, stop evicting — more eviction won't help.
          if (!isDiskSpaceError(retryErr)) {
            throw retryErr;
          }
        }
      }
      if (!captured) {
        try {
          rmSync(path, { force: true });
        } catch {
          /* best-effort */
        }
        throw new Error('heap snapshot capture failed (out of space after evicting all but the last snapshot)');
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
    const allEvicted = evictedForRetry.length > 0 ? [...new Set([...evictedForRetry, ...evicted])] : evicted;
    return { path, bytes, evicted: allEvicted };
  } finally {
    // Release the caller's single-flight fence only after the WHOLE capture (all
    // native attempts, incl. the evict/retry loop) has settled — never mid-retry.
    notifyWhenAllNativesSettle();
  }
}

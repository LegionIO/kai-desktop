import {
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
  openSync,
  closeSync,
  fsyncSync,
  lstatSync,
  chmodSync,
  constants as fsConstants,
} from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { chmod, open, rename, rm } from 'node:fs/promises';

export interface AtomicWriteOptions {
  /**
   * POSIX file mode to enforce on the final file (e.g. 0o600 for secret-bearing
   * files). The temp file is created AND chmod'd to this mode before the rename,
   * so the destination never passes through a wider-than-intended permission
   * window — important when the payload contains secrets (API keys, passwords).
   * Applied best-effort; ignored on platforms without POSIX perms.
   */
  mode?: number;
  /**
   * fsync the temp file's contents before the rename, and fsync the parent
   * directory after. rename(2) is atomic but NOT durable: without this a
   * power-loss/kernel-panic right after the call returns can lose the write even
   * though it "succeeded". Off by default (fsync is expensive and most callers
   * only need crash-atomicity, not power-loss durability). Turn it ON for records
   * whose loss is unrecoverable AND whose write is immediately followed by a
   * process exit — e.g. the post-update cleanup ledger written just before
   * quitAndInstall (R35P1). The file-CONTENTS fsync (BEFORE the rename) always
   * propagates on failure — that's the durability guarantee. The parent-DIRECTORY
   * fsync (AFTER the rename) is BEST-EFFORT and never propagates: the rename has
   * already committed the write, so a dir-fsync error must not misreport it as
   * failed (R28P25). Honored by BOTH the sync (`atomicWriteFileSync`) and async
   * (`atomicWriteFile`) writers (R28P49).
   */
  fsync?: boolean;
}

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

async function closeAsyncHandle(handle: Awaited<ReturnType<typeof open>> | null): Promise<void> {
  if (handle) await handle.close();
}

/**
 * Write a file atomically: write to a sibling temp file, then rename into place.
 * rename(2) is atomic on the same filesystem, so a crash mid-write can never
 * leave a torn/truncated destination — readers see either the old file or the
 * fully-written new one. On failure the temp file is best-effort cleaned up and
 * the error re-thrown.
 *
 * The temp file is a sibling of the destination (same dir) so the rename stays
 * on one filesystem; a cross-device rename would fall back to copy+unlink and
 * lose atomicity.
 *
 * The temp is opened with O_CREAT|O_EXCL|O_NOFOLLOW: O_EXCL fails if the temp
 * path already exists and O_NOFOLLOW fails if it is a symlink, so a pre-planted
 * file/symlink at the (pid+timestamp) temp path can't redirect the write to an
 * attacker-chosen target. When `opts.mode` is set the temp is created at that
 * mode (and chmod'd on platforms where the create mode is masked by umask), so
 * a secret file lands at its target already restricted — no brief
 * world-readable window (which a plain writeFileSync + post-chmod, or a rename
 * of a default-umask temp, would expose).
 */
/**
 * fsync on a DIRECTORY fd is unsupported on some platforms/filesystems, which
 * surfaces as a specific errno. Those we tolerate (the rename already happened;
 * the residual risk is only that the dir entry — not the already-fsync'd file
 * CONTENTS — might not survive a power loss). Any OTHER error (EIO, ENOSPC, …)
 * is a real durability failure on a caller that asked for it, so we propagate it
 * (R28P1). Returns true if the error is a tolerable "directory fsync unsupported"
 * condition. Exported for unit testing.
 */
export function isUnsupportedDirFsyncError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  // Only codes that mean the OPERATION itself is unsupported on this FS/OS:
  // EINVAL/ENOTSUP/EOPNOTSUPP (fsync-on-dir not implemented), EBADF/EISDIR (some
  // platforms reject the directory fd for fsync). NOT EACCES/EPERM — those are
  // access-control failures, not "unsupported," and swallowing them would let a
  // durability-required ledger write report success without a durable dir entry
  // (R28P3). Real I/O errors (EIO/ENOSPC/EROFS/…) also fall through → propagate.
  return code === 'EINVAL' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EBADF' || code === 'EISDIR';
}

export function atomicWriteFileSync(destPath: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): void {
  // Per-call-unique temp name: pid+time collide if two writes to the same dest
  // land in the same millisecond in one process — with O_EXCL the loser would
  // EEXIST and its cleanup could rmSync the winner's in-flight temp. randomUUID
  // makes each call's temp unique so concurrent same-dest writes never clash.
  const tmp = `${destPath}.tmp-${process.pid}-${randomUUID()}`;
  const mode = opts.mode ?? 0o666;
  try {
    if (O_NOFOLLOW === 0) {
      // Platform without O_NOFOLLOW (Windows): the symlink-swap threat model
      // differs and Kai is macOS-first. Guard with an lstat (the temp should not
      // pre-exist at all) then write.
      if (existsSync(tmp) && lstatSync(tmp).isSymbolicLink()) {
        throw new Error(`Refusing to write through a symlink at ${tmp}`);
      }
      writeFileSync(tmp, data, opts.mode !== undefined ? { mode: opts.mode } : undefined);
      // Honor the durability guarantee on this path too (R34P2): writeFileSync by
      // path does NOT flush to disk, so without an explicit fsync the temp's
      // contents can be lost on crash/power-loss before the rename — the exact
      // failure the ledger's `fsync: true` is meant to prevent. Open the just-
      // written temp and fsync it; a failure PROPAGATES (same as the O_NOFOLLOW
      // branch) so a durability-mode caller can refuse to proceed rather than
      // falsely report a durable write.
      if (opts.fsync) {
        const fd = openSync(tmp, fsConstants.O_RDWR);
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    } else {
      const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW;
      let fd: number;
      try {
        fd = openSync(tmp, flags, mode);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ELOOP' || code === 'EEXIST') {
          throw new Error(`Refusing to write temp file at ${tmp} (pre-existing file or symlink)`);
        }
        throw err;
      }
      try {
        // writeFileSync on an fd performs the full write loop (a bare writeSync
        // can short-write), so content can't be silently truncated.
        writeFileSync(fd, data);
        // Flush the temp file's contents to disk BEFORE the rename when durability
        // is requested — rename is atomic but not durable (opts.fsync). A fsync
        // FAILURE here means the write may not survive power loss, which for a
        // durability-mode caller (the post-update ledger, written right before the
        // app quits) is a real failure — let it propagate so the caller can refuse
        // to proceed rather than falsely reporting a durable write (R35P1).
        if (opts.fsync) fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    // O_EXCL/create mode can be masked by umask on some platforms; chmod to be
    // certain the secret file is exactly `mode` before it becomes visible.
    if (opts.mode !== undefined) {
      try {
        chmodSync(tmp, opts.mode);
      } catch {
        /* best-effort on platforms without POSIX perms */
      }
    }
    renameSync(tmp, destPath);
    // Flush the directory entry so the rename survives power loss. This is
    // BEST-EFFORT and NEVER propagates (R28P25): the rename has ALREADY made the
    // new file visible, so the write is COMMITTED regardless of whether the dir
    // entry is flushed. Throwing here would misreport a committed write as failed —
    // and for the post-update ledger that produces FALSE cleanup debt (the entry is
    // on disk, but `recordAttempt` returns false → the updater aborts thinking
    // nothing was written, then a later launch runs spurious success:false cleanup).
    // The durability guarantee callers rely on is the FILE-CONTENTS fsync BEFORE the
    // rename (propagated above); the residual power-loss risk that only the rename
    // dir-entry (not the fsync'd contents) is lost is accepted, same as any atomic
    // rename. `isUnsupportedDirFsyncError` still classifies the log message.
    if (opts.fsync) {
      let dirFd: number | null = null;
      try {
        dirFd = openSync(dirname(destPath), fsConstants.O_RDONLY);
        fsyncSync(dirFd);
      } catch (e) {
        const kind = isUnsupportedDirFsyncError(e) ? 'unsupported on this FS' : 'failed (write already committed)';
        console.error(`[atomic-write] fsync of parent directory ${kind} (continuing best-effort):`, e);
      } finally {
        if (dirFd !== null) {
          try {
            closeSync(dirFd);
          } catch {
            /* */
          }
        }
      }
    }
  } catch (err) {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

/** Async counterpart used by browser metadata fed by untrusted page events.
 * File-system work stays off Electron's main thread while retaining the same
 * sibling-temp, no-follow, restrictive-mode, and atomic-rename guarantees. */
export async function atomicWriteFile(
  destPath: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const tmp = `${destPath}.tmp-${process.pid}-${randomUUID()}`;
  const mode = opts.mode ?? 0o666;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW;
    try {
      handle = await open(tmp, flags, mode);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ELOOP' || code === 'EEXIST') {
        throw new Error(`Refusing to write temp file at ${tmp} (pre-existing file or symlink)`);
      }
      throw err;
    }
    await handle.writeFile(data);
    // Honor `fsync` here too (R28P49): the option is shared with the sync writer, so
    // an async caller passing { fsync: true } must get the same power-loss
    // durability guarantee — flush the file CONTENTS before the rename while the fd
    // is still open. A failure PROPAGATES (that's the guarantee). The parent-dir
    // fsync (after rename) is best-effort, matching the sync writer (R28P25).
    if (opts.fsync) await handle.sync();
    await handle.close();
    handle = null;
    if (opts.mode !== undefined) {
      try {
        await chmod(tmp, opts.mode);
      } catch {
        /* best-effort on platforms without POSIX perms */
      }
    }
    await rename(tmp, destPath);
    if (opts.fsync) {
      // Best-effort directory flush so the rename entry survives power loss. Never
      // propagates: the rename already committed the write (R28P25/R28P49).
      let dirHandle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        dirHandle = await open(dirname(destPath), fsConstants.O_RDONLY);
        await dirHandle.sync();
      } catch (e) {
        console.error('[atomic-write] async fsync of parent directory failed (write already committed):', e);
      } finally {
        if (dirHandle) {
          try {
            await dirHandle.close();
          } catch {
            /* */
          }
        }
      }
    }
  } catch (err) {
    try {
      await closeAsyncHandle(handle);
    } catch {
      /* ignore close failure while preserving the original error */
    }
    try {
      await rm(tmp, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

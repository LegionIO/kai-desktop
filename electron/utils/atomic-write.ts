import {
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
  openSync,
  closeSync,
  lstatSync,
  chmodSync,
  constants as fsConstants,
} from 'fs';
import { randomUUID } from 'crypto';

export interface AtomicWriteOptions {
  /**
   * POSIX file mode to enforce on the final file (e.g. 0o600 for secret-bearing
   * files). The temp file is created AND chmod'd to this mode before the rename,
   * so the destination never passes through a wider-than-intended permission
   * window — important when the payload contains secrets (API keys, passwords).
   * Applied best-effort; ignored on platforms without POSIX perms.
   */
  mode?: number;
}

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

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
  } catch (err) {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

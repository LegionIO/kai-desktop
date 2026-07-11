import { writeFileSync, renameSync, existsSync, rmSync, chmodSync } from 'fs';

export interface AtomicWriteOptions {
  /**
   * POSIX file mode to enforce on the final file (e.g. 0o600 for secret-bearing
   * files). The temp file is chmod'd to this mode BEFORE the rename, so the
   * destination never passes through a wider-than-intended permission window —
   * important when the payload contains secrets (API keys, passwords). Applied
   * best-effort; ignored on platforms without POSIX perms.
   */
  mode?: number;
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
 * When `opts.mode` is set, the temp file is created AND chmod'd to that mode
 * before the rename, so a secret file lands at its target already restricted —
 * no brief world-readable window (which a plain writeFileSync + post-chmod, or
 * a rename of a default-umask temp, would expose).
 */
export function atomicWriteFileSync(destPath: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): void {
  const tmp = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    // Create the temp with the restricted mode up front (honored on create),
    // then chmod to be robust against umask masking the create mode.
    writeFileSync(tmp, data, opts.mode !== undefined ? { mode: opts.mode } : undefined);
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

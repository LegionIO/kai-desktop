import { writeFileSync, renameSync, existsSync, rmSync } from 'fs';

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
 */
export function atomicWriteFileSync(destPath: string, data: string | Uint8Array): void {
  const tmp = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, data);
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

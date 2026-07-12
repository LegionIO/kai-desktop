import { realpathSync, openSync, fstatSync, readSync, closeSync, constants } from 'fs';
import { sep } from 'path';

/**
 * Read a file that MUST resolve inside `rootDir`, resistant to symlink-based
 * escapes and TOCTOU swaps. Returns the file bytes, or null if the path escapes
 * the root, is not a regular file, or can't be read.
 *
 * Both `rootDir` and `filePath` are canonicalized with realpath first (so a
 * legitimately-symlinked root still matches), then containment is re-checked on
 * the canonical paths — a lexical check on the request path alone does not guard
 * the on-disk link target. The actual read goes through a single fd opened with
 * O_NOFOLLOW: after realpath every ancestor is already canonical, so O_NOFOLLOW
 * makes the open fail if the final node was swapped to a symlink between the
 * check and the open, and the fd is bound to the inode so a later swap can't
 * redirect the read. Callers must supply an already lexically-contained
 * `filePath` (e.g. join(rootDir, sanitizedRelPath)); this closes the residual
 * symlink/TOCTOU window on top of that.
 */
export function safeReadFileWithin(rootDir: string, filePath: string): Buffer | null {
  let realPath: string;
  let realRoot: string;
  try {
    realPath = realpathSync(filePath);
    realRoot = realpathSync(rootDir);
  } catch {
    return null;
  }
  if (realPath !== realRoot && !realPath.startsWith(realRoot + sep)) {
    return null;
  }

  let fd: number | null = null;
  try {
    fd = openSync(realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const data = Buffer.allocUnsafe(st.size);
    let offset = 0;
    while (offset < st.size) {
      const bytesRead = readSync(fd, data, offset, st.size - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return offset === st.size ? data : data.subarray(0, offset);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

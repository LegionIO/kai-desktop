import { realpathSync, openSync, fstatSync, readSync, closeSync, constants } from 'fs';
import { sep } from 'path';

export function resolveBoundedSuffixRange(
  size: number,
  requestedBytes: number,
  maxBytes: number,
): { start: number; end: number } | null {
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !Number.isSafeInteger(requestedBytes) ||
    requestedBytes <= 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  ) {
    return null;
  }
  const length = Math.min(size, requestedBytes, maxBytes);
  return { start: size - length, end: size - 1 };
}

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

/**
 * Symlink/TOCTOU-safe RANGE read within `rootDir` (R171). Reads only bytes [start, end] (inclusive)
 * of the contained file, so serving a media file for a `Range` request never buffers the WHOLE file
 * (a `preload="metadata"` video request would otherwise allocate the full — up to 512MiB — file).
 * Returns `{ data, size, start, end }` (size = total file size, for the Content-Range header), or
 * null on any containment/read failure. An unsatisfiable range (start >= size) returns null so the
 * caller can answer 416.
 */
export function safeReadRangeWithin(
  rootDir: string,
  filePath: string,
  start: number,
  end: number,
): { data: Buffer; size: number; start: number; end: number } | null {
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
    const size = st.size;
    if (size === 0 || start >= size || start < 0) return null;
    const clampedEnd = Math.min(end, size - 1);
    if (clampedEnd < start) return null;
    const length = clampedEnd - start + 1;
    const data = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const bytesRead = readSync(fd, data, offset, length - offset, start + offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    const slice = offset === length ? data : data.subarray(0, offset);
    return { data: slice, size, start, end: start + slice.length - 1 };
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

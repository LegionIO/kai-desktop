import { openSync, fstatSync, readSync, writeSync, closeSync, realpathSync, constants } from 'fs';
import { dirname, resolve, sep } from 'path';

/** Max bytes for a skill manifest (skill.json). */
export const SKILL_MANIFEST_MAX_BYTES = 256 * 1024;
/** Max bytes for any single additional skill file surfaced via get/read. */
export const SKILL_FILE_MAX_BYTES = 1024 * 1024;

/**
 * Read a file that must live inside a skill directory, safely:
 *  - resolves the skill root with realpath (canonical, symlink-free ancestors),
 *  - opens the target with O_NOFOLLOW so a symlinked LEAF can't redirect the
 *    read outside the skill root (a swapped symlink is rejected at open time),
 *  - fstat's the opened fd: rejects non-regular files and anything over maxBytes,
 *  - re-verifies (via the fd's realpath) the file is contained in the skill root.
 *
 * Returns null on any violation (missing, symlink, too big, not a regular file,
 * escapes the root) rather than throwing, so callers can skip/omit the file.
 */
export function readContainedFileSync(skillDir: string, absPath: string, maxBytes: number): string | null {
  let skillRoot: string;
  try {
    skillRoot = realpathSync(skillDir);
  } catch {
    return null;
  }

  const target = resolve(absPath);

  let fd: number | null = null;
  try {
    // O_NOFOLLOW: fail if the final path component is a symlink.
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size > maxBytes) return null;

    // Confirm the opened file's REAL path is under the (real) skill root. Compare
    // canonical forms on both sides so a symlinked tmpdir ancestor (e.g. macOS
    // /var → /private/var) doesn't cause a false containment failure, while a
    // genuine escape (a file whose realpath leaves the root) is still rejected.
    //
    // Residual (accepted): this re-resolves the PATHNAME, not the fd, so a
    // local attacker who can write inside the skill tree could in principle race
    // an intermediate-directory symlink between openSync and this check. A full
    // fix needs fd-anchored traversal (openat per component / F_GETPATH), which
    // Node doesn't expose portably. The skill root is the user's own
    // ~/.kai/skills (attacker needs local write access there), so the practical
    // risk is low; O_NOFOLLOW already pins the leaf inode we actually read.
    let realTarget: string;
    try {
      realTarget = realpathSync(target);
    } catch {
      return null;
    }
    if (realTarget !== skillRoot && !realTarget.startsWith(skillRoot + sep)) return null;

    const buf = Buffer.allocUnsafe(st.size);
    let offset = 0;
    while (offset < st.size) {
      const bytesRead = readSync(fd, buf, offset, st.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    // A short/premature EOF means the file changed under us or was truncated —
    // don't hand back a silently-partial manifest/file. Require a full read.
    if (offset !== st.size) return null;
    return buf.subarray(0, offset).toString('utf-8');
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
 * Write a file that must live directly inside a skill directory, safely:
 *  - resolves the skill root with realpath,
 *  - requires the target's PARENT to be the (real) skill root — rejects nested
 *    paths and any target whose parent resolves elsewhere,
 *  - opens with O_NOFOLLOW so an existing symlink at the target path is NOT
 *    followed to write outside the root (a planted symlink is rejected).
 *
 * Throws on any containment/symlink violation so a rejected write never lands
 * outside the skill root. `mode` sets the create permission bits.
 */
export function writeContainedFileSync(skillDir: string, absPath: string, data: string, mode = 0o644): void {
  const skillRoot = realpathSync(skillDir);
  const target = resolve(absPath);

  // The parent directory must resolve to the real skill root (writes are only
  // ever direct children of the skill dir — no nested dirs, no traversal).
  let realParent: string;
  try {
    realParent = realpathSync(dirname(target));
  } catch {
    throw new Error(`Skill file parent does not exist: ${absPath}`);
  }
  if (realParent !== skillRoot) {
    throw new Error(`Skill file "${absPath}" escapes the skill directory`);
  }

  // O_NOFOLLOW: if the target already exists as a symlink, opening fails (ELOOP)
  // rather than following it to an out-of-root destination.
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
  const fd = openSync(target, flags, mode);
  try {
    const buf = Buffer.from(data, 'utf-8');
    let offset = 0;
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

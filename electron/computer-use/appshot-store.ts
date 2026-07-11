/**
 * Appshot store (#81) — fs-based persisted screenshot store. No Electron import
 * so it is unit-testable against a temp dir.
 *
 * Layout (all under `~/.kai/data/appshots/`, created mode 0o700):
 *   index.json          — AppshotIndex metadata (atomic write)
 *   <id>.jpg            — image bytes, one file per appshot
 *
 * Security posture (Cerberus must-fixes, see ADR-0004):
 *  - Every id-keyed op validates APPSHOT_ID_RE BEFORE any path.join.
 *  - Reads lstat + realpath-confine + verify JPEG magic bytes (reject symlinks
 *    / files escaping the dir / non-JPEG planted at <id>.jpg).
 *  - Write-image-then-index ordering; a crash between leaves an orphan image
 *    that retention GCs. Corrupt index.json recovers to empty (not wiped mid-op).
 *  - Retention: byte ceiling re-checked after write with rollback; pinned items
 *    are exempt from age/count eviction but STILL count toward the byte ceiling.
 */

import {
  mkdirSync,
  readFileSync,
  existsSync,
  realpathSync,
  rmSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
  constants as fsConstants,
} from 'fs';
import { join, sep } from 'path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { makeComputerUseId } from '../../shared/computer-use.js';
import {
  type Appshot,
  type AppshotIndex,
  type AppshotMetadata,
  type CreateAppshotInput,
  APPSHOT_ID_RE,
  isValidAppshotId,
  isValidImageRef,
  appshotImageFilename,
} from '../../shared/appshots.js';

export interface AppshotRetentionConfig {
  maxCount: number;
  maxAgeDays: number;
  maxTotalBytes: number;
}

export interface AppshotStore {
  create(input: CreateAppshotInput, retention: AppshotRetentionConfig): Appshot;
  list(): Appshot[];
  get(id: string): Appshot | null;
  /** Returns a `data:image/jpeg;base64,…` URL, or null if missing/invalid. */
  getImage(id: string): string | null;
  delete(id: string): boolean;
  deleteAll(): void;
  update(id: string, patch: { tags?: string[]; pinned?: boolean }): Appshot | null;
  enforceRetention(retention: AppshotRetentionConfig): void;
}

const INDEX_FILE = 'index.json';
const MAX_TAGS = 50;
const MAX_TAG_LEN = 100;
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

export function createAppshotStore(appHome: string): AppshotStore {
  const dir = join(appHome, 'data', 'appshots');
  const indexPath = join(dir, INDEX_FILE);

  function ensureDir(): void {
    // 0o700: appshots may contain sensitive screen content; inherit only
    // filesystem permissions (no encryption-at-rest — see ADR-0004).
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  function readIndex(): AppshotIndex {
    try {
      if (!existsSync(indexPath)) return { version: 1, appshots: [] };
      const parsed = JSON.parse(readFileSync(indexPath, 'utf-8')) as AppshotIndex;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.appshots)) {
        // Corrupt/unknown shape — recover to empty rather than throwing. The
        // on-disk file is NOT wiped here; the next successful write replaces it.
        return { version: 1, appshots: [] };
      }
      // Drop entries with a bad id or imageRef (defensive: index.json is on a
      // user-writable path and must never be trusted for path construction).
      const clean = parsed.appshots.filter((a) => isValidAppshotId(a?.id) && isValidImageRef(a?.imageRef));
      return { version: 1, appshots: clean };
    } catch {
      return { version: 1, appshots: [] };
    }
  }

  function writeIndex(index: AppshotIndex): void {
    ensureDir();
    atomicWriteFileSync(indexPath, JSON.stringify(index, null, 2), { mode: 0o600 });
  }

  /**
   * Read an appshot image atomically through a SINGLE fd (no TOCTOU): open with
   * O_NOFOLLOW so a symlink at the final path is rejected at open time, then
   * fstat + read magic + read content all from that same fd — a swap between
   * checks and read is impossible because every check is on the open fd, not a
   * re-resolved path. Returns the JPEG bytes, or null if missing/symlink/
   * non-regular/non-JPEG. Also confirms the containing dir's realpath stays
   * inside the fixed appshots dir (guards a symlinked base dir).
   */
  function readImageBytes(id: string): Buffer | null {
    if (!isValidAppshotId(id)) return null;
    const p = join(dir, appshotImageFilename(id));
    let fd: number | null = null;
    try {
      // O_NOFOLLOW: fail (ELOOP) if the final component is a symlink.
      const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
      fd = openSync(p, fsConstants.O_RDONLY | O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isFile()) return null; // reject non-regular (dir/fifo/etc.)
      // Confine: the opened file's realpath must live inside the appshots dir.
      const real = realpathSync(p);
      const realDir = realpathSync(dir);
      if (real !== join(realDir, appshotImageFilename(id)) && !real.startsWith(realDir + sep)) return null;
      const size = st.size;
      if (size < 3) return null;
      const buf = Buffer.alloc(size);
      let off = 0;
      while (off < size) {
        const n = readSync(fd, buf, off, size - off, off);
        if (n <= 0) break;
        off += n;
      }
      if (off < size) return null;
      // JPEG magic on the bytes we actually read (same fd — no re-open).
      if (buf[0] !== JPEG_MAGIC[0] || buf[1] !== JPEG_MAGIC[1] || buf[2] !== JPEG_MAGIC[2]) return null;
      return buf;
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

  function sanitizeTags(tags: unknown): string[] {
    if (!Array.isArray(tags)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const t of tags) {
      if (typeof t !== 'string') continue;
      const tag = t.trim().slice(0, MAX_TAG_LEN);
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
      if (out.length >= MAX_TAGS) break;
    }
    return out;
  }

  function sanitizeMetadata(meta: AppshotMetadata): AppshotMetadata {
    const clean: AppshotMetadata = {};
    if (typeof meta.appName === 'string') clean.appName = meta.appName.slice(0, 500);
    if (typeof meta.windowTitle === 'string') clean.windowTitle = meta.windowTitle.slice(0, 1000);
    if (typeof meta.visibleText === 'string') clean.visibleText = meta.visibleText.slice(0, 100000);
    if (typeof meta.triggeringAction === 'string') clean.triggeringAction = meta.triggeringAction.slice(0, 200);
    if (meta.display && typeof meta.display === 'object') {
      const d = meta.display;
      if (typeof d.index === 'number' && typeof d.width === 'number' && typeof d.height === 'number') {
        clean.display = { index: d.index, width: d.width, height: d.height };
      }
    }
    return clean;
  }

  /** Actual on-disk size of an appshot's image (0 if missing/unreadable). */
  function imageDiskBytes(id: string): number {
    try {
      return statSync(join(dir, appshotImageFilename(id))).size;
    } catch {
      return 0;
    }
  }

  /** Total bytes from ACTUAL image files on disk (never trust index imageBytes). */
  function totalBytes(index: AppshotIndex): number {
    return index.appshots.reduce((sum, a) => sum + imageDiskBytes(a.id), 0);
  }

  function removeImage(id: string): void {
    if (!isValidAppshotId(id)) return;
    try {
      rmSync(join(dir, appshotImageFilename(id)), { force: true });
    } catch {
      /* best-effort */
    }
  }

  /**
   * Scan the appshots dir and delete any `<id>.jpg` NOT referenced by the index
   * (orphans from a crash between image-write and index-commit, or a stray file).
   * Keeps the byte ceiling honest and prevents unbounded orphan growth.
   */
  function gcOrphanImages(index: AppshotIndex): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const referenced = new Set(index.appshots.map((a) => a.imageRef));
    for (const name of entries) {
      if (name === INDEX_FILE) continue;
      if (!name.endsWith('.jpg')) continue;
      if (referenced.has(name)) continue;
      try {
        rmSync(join(dir, name), { force: true });
      } catch {
        /* best-effort */
      }
    }
  }

  function enforceRetention(retention: AppshotRetentionConfig): void {
    const index = readIndex();
    const before = index.appshots.length;
    // The index array is stored in INSERTION order (create() appends), which is
    // the chronological ground truth — front = oldest. We rely on array position
    // rather than re-sorting by createdAt, since same-millisecond creates share
    // a createdAt and would sort unstably.
    const now = Date.now();
    const maxAgeMs = retention.maxAgeDays * 24 * 60 * 60 * 1000;

    // First drop too-old unpinned entries (age eviction is position-independent).
    const ageKept =
      retention.maxAgeDays > 0
        ? index.appshots.filter((a) => a.pinned || now - new Date(a.createdAt).getTime() <= maxAgeMs)
        : [...index.appshots];

    // Then enforce the unpinned COUNT ceiling by dropping the OLDEST unpinned
    // (front-most) until at or under maxCount. Pinned entries are exempt.
    const kept: Appshot[] = [...ageKept];
    if (retention.maxCount > 0) {
      let unpinned = kept.filter((a) => !a.pinned).length;
      let i = 0;
      while (unpinned > retention.maxCount && i < kept.length) {
        if (!kept[i].pinned) {
          kept.splice(i, 1);
          unpinned--;
        } else {
          i++;
        }
      }
    }

    // Then enforce the BYTE ceiling (measured from actual disk sizes). Evict the
    // oldest UNPINNED entries until at or under the limit. Pinned entries are
    // exempt from eviction but still COUNT toward the total (so a pinned-heavy
    // store simply stays over — matching the create()-time rollback semantics).
    if (retention.maxTotalBytes > 0) {
      let total = kept.reduce((sum, a) => sum + imageDiskBytes(a.id), 0);
      let i = 0;
      while (total > retention.maxTotalBytes && i < kept.length) {
        if (!kept[i].pinned) {
          total -= imageDiskBytes(kept[i].id);
          kept.splice(i, 1);
        } else {
          i++;
        }
      }
    }

    const keptIds = new Set(kept.map((a) => a.id));
    const evicted = index.appshots.filter((a) => !keptIds.has(a.id));
    if (evicted.length > 0 || kept.length !== before) {
      writeIndex({ version: 1, appshots: kept });
      for (const a of evicted) removeImage(a.id);
    }
    // Always sweep orphan image files (crash-created or index-absent).
    gcOrphanImages({ version: 1, appshots: kept });
  }

  return {
    create(input, retention) {
      ensureDir();
      const id = makeComputerUseId('appshot');
      const imageRef = appshotImageFilename(id);
      const imagePath = join(dir, imageRef);

      // Write image FIRST (fsync via atomic rename), then commit the index entry
      // that references it. A crash in between leaves an orphan image that
      // retention GCs — never a dangling index entry pointing at a missing file.
      atomicWriteFileSync(imagePath, input.imageData, { mode: 0o600 });

      const appshot: Appshot = {
        id,
        createdAt: new Date().toISOString(),
        imageRef,
        imageBytes: input.imageData.byteLength,
        conversationId: input.conversationId,
        metadata: sanitizeMetadata(input.metadata),
        tags: [],
        pinned: false,
      };

      const index = readIndex();
      index.appshots.push(appshot);
      writeIndex(index);

      // Age/count retention first, then the byte ceiling.
      enforceRetention(retention);

      // Disk-DoS ceiling: re-check total bytes AFTER the write. If still over
      // (e.g. a pinned-heavy store), roll back THIS newly-created appshot.
      if (retention.maxTotalBytes > 0) {
        const after = readIndex();
        if (totalBytes(after) > retention.maxTotalBytes && after.appshots.some((a) => a.id === id)) {
          writeIndex({ version: 1, appshots: after.appshots.filter((a) => a.id !== id) });
          removeImage(id);
        }
      }

      return appshot;
    },

    list() {
      return readIndex().appshots;
    },

    get(id) {
      if (!isValidAppshotId(id)) return null;
      return readIndex().appshots.find((a) => a.id === id) ?? null;
    },

    getImage(id) {
      const bytes = readImageBytes(id);
      if (!bytes) return null;
      return `data:image/jpeg;base64,${bytes.toString('base64')}`;
    },

    delete(id) {
      if (!isValidAppshotId(id)) return false;
      const index = readIndex();
      const next = index.appshots.filter((a) => a.id !== id);
      if (next.length === index.appshots.length) return false;
      writeIndex({ version: 1, appshots: next });
      removeImage(id);
      return true;
    },

    deleteAll() {
      const index = readIndex();
      writeIndex({ version: 1, appshots: [] });
      for (const a of index.appshots) removeImage(a.id);
    },

    update(id, patch) {
      if (!isValidAppshotId(id)) return null;
      const index = readIndex();
      const idx = index.appshots.findIndex((a) => a.id === id);
      if (idx < 0) return null;
      const current = index.appshots[idx];
      // Allowlist: only tags + pinned are mutable. imageRef/id/createdAt/etc.
      // can never be overwritten via update().
      const updated: Appshot = {
        ...current,
        ...(patch.tags !== undefined ? { tags: sanitizeTags(patch.tags) } : {}),
        ...(patch.pinned !== undefined ? { pinned: Boolean(patch.pinned) } : {}),
      };
      index.appshots[idx] = updated;
      writeIndex(index);
      return updated;
    },

    enforceRetention,
  };
}

export { APPSHOT_ID_RE };

/**
 * Extract JPEG bytes from a `data:image/jpeg;base64,…` URL. Returns null for
 * non-JPEG or malformed data URLs (so a PNG/webp frame isn't stored as .jpg).
 */
export function jpegBytesFromDataUrl(dataUrl: string): Uint8Array | null {
  const m = /^data:image\/jpe?g;base64,(.+)$/i.exec(dataUrl);
  if (!m) return null;
  try {
    const bytes = Buffer.from(m[1], 'base64');
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
    return new Uint8Array(bytes);
  } catch {
    return null;
  }
}

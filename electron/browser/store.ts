import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BrowserBookmark,
  BrowserDownload,
  BrowserHistoryEntry,
  BrowserProfilePersistenceArea,
  BrowserSitePermission,
} from '../../shared/browser.js';
import { atomicWriteFile, atomicWriteFileSync } from '../utils/atomic-write.js';
import { boundedBrowserTitle, boundedBrowserUrl } from './metadata.js';

const MAX_HISTORY = 1_000;
const MAX_HISTORY_TITLE_CHARS = 512;
const MAX_HISTORY_URL_CHARS = 8 * 1_024;
const MAX_HISTORY_TOTAL_CHARS = 2 * 1_024 * 1_024;
const HISTORY_SAVE_DEBOUNCE_MS = 500;
const MAX_DOWNLOADS = 1_000;
const MAX_DOWNLOAD_ID_CHARS = 128;
const MAX_DOWNLOAD_TAB_ID_CHARS = 128;
const MAX_DOWNLOAD_FILENAME_CHARS = 4 * 1_024;
const MAX_DOWNLOAD_PATH_CHARS = 32 * 1_024;
const DOWNLOAD_SAVE_DEBOUNCE_MS = 500;
export const MAX_BOOKMARKS = 10_000;
export const MAX_BOOKMARK_FOLDER_DEPTH = 32;
export const MAX_BOOKMARK_FOLDER_CHARS = 2_048;
export const MAX_BOOKMARK_SERIALIZED_BYTES = 8 * 1_024 * 1_024;
export const MAX_BROWSER_PROFILE_BYTES = 16 * 1_024 * 1_024;
export const MAX_BROWSER_HISTORY_BYTES = 4 * 1_024 * 1_024;
export const MAX_BROWSER_DOWNLOAD_BYTES = 16 * 1_024 * 1_024;
export const MAX_PERMISSION_ORIGINS = 1_000;
export const MAX_PERMISSIONS_PER_ORIGIN = 64;
const MAX_PERMISSION_ORIGIN_CHARS = 2_048;
const MAX_PERMISSION_NAME_CHARS = 256;
const MAX_PERMISSION_SERIALIZED_BYTES = 1 * 1_024 * 1_024;
const MAX_UNSAFE_ORIGINS = 1_000;
const MAX_UNSAFE_ORIGIN_CHARS = 2_048;
const DOWNLOAD_STATES = new Set<BrowserDownload['state']>(['progressing', 'completed', 'cancelled', 'interrupted']);

type BrowserProfileData = {
  version: 1;
  history: BrowserHistoryEntry[];
  bookmarks: BrowserBookmark[];
  downloads: BrowserDownload[];
  permissions: Record<string, Record<string, 'allow' | 'deny'>>;
  zoomLevel: number;
  /** At least one service worker in this profile was registered from an
   * assistant-controlled page. Electron omits WebContents attribution for its
   * background requests, so the profile must retain the stricter policy. */
  backgroundNetworkRestricted: boolean;
  /** Page origins whose persistent non-cookie storage may contain responses
   * fetched from a destination disallowed by the assistant network policy. */
  unsafeOrigins: string[];
  /** Origins at which arbitrary assistant evaluation may have installed or
   * replaced a persistent service worker. A renderer cannot be recreated until
   * Chromium confirms that the registration has been removed. */
  scriptCleanupOrigins: string[];
};

type BrowserHistoryData = {
  version: 1;
  history: BrowserHistoryEntry[];
};

type BrowserDownloadsData = {
  version: 1;
  downloads: BrowserDownload[];
};

type RemoveProfileFile = (path: string, options: { force: boolean }) => Promise<void>;

const EMPTY_DATA: BrowserProfileData = {
  version: 1,
  history: [],
  bookmarks: [],
  downloads: [],
  permissions: {},
  zoomLevel: 0,
  backgroundNetworkRestricted: false,
  unsafeOrigins: [],
  scriptCleanupOrigins: [],
};

function safeScopeKey(value: string): string {
  if (!/^(global|conversation-[a-f0-9]{24})$/.test(value)) throw new Error('Invalid browser profile key.');
  return value;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isHistoryEntry(value: unknown, scopeKey: string): value is BrowserHistoryEntry {
  return (
    isRecord(value) &&
    value.scopeKey === scopeKey &&
    ['id', 'title', 'url', 'visitedAt'].every((key) => typeof value[key] === 'string')
  );
}

function boundedHistory(entries: BrowserHistoryEntry[]): BrowserHistoryEntry[] {
  const bounded: BrowserHistoryEntry[] = [];
  let totalChars = 0;
  for (const entry of entries) {
    if (bounded.length >= MAX_HISTORY) break;
    const normalized = {
      ...entry,
      title: boundedBrowserTitle(entry.title, entry.url).slice(0, MAX_HISTORY_TITLE_CHARS),
      url: boundedBrowserUrl(entry.url).slice(0, MAX_HISTORY_URL_CHARS),
    };
    const size =
      normalized.id.length +
      normalized.scopeKey.length +
      normalized.title.length +
      normalized.url.length +
      normalized.visitedAt.length;
    if (totalChars + size > MAX_HISTORY_TOTAL_CHARS) break;
    totalChars += size;
    bounded.push(normalized);
  }
  return bounded;
}

function isBookmark(value: unknown, scopeKey: string): value is BrowserBookmark {
  return (
    isRecord(value) &&
    value.scopeKey === scopeKey &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.url === 'string' &&
    typeof value.folder === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    value.id.length <= 128 &&
    value.createdAt.length <= 64 &&
    value.updatedAt.length <= 64
  );
}

function boundedBookmarkFolder(folder: string): string {
  const segments = folder
    .slice(0, MAX_BOOKMARK_FOLDER_CHARS)
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .slice(0, MAX_BOOKMARK_FOLDER_DEPTH);
  return segments.join('/').slice(0, MAX_BOOKMARK_FOLDER_CHARS);
}

function normalizedBookmark(bookmark: BrowserBookmark): BrowserBookmark {
  const url = boundedBrowserUrl(bookmark.url);
  return {
    ...bookmark,
    title: boundedBrowserTitle(bookmark.title, url),
    url,
    folder: boundedBookmarkFolder(bookmark.folder),
  };
}

function bookmarkBytes(bookmark: BrowserBookmark): number {
  return Buffer.byteLength(JSON.stringify(bookmark), 'utf8');
}

function boundedBookmarks(bookmarks: BrowserBookmark[]): BrowserBookmark[] {
  const bounded: BrowserBookmark[] = [];
  let serializedBytes = 2;
  for (const bookmark of bookmarks) {
    if (bounded.length >= MAX_BOOKMARKS) break;
    const normalized = normalizedBookmark(bookmark);
    const bytes = bookmarkBytes(normalized) + (bounded.length > 0 ? 1 : 0);
    if (serializedBytes + bytes > MAX_BOOKMARK_SERIALIZED_BYTES) break;
    serializedBytes += bytes;
    bounded.push(normalized);
  }
  return bounded;
}

function assertBookmarkBounds(bookmarks: BrowserBookmark[]): void {
  if (bookmarks.length > MAX_BOOKMARKS) {
    throw new Error(`Browser bookmark storage is limited to ${MAX_BOOKMARKS.toLocaleString()} entries.`);
  }
  let serializedBytes = 2;
  for (const bookmark of bookmarks) {
    if (
      bookmark.folder !== boundedBookmarkFolder(bookmark.folder) ||
      bookmark.folder.split('/').filter(Boolean).length > MAX_BOOKMARK_FOLDER_DEPTH
    ) {
      throw new Error('Browser bookmark folders exceed the allowed depth or size.');
    }
    serializedBytes += bookmarkBytes(bookmark) + (serializedBytes > 2 ? 1 : 0);
    if (serializedBytes > MAX_BOOKMARK_SERIALIZED_BYTES) {
      throw new Error('Browser bookmark storage exceeds the 8 MB metadata limit.');
    }
  }
}

function isDownload(value: unknown): value is BrowserDownload {
  return (
    isRecord(value) &&
    ['id', 'tabId', 'filename'].every((key) => typeof value[key] === 'string') &&
    typeof value.receivedBytes === 'number' &&
    Number.isFinite(value.receivedBytes) &&
    typeof value.totalBytes === 'number' &&
    Number.isFinite(value.totalBytes) &&
    typeof value.state === 'string' &&
    DOWNLOAD_STATES.has(value.state as BrowserDownload['state']) &&
    (value.quarantined === undefined || typeof value.quarantined === 'boolean') &&
    (value.path === undefined || typeof value.path === 'string') &&
    (value.url === undefined || typeof value.url === 'string')
  );
}

function normalizedDownload(download: BrowserDownload): BrowserDownload {
  return {
    ...download,
    id: download.id.slice(0, MAX_DOWNLOAD_ID_CHARS),
    tabId: download.tabId.slice(0, MAX_DOWNLOAD_TAB_ID_CHARS),
    filename: download.filename.slice(0, MAX_DOWNLOAD_FILENAME_CHARS),
    ...(download.path === undefined ? {} : { path: download.path.slice(0, MAX_DOWNLOAD_PATH_CHARS) }),
    ...(download.url === undefined ? {} : { url: boundedBrowserUrl(download.url) }),
  };
}

/** Keep newest-first download metadata within the exact compact sidecar
 * payload bound. This runs before publishing mutations so a large collection
 * cannot make the async writer fail and permanently latch the profile
 * read-only. */
function boundedDownloads(downloads: BrowserDownload[]): BrowserDownload[] {
  const bounded: BrowserDownload[] = [];
  const seenIds = new Set<string>();
  let serializedBytes = Buffer.byteLength(JSON.stringify({ version: 1, downloads: [] }), 'utf8');
  for (const download of downloads) {
    if (bounded.length >= MAX_DOWNLOADS) break;
    const normalized = normalizedDownload(download);
    if (seenIds.has(normalized.id)) continue;
    const bytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8') + (bounded.length > 0 ? 1 : 0);
    if (serializedBytes + bytes > MAX_BROWSER_DOWNLOAD_BYTES) break;
    serializedBytes += bytes;
    bounded.push(normalized);
    seenIds.add(normalized.id);
  }
  return bounded;
}

function assertPermissionBounds(value: unknown): asserts value is BrowserProfileData['permissions'] {
  if (!isRecord(value)) throw new Error('Invalid browser permission data.');
  const origins = Object.entries(value);
  if (origins.length > MAX_PERMISSION_ORIGINS) {
    throw new Error(`Browser permissions are limited to ${MAX_PERMISSION_ORIGINS.toLocaleString()} sites.`);
  }
  for (const [origin, permissions] of origins) {
    if (!origin || origin.length > MAX_PERMISSION_ORIGIN_CHARS || !isRecord(permissions)) {
      throw new Error('Browser permission metadata contains an invalid site.');
    }
    const entries = Object.entries(permissions);
    if (entries.length > MAX_PERMISSIONS_PER_ORIGIN) {
      throw new Error(`Browser permissions are limited to ${MAX_PERMISSIONS_PER_ORIGIN} entries per site.`);
    }
    for (const [permission, decision] of entries) {
      if (
        !permission ||
        permission.length > MAX_PERMISSION_NAME_CHARS ||
        (decision !== 'allow' && decision !== 'deny')
      ) {
        throw new Error('Browser permission metadata contains an invalid entry.');
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PERMISSION_SERIALIZED_BYTES) {
    throw new Error('Browser permission metadata exceeds its storage limit.');
  }
}

function isPermissions(value: unknown): value is BrowserProfileData['permissions'] {
  try {
    assertPermissionBounds(value);
    return true;
  } catch {
    return false;
  }
}

function isCanonicalHttpOrigin(value: string): boolean {
  if (!value || value.length > MAX_UNSAFE_ORIGIN_CHARS) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === '/' &&
      !parsed.search &&
      !parsed.hash &&
      parsed.origin === value
    );
  } catch {
    return false;
  }
}

function isUnsafeOrigins(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_UNSAFE_ORIGINS &&
    new Set(value).size === value.length &&
    value.every((origin) => typeof origin === 'string' && isCanonicalHttpOrigin(origin))
  );
}

function readBoundedJson(filePath: string, maxBytes: number): unknown {
  const descriptor = openSync(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error('Browser profile metadata must be a regular file.');
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > maxBytes) {
      throw new Error('Browser profile file exceeds its size limit.');
    }
    const contents = Buffer.allocUnsafe(metadata.size);
    let offset = 0;
    while (offset < contents.byteLength) {
      const bytesRead = readSync(descriptor, contents, offset, contents.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return JSON.parse(contents.subarray(0, offset).toString('utf8')) as unknown;
  } finally {
    closeSync(descriptor);
  }
}

async function readBoundedJsonAsync(filePath: string, maxBytes: number): Promise<unknown> {
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('Browser profile metadata must be a regular file.');
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > maxBytes) {
      throw new Error('Browser profile file exceeds its size limit.');
    }
    const contents = Buffer.allocUnsafe(metadata.size);
    let offset = 0;
    while (offset < contents.byteLength) {
      const { bytesRead } = await handle.read(contents, offset, contents.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return JSON.parse(contents.subarray(0, offset).toString('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

function assertSerializedBytes(serialized: string, maxBytes: number, area: string): void {
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`Browser ${area} metadata exceeds its storage limit.`);
  }
}

export class BrowserProfileStore {
  readonly scopeKey: string;
  private readonly filePath: string;
  private readonly historyFilePath: string;
  private readonly downloadsFilePath: string;
  private data: BrowserProfileData;
  private loadFailure: Error | null = null;
  private historyWriteFailure: Error | null = null;
  private downloadsWriteFailure: Error | null = null;
  private historySeparated = false;
  private downloadsSeparated = false;
  private historyRevision = 0;
  private persistedHistoryRevision = 0;
  private downloadsRevision = 0;
  private persistedDownloadsRevision = 0;
  private historySaveTimer: ReturnType<typeof setTimeout> | null = null;
  private downloadsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private historyWriteTail: Promise<void> = Promise.resolve();
  private downloadsWriteTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly appHome: string,
    scopeKey: string,
    private readonly removeProfileFile: RemoveProfileFile = rm,
    private readonly onPersistenceError?: (area: BrowserProfilePersistenceArea, error: Error) => void,
  ) {
    this.scopeKey = safeScopeKey(scopeKey);
    const directory = join(appHome, 'browser', 'profiles');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.filePath = join(directory, `${this.scopeKey}.json`);
    this.historyFilePath = join(directory, `${this.scopeKey}.history.json`);
    this.downloadsFilePath = join(directory, `${this.scopeKey}.downloads.json`);
    this.data = this.load();
    if (!this.loadFailure && !this.historySeparated && this.data.history.length > 0) this.scheduleHistorySave();
    if (!this.loadFailure && !this.downloadsSeparated && this.data.downloads.length > 0) this.scheduleDownloadsSave();
  }

  private load(): BrowserProfileData {
    try {
      let profile = structuredClone(EMPTY_DATA);
      if (existsSync(this.filePath)) {
        const parsed = readBoundedJson(this.filePath, MAX_BROWSER_PROFILE_BYTES) as Partial<BrowserProfileData>;
        if (
          parsed.version !== 1 ||
          !Array.isArray(parsed.history) ||
          !parsed.history.every((entry) => isHistoryEntry(entry, this.scopeKey)) ||
          !Array.isArray(parsed.bookmarks) ||
          !parsed.bookmarks.every((bookmark) => isBookmark(bookmark, this.scopeKey)) ||
          !Array.isArray(parsed.downloads) ||
          !parsed.downloads.every(isDownload) ||
          !isPermissions(parsed.permissions) ||
          typeof parsed.zoomLevel !== 'number' ||
          !Number.isFinite(parsed.zoomLevel) ||
          (parsed.backgroundNetworkRestricted !== undefined &&
            typeof parsed.backgroundNetworkRestricted !== 'boolean') ||
          (parsed.unsafeOrigins !== undefined && !isUnsafeOrigins(parsed.unsafeOrigins)) ||
          (parsed.scriptCleanupOrigins !== undefined && !isUnsafeOrigins(parsed.scriptCleanupOrigins))
        ) {
          throw new Error('Invalid browser profile data.');
        }
        profile = {
          version: 1,
          history: boundedHistory(parsed.history),
          bookmarks: boundedBookmarks(parsed.bookmarks),
          downloads: boundedDownloads(parsed.downloads),
          permissions: parsed.permissions,
          zoomLevel: parsed.zoomLevel,
          backgroundNetworkRestricted: parsed.backgroundNetworkRestricted ?? false,
          unsafeOrigins: parsed.unsafeOrigins ?? [],
          scriptCleanupOrigins: parsed.scriptCleanupOrigins ?? [],
        };
      }
      if (existsSync(this.historyFilePath)) {
        const parsedHistory = readBoundedJson(
          this.historyFilePath,
          MAX_BROWSER_HISTORY_BYTES,
        ) as Partial<BrowserHistoryData>;
        if (
          parsedHistory.version !== 1 ||
          !Array.isArray(parsedHistory.history) ||
          !parsedHistory.history.every((entry) => isHistoryEntry(entry, this.scopeKey))
        ) {
          throw new Error('Invalid browser history data.');
        }
        profile.history = boundedHistory(parsedHistory.history);
        this.historySeparated = true;
      }
      if (existsSync(this.downloadsFilePath)) {
        const parsedDownloads = readBoundedJson(
          this.downloadsFilePath,
          MAX_BROWSER_DOWNLOAD_BYTES,
        ) as Partial<BrowserDownloadsData>;
        if (
          parsedDownloads.version !== 1 ||
          !Array.isArray(parsedDownloads.downloads) ||
          !parsedDownloads.downloads.every(isDownload)
        ) {
          throw new Error('Invalid browser download data.');
        }
        profile.downloads = boundedDownloads(parsedDownloads.downloads);
        this.downloadsSeparated = true;
      }
      return profile;
    } catch {
      this.loadFailure = new Error(
        'The Browser profile is unreadable or corrupted and was not modified. Clear Browser data or restore the profile before saving browsing data.',
      );
      return structuredClone(EMPTY_DATA);
    }
  }

  private assertWritable(): void {
    if (this.loadFailure) throw this.loadFailure;
    if (this.historyWriteFailure) throw this.historyWriteFailure;
    if (this.downloadsWriteFailure) throw this.downloadsWriteFailure;
  }

  /** Persist a candidate snapshot before publishing it to in-memory readers. */
  private save(data: BrowserProfileData = this.data): void {
    this.assertWritable();
    assertBookmarkBounds(data.bookmarks);
    assertPermissionBounds(data.permissions);
    if (!isUnsafeOrigins(data.unsafeOrigins)) throw new Error('Invalid unsafe Browser-origin provenance.');
    if (!isUnsafeOrigins(data.scriptCleanupOrigins)) {
      throw new Error('Invalid Browser script-cleanup provenance.');
    }
    const persisted = {
      ...data,
      ...(this.historySeparated ? { history: [] } : {}),
      ...(this.downloadsSeparated ? { downloads: [] } : {}),
    };
    const serialized = JSON.stringify(persisted, null, 2);
    assertSerializedBytes(serialized, MAX_BROWSER_PROFILE_BYTES, 'profile');
    atomicWriteFileSync(this.filePath, serialized, { mode: 0o600 });
    this.data = data;
  }

  private scheduleHistorySave(delayMs = HISTORY_SAVE_DEBOUNCE_MS): void {
    this.assertWritable();
    this.historyRevision++;
    if (this.historySaveTimer) clearTimeout(this.historySaveTimer);
    this.historySaveTimer = setTimeout(() => {
      this.historySaveTimer = null;
      void this.enqueueHistorySave().catch(() => undefined);
    }, delayMs);
    this.historySaveTimer.unref?.();
  }

  private enqueueHistorySave(): Promise<void> {
    const operation = this.historyWriteTail.then(async () => {
      this.assertWritable();
      if (this.persistedHistoryRevision >= this.historyRevision) return;
      const revision = this.historyRevision;
      const payload: BrowserHistoryData = { version: 1, history: this.data.history.map((entry) => ({ ...entry })) };
      const serialized = JSON.stringify(payload);
      assertSerializedBytes(serialized, MAX_BROWSER_HISTORY_BYTES, 'history');
      await atomicWriteFile(this.historyFilePath, serialized, { mode: 0o600 });
      this.historySeparated = true;
      // A bookmark/permission write can persist the legacy inline history while
      // this first sidecar write is awaiting I/O. Rewrite the base profile after
      // publishing the split so Clear history removes URLs from every file, not
      // merely from the authoritative sidecar.
      this.save();
      this.persistedHistoryRevision = revision;
    });
    this.historyWriteTail = operation.catch((reason) => {
      const firstFailure = !this.historyWriteFailure;
      this.historyWriteFailure =
        reason instanceof Error ? reason : new Error(`Browser history could not be saved: ${String(reason)}`);
      if (firstFailure) this.reportPersistenceError('history', this.historyWriteFailure);
    });
    return operation;
  }

  private scheduleDownloadsSave(delayMs = DOWNLOAD_SAVE_DEBOUNCE_MS): void {
    this.assertWritable();
    this.downloadsRevision++;
    if (this.downloadsSaveTimer) clearTimeout(this.downloadsSaveTimer);
    this.downloadsSaveTimer = setTimeout(() => {
      this.downloadsSaveTimer = null;
      void this.enqueueDownloadsSave().catch(() => undefined);
    }, delayMs);
    this.downloadsSaveTimer.unref?.();
  }

  private enqueueDownloadsSave(): Promise<void> {
    const operation = this.downloadsWriteTail.then(async () => {
      this.assertWritable();
      if (this.persistedDownloadsRevision >= this.downloadsRevision) return;
      const revision = this.downloadsRevision;
      const payload: BrowserDownloadsData = {
        version: 1,
        downloads: this.data.downloads.map((download) => ({ ...download })),
      };
      const serialized = JSON.stringify(payload);
      assertSerializedBytes(serialized, MAX_BROWSER_DOWNLOAD_BYTES, 'download');
      await atomicWriteFile(this.downloadsFilePath, serialized, { mode: 0o600 });
      this.downloadsSeparated = true;
      // Apply the same one-time scrub to legacy inline download metadata. The
      // downloaded files stay untouched; only stale paths/URLs leave the profile.
      this.save();
      this.persistedDownloadsRevision = revision;
    });
    this.downloadsWriteTail = operation.catch((reason) => {
      const firstFailure = !this.downloadsWriteFailure;
      this.downloadsWriteFailure =
        reason instanceof Error ? reason : new Error(`Browser downloads could not be saved: ${String(reason)}`);
      if (firstFailure) this.reportPersistenceError('downloads', this.downloadsWriteFailure);
    });
    return operation;
  }

  private reportPersistenceError(area: BrowserProfilePersistenceArea, error: Error): void {
    try {
      this.onPersistenceError?.(area, error);
    } catch {
      // Reporting must never replace the original profile persistence failure.
    }
  }

  async flushHistory(): Promise<void> {
    this.assertWritable();
    if (this.historySaveTimer) {
      clearTimeout(this.historySaveTimer);
      this.historySaveTimer = null;
    }
    while (this.persistedHistoryRevision < this.historyRevision) await this.enqueueHistorySave();
    this.assertWritable();
  }

  async flushDownloads(): Promise<void> {
    this.assertWritable();
    if (this.downloadsSaveTimer) {
      clearTimeout(this.downloadsSaveTimer);
      this.downloadsSaveTimer = null;
    }
    while (this.persistedDownloadsRevision < this.downloadsRevision) await this.enqueueDownloadsSave();
    this.assertWritable();
  }

  async flush(): Promise<void> {
    const results = await Promise.allSettled([this.flushHistory(), this.flushDownloads()]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  addHistory(title: string, url: string): BrowserHistoryEntry {
    this.assertWritable();
    const boundedUrl = boundedBrowserUrl(url).slice(0, MAX_HISTORY_URL_CHARS);
    const entry: BrowserHistoryEntry = {
      id: randomUUID(),
      scopeKey: this.scopeKey,
      title: boundedBrowserTitle(title, boundedUrl).slice(0, MAX_HISTORY_TITLE_CHARS),
      url: boundedUrl,
      visitedAt: new Date().toISOString(),
    };
    this.data.history = boundedHistory([entry, ...this.data.history.filter((item) => item.url !== boundedUrl)]);
    this.scheduleHistorySave();
    return entry;
  }

  listHistory(query = ''): BrowserHistoryEntry[] {
    const needle = query.trim().toLowerCase();
    return this.data.history.filter(
      (item) => !needle || item.title.toLowerCase().includes(needle) || item.url.toLowerCase().includes(needle),
    );
  }

  async clearHistory(): Promise<void> {
    this.assertWritable();
    this.data.history = [];
    this.scheduleHistorySave(0);
    await this.flushHistory();
  }

  addBookmark(title: string, url: string, folder = ''): BrowserBookmark {
    this.assertWritable();
    title = boundedBrowserTitle(title, boundedBrowserUrl(url));
    url = boundedBrowserUrl(url);
    const now = new Date().toISOString();
    const existingIndex = this.data.bookmarks.findIndex((item) => item.url === url);
    if (existingIndex >= 0) {
      const existing: BrowserBookmark = {
        ...this.data.bookmarks[existingIndex],
        title: title || url,
        folder: boundedBookmarkFolder(folder),
        updatedAt: now,
      };
      const bookmarks = [...this.data.bookmarks];
      bookmarks[existingIndex] = existing;
      this.save({ ...this.data, bookmarks });
      return { ...existing };
    }
    const bookmark: BrowserBookmark = {
      id: randomUUID(),
      scopeKey: this.scopeKey,
      title: title || url,
      url,
      folder: boundedBookmarkFolder(folder),
      createdAt: now,
      updatedAt: now,
    };
    this.save({ ...this.data, bookmarks: [...this.data.bookmarks, bookmark] });
    return { ...bookmark };
  }

  listBookmarks(query = ''): BrowserBookmark[] {
    const needle = query.trim().toLowerCase();
    return this.data.bookmarks.filter(
      (item) =>
        !needle ||
        item.title.toLowerCase().includes(needle) ||
        item.url.toLowerCase().includes(needle) ||
        item.folder.toLowerCase().includes(needle),
    );
  }

  updateBookmark(bookmark: BrowserBookmark): BrowserBookmark {
    this.assertWritable();
    const index = this.data.bookmarks.findIndex((item) => item.id === bookmark.id);
    if (index < 0) throw new Error('Bookmark not found.');
    const updated: BrowserBookmark = {
      ...this.data.bookmarks[index],
      title: boundedBrowserTitle(bookmark.title, boundedBrowserUrl(bookmark.url)),
      url: boundedBrowserUrl(bookmark.url),
      folder: boundedBookmarkFolder(bookmark.folder),
      updatedAt: new Date().toISOString(),
    };
    const bookmarks = [...this.data.bookmarks];
    bookmarks[index] = updated;
    this.save({ ...this.data, bookmarks });
    return { ...updated };
  }

  removeBookmark(id: string): void {
    this.assertWritable();
    this.save({ ...this.data, bookmarks: this.data.bookmarks.filter((item) => item.id !== id) });
  }

  reorderBookmarks(ids: string[]): void {
    this.assertWritable();
    const current = this.data.bookmarks;
    if (ids.length !== current.length || new Set(ids).size !== current.length) {
      throw new Error('Bookmark reorder must include every bookmark exactly once.');
    }
    const byId = new Map(current.map((item) => [item.id, item]));
    const ordered = ids.map((id) => byId.get(id));
    if (ordered.some((item) => !item)) throw new Error('Bookmark reorder contains an unknown bookmark.');
    this.save({ ...this.data, bookmarks: ordered as BrowserBookmark[] });
  }

  replaceBookmarks(bookmarks: Array<Pick<BrowserBookmark, 'title' | 'url' | 'folder'>>): number {
    this.assertWritable();
    const nextBookmarks = this.data.bookmarks.map((bookmark) => ({ ...bookmark }));
    const byUrl = new Map(nextBookmarks.map((bookmark) => [bookmark.url, bookmark]));
    for (const importedBookmark of bookmarks) {
      const imported = {
        ...importedBookmark,
        url: boundedBrowserUrl(importedBookmark.url),
        title: boundedBrowserTitle(importedBookmark.title, boundedBrowserUrl(importedBookmark.url)),
        folder: boundedBookmarkFolder(importedBookmark.folder),
      };
      const timestamp = new Date().toISOString();
      const existing = byUrl.get(imported.url);
      if (existing) {
        existing.title = imported.title || imported.url;
        existing.folder = imported.folder;
        existing.updatedAt = timestamp;
        continue;
      }
      const bookmark: BrowserBookmark = {
        id: randomUUID(),
        scopeKey: this.scopeKey,
        title: imported.title || imported.url,
        url: imported.url,
        folder: imported.folder,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      nextBookmarks.push(bookmark);
      byUrl.set(bookmark.url, bookmark);
    }
    if (bookmarks.length > 0) this.save({ ...this.data, bookmarks: nextBookmarks });
    return bookmarks.length;
  }

  addDownload(download: BrowserDownload): string[] {
    this.assertWritable();
    download = normalizedDownload(download);
    const nextDownloads = [download, ...this.data.downloads.filter((item) => item.id !== download.id)];
    const retained = boundedDownloads(nextDownloads);
    const retainedIds = new Set(retained.map((item) => item.id));
    const evicted = nextDownloads.filter((item) => !retainedIds.has(item.id)).map((item) => item.id);
    this.data.downloads = retained;
    this.scheduleDownloadsSave();
    return evicted;
  }

  listDownloads(): BrowserDownload[] {
    return this.data.downloads.map((item) => ({ ...item }));
  }

  clearQuarantinedDownloadPath(id: string, expectedPath: string): BrowserDownload | null {
    this.assertWritable();
    const index = this.data.downloads.findIndex((item) => item.id === id);
    const current = index >= 0 ? this.data.downloads[index] : undefined;
    if (!current?.quarantined || current.path !== expectedPath) return null;
    const updated = { ...current };
    delete updated.path;
    const downloads = [...this.data.downloads];
    downloads[index] = updated;
    this.data.downloads = downloads;
    this.scheduleDownloadsSave();
    return { ...updated };
  }

  markQuarantinedDownloadInterrupted(id: string): BrowserDownload | null {
    this.assertWritable();
    const index = this.data.downloads.findIndex((item) => item.id === id);
    const current = index >= 0 ? this.data.downloads[index] : undefined;
    if (!current?.quarantined || current.state !== 'progressing') return null;
    const updated: BrowserDownload = { ...current, state: 'interrupted' };
    delete updated.path;
    const downloads = [...this.data.downloads];
    downloads[index] = updated;
    this.data.downloads = downloads;
    this.scheduleDownloadsSave();
    return { ...updated };
  }

  removeDownload(id: string): void {
    this.assertWritable();
    const downloads = this.data.downloads.filter((item) => item.id !== id);
    if (downloads.length === this.data.downloads.length) return;
    this.data.downloads = downloads;
    this.scheduleDownloadsSave();
  }

  getPermission(origin: string, permission: string): 'allow' | 'deny' | undefined {
    return this.data.permissions[origin]?.[permission];
  }

  setPermission(origin: string, permission: string, decision: 'allow' | 'deny'): void {
    this.setPermissions(origin, [permission], decision);
  }

  setPermissions(origin: string, permissions: readonly string[], decision: 'allow' | 'deny'): void {
    this.assertWritable();
    if (permissions.length === 0) return;
    const originPermissions = { ...(this.data.permissions[origin] ?? {}) };
    for (const permission of permissions) originPermissions[permission] = decision;
    this.save({
      ...this.data,
      permissions: { ...this.data.permissions, [origin]: originPermissions },
    });
  }

  listPermissions(origin?: string): BrowserSitePermission[] {
    const origins: Array<[string, Record<string, 'allow' | 'deny'> | undefined]> =
      origin === undefined ? Object.entries(this.data.permissions) : [[origin, this.data.permissions[origin]]];
    return origins.flatMap(([permissionOrigin, permissions]) =>
      permissions
        ? Object.entries(permissions).map(([permission, decision]) => ({
            origin: permissionOrigin,
            permission,
            decision,
          }))
        : [],
    );
  }

  clearPermissions(origin: string, permission?: string): void {
    this.assertWritable();
    const current = this.data.permissions[origin];
    if (!current || (permission !== undefined && current[permission] === undefined)) return;
    const permissions = { ...this.data.permissions };
    if (permission === undefined) {
      delete permissions[origin];
    } else {
      const originPermissions = { ...current };
      delete originPermissions[permission];
      if (Object.keys(originPermissions).length === 0) delete permissions[origin];
      else permissions[origin] = originPermissions;
    }
    this.save({ ...this.data, permissions });
  }

  getZoomLevel(): number {
    return this.data.zoomLevel;
  }

  setZoomLevel(level: number): void {
    this.assertWritable();
    if (!Number.isFinite(level)) throw new Error('Browser zoom must be a finite number.');
    this.save({ ...this.data, zoomLevel: Math.max(-5, Math.min(5, level)) });
  }

  isBackgroundNetworkRestricted(): boolean {
    // Corrupted metadata cannot prove that a persistent worker is user-owned.
    return !!this.loadFailure || this.data.backgroundNetworkRestricted;
  }

  restrictBackgroundNetwork(): void {
    if (this.data.backgroundNetworkRestricted) return;
    this.assertWritable();
    this.save({ ...this.data, backgroundNetworkRestricted: true });
  }

  isUnsafeOrigin(origin: string): boolean {
    // Corrupt metadata cannot prove that persistent origin storage is clean.
    return !!this.loadFailure || this.data.unsafeOrigins.includes(origin);
  }

  markUnsafeOrigin(origin: string): void {
    if (!isCanonicalHttpOrigin(origin)) throw new Error('Invalid unsafe Browser origin.');
    if (this.data.unsafeOrigins.includes(origin)) return;
    this.assertWritable();
    if (this.data.unsafeOrigins.length >= MAX_UNSAFE_ORIGINS) {
      throw new Error(`Unsafe Browser-origin provenance is limited to ${MAX_UNSAFE_ORIGINS.toLocaleString()} sites.`);
    }
    this.save({ ...this.data, unsafeOrigins: [...this.data.unsafeOrigins, origin] });
  }

  clearUnsafeOrigin(origin: string): void {
    this.assertWritable();
    if (!this.data.unsafeOrigins.includes(origin)) return;
    this.save({ ...this.data, unsafeOrigins: this.data.unsafeOrigins.filter((candidate) => candidate !== origin) });
  }

  listScriptCleanupOrigins(): string[] {
    if (this.loadFailure) throw this.loadFailure;
    return [...this.data.scriptCleanupOrigins];
  }

  markScriptCleanupOrigin(origin: string): void {
    if (!isCanonicalHttpOrigin(origin)) throw new Error('Invalid Browser script-cleanup origin.');
    if (this.data.scriptCleanupOrigins.includes(origin)) return;
    this.assertWritable();
    if (this.data.scriptCleanupOrigins.length >= MAX_UNSAFE_ORIGINS) {
      throw new Error(`Browser script-cleanup provenance is limited to ${MAX_UNSAFE_ORIGINS.toLocaleString()} sites.`);
    }
    this.save({ ...this.data, scriptCleanupOrigins: [...this.data.scriptCleanupOrigins, origin] });
  }

  clearScriptCleanupOrigin(origin: string): void {
    this.assertWritable();
    if (!this.data.scriptCleanupOrigins.includes(origin)) return;
    this.save({
      ...this.data,
      scriptCleanupOrigins: this.data.scriptCleanupOrigins.filter((candidate) => candidate !== origin),
    });
  }

  counts(): { historyCount: number; bookmarkCount: number; downloadCount: number } {
    if (this.loadFailure) throw this.loadFailure;
    return {
      historyCount: this.data.history.length,
      bookmarkCount: this.data.bookmarks.length,
      downloadCount: this.data.downloads.length,
    };
  }

  async clear(): Promise<void> {
    if (this.historySaveTimer) {
      clearTimeout(this.historySaveTimer);
      this.historySaveTimer = null;
    }
    if (this.downloadsSaveTimer) {
      clearTimeout(this.downloadsSaveTimer);
      this.downloadsSaveTimer = null;
    }
    this.data = structuredClone(EMPTY_DATA);
    this.loadFailure = null;
    this.historyRevision++;
    this.downloadsRevision++;
    await Promise.all([this.historyWriteTail, this.downloadsWriteTail]);
    // A failed in-flight writer records its error on the caught tail. Clear
    // those errors only after both tails have settled so clearing the profile is
    // a reliable recovery path rather than immediately re-latching stale state.
    this.historyWriteFailure = null;
    this.downloadsWriteFailure = null;
    const removals = await Promise.allSettled([
      this.removeProfileFile(this.filePath, { force: true }),
      this.removeProfileFile(this.historyFilePath, { force: true }),
      this.removeProfileFile(this.downloadsFilePath, { force: true }),
    ]);
    const usedFallbackFiles = removals.some((result) => result.status === 'rejected');
    if (usedFallbackFiles) {
      this.historySeparated = true;
      this.downloadsSeparated = true;
      const history: BrowserHistoryData = { version: 1, history: [] };
      const downloads: BrowserDownloadsData = { version: 1, downloads: [] };
      const fallbackWrites = await Promise.allSettled([
        Promise.resolve().then(() => this.save()),
        atomicWriteFile(this.historyFilePath, JSON.stringify(history), { mode: 0o600 }),
        atomicWriteFile(this.downloadsFilePath, JSON.stringify(downloads), { mode: 0o600 }),
      ]);
      const fallbackFailures = fallbackWrites
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (fallbackFailures.length > 0) {
        throw new AggregateError(fallbackFailures, 'Browser profile fallback files could not all be cleared.');
      }
    }
    // A removal failure leaves the freshly written sidecars authoritative.
    // Preserve that relationship so a synchronous profile write cannot put new
    // history/download metadata back into the base file while its debounced
    // sidecar write is still pending.
    this.historySeparated = usedFallbackFiles;
    this.downloadsSeparated = usedFallbackFiles;
    this.persistedHistoryRevision = this.historyRevision;
    this.persistedDownloadsRevision = this.downloadsRevision;
  }
}

function readSummaryJson(filePath: string, maxBytes: number): unknown | null {
  try {
    return readBoundedJson(filePath, maxBytes);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function readSummaryJsonAsync(filePath: string, maxBytes: number): Promise<unknown | null> {
  try {
    return await readBoundedJsonAsync(filePath, maxBytes);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

type BrowserProfileCounts = { historyCount: number; bookmarkCount: number; downloadCount: number };

function storedBrowserProfileCounts(
  scopeKey: string,
  profile: unknown | null,
  historySidecar: unknown | null,
  downloadSidecar: unknown | null,
): BrowserProfileCounts {
  let history: BrowserHistoryEntry[] = [];
  let bookmarks: BrowserBookmark[] = [];
  let downloads: BrowserDownload[] = [];
  if (profile !== null) {
    if (
      !isRecord(profile) ||
      profile.version !== 1 ||
      !Array.isArray(profile.history) ||
      !profile.history.every((entry) => isHistoryEntry(entry, scopeKey)) ||
      !Array.isArray(profile.bookmarks) ||
      !profile.bookmarks.every((bookmark) => isBookmark(bookmark, scopeKey)) ||
      !Array.isArray(profile.downloads) ||
      !profile.downloads.every(isDownload) ||
      !isPermissions(profile.permissions) ||
      typeof profile.zoomLevel !== 'number' ||
      !Number.isFinite(profile.zoomLevel) ||
      (profile.backgroundNetworkRestricted !== undefined && typeof profile.backgroundNetworkRestricted !== 'boolean') ||
      (profile.unsafeOrigins !== undefined && !isUnsafeOrigins(profile.unsafeOrigins)) ||
      (profile.scriptCleanupOrigins !== undefined && !isUnsafeOrigins(profile.scriptCleanupOrigins))
    ) {
      throw new Error('Invalid browser profile data.');
    }
    history = profile.history;
    bookmarks = profile.bookmarks;
    downloads = boundedDownloads(profile.downloads);
  }
  if (historySidecar !== null) {
    if (
      !isRecord(historySidecar) ||
      historySidecar.version !== 1 ||
      !Array.isArray(historySidecar.history) ||
      !historySidecar.history.every((entry) => isHistoryEntry(entry, scopeKey))
    ) {
      throw new Error('Invalid browser history data.');
    }
    history = historySidecar.history;
  }
  if (downloadSidecar !== null) {
    if (
      !isRecord(downloadSidecar) ||
      downloadSidecar.version !== 1 ||
      !Array.isArray(downloadSidecar.downloads) ||
      !downloadSidecar.downloads.every(isDownload)
    ) {
      throw new Error('Invalid browser download data.');
    }
    downloads = boundedDownloads(downloadSidecar.downloads);
  }
  return {
    historyCount: Math.min(history.length, MAX_HISTORY),
    bookmarkCount: Math.min(bookmarks.length, MAX_BOOKMARKS),
    downloadCount: downloads.length,
  };
}

/** Read profile counts without constructing a live store. Browser Settings can
 * enumerate years of conversation profiles without retaining every bounded
 * history/bookmark payload in BrowserManager's process-wide cache. */
export function readStoredBrowserProfileCounts(appHome: string, scopeKey: string): BrowserProfileCounts {
  scopeKey = safeScopeKey(scopeKey);
  const directory = join(appHome, 'browser', 'profiles');
  const profile = readSummaryJson(join(directory, `${scopeKey}.json`), MAX_BROWSER_PROFILE_BYTES);
  const historySidecar = readSummaryJson(join(directory, `${scopeKey}.history.json`), MAX_BROWSER_HISTORY_BYTES);
  const downloadSidecar = readSummaryJson(join(directory, `${scopeKey}.downloads.json`), MAX_BROWSER_DOWNLOAD_BYTES);
  return storedBrowserProfileCounts(scopeKey, profile, historySidecar, downloadSidecar);
}

/** Asynchronous counterpart used on Electron's main thread. Files are read
 * sequentially so Browser Settings never allocates every inactive profile at
 * once and the event loop can service active pages between profiles. */
export async function readStoredBrowserProfileCountsAsync(
  appHome: string,
  scopeKey: string,
): Promise<BrowserProfileCounts> {
  scopeKey = safeScopeKey(scopeKey);
  const directory = join(appHome, 'browser', 'profiles');
  const profile = await readSummaryJsonAsync(join(directory, `${scopeKey}.json`), MAX_BROWSER_PROFILE_BYTES);
  const historySidecar = await readSummaryJsonAsync(
    join(directory, `${scopeKey}.history.json`),
    MAX_BROWSER_HISTORY_BYTES,
  );
  const downloadSidecar = await readSummaryJsonAsync(
    join(directory, `${scopeKey}.downloads.json`),
    MAX_BROWSER_DOWNLOAD_BYTES,
  );
  return storedBrowserProfileCounts(scopeKey, profile, historySidecar, downloadSidecar);
}

/** Read only persisted download metadata without constructing/caching a full
 * BrowserProfileStore. The dedicated sidecar is authoritative when present;
 * legacy profiles fall back to their inline downloads until the next normal
 * store write migrates them. Startup quarantine recovery uses this preflight to
 * avoid retaining every historical conversation profile in memory. */
export async function readStoredBrowserDownloadsAsync(appHome: string, scopeKey: string): Promise<BrowserDownload[]> {
  scopeKey = safeScopeKey(scopeKey);
  const directory = join(appHome, 'browser', 'profiles');
  const sidecar = await readSummaryJsonAsync(join(directory, `${scopeKey}.downloads.json`), MAX_BROWSER_DOWNLOAD_BYTES);
  if (sidecar !== null) {
    if (
      !isRecord(sidecar) ||
      sidecar.version !== 1 ||
      !Array.isArray(sidecar.downloads) ||
      !sidecar.downloads.every(isDownload)
    ) {
      throw new Error('Invalid browser download data.');
    }
    return boundedDownloads(sidecar.downloads).map((download) => ({ ...download }));
  }

  const profile = await readSummaryJsonAsync(join(directory, `${scopeKey}.json`), MAX_BROWSER_PROFILE_BYTES);
  if (profile === null) return [];
  if (!isRecord(profile) || !Array.isArray(profile.downloads) || !profile.downloads.every(isDownload)) {
    throw new Error('Invalid browser profile download data.');
  }
  return boundedDownloads(profile.downloads).map((download) => ({ ...download }));
}

export function listStoredBrowserScopeKeys(appHome: string): string[] {
  const directory = join(appHome, 'browser', 'profiles');
  try {
    return [
      ...new Set(
        readdirSync(directory)
          .map((name) => /^(global|conversation-[a-f0-9]{24})(?:\.(?:history|downloads))?\.json$/.exec(name)?.[1])
          .filter((scopeKey): scopeKey is string => !!scopeKey),
      ),
    ];
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

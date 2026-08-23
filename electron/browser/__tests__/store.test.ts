import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { rm as removeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserProfileStore,
  listStoredBrowserScopeKeys,
  MAX_BROWSER_DOWNLOAD_BYTES,
  MAX_BROWSER_HISTORY_BYTES,
  MAX_BROWSER_PROFILE_BYTES,
  MAX_BOOKMARK_FOLDER_CHARS,
  MAX_BOOKMARK_FOLDER_DEPTH,
  MAX_BOOKMARKS,
  MAX_PERMISSION_ORIGINS,
  MAX_PERMISSIONS_PER_ORIGIN,
  readStoredBrowserDownloadsAsync,
  readStoredBrowserProfileCounts,
  readStoredBrowserProfileCountsAsync,
} from '../store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kai-browser-store-'));
  dirs.push(dir);
  return dir;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('BrowserProfileStore', () => {
  it('persists and isolates history, bookmarks, permissions, and zoom', async () => {
    const appHome = home();
    const globalStore = new BrowserProfileStore(appHome, 'global');
    globalStore.addHistory('Example', 'https://example.com');
    globalStore.addBookmark('Example', 'https://example.com', 'Work');
    globalStore.setPermission('https://example.com', 'notifications', 'deny');
    globalStore.setZoomLevel(1.5);
    globalStore.restrictBackgroundNetwork();
    globalStore.markUnsafeOrigin('https://example.com');
    globalStore.markScriptCleanupOrigin('https://scripted.example.com');
    await globalStore.flushHistory();

    const loaded = new BrowserProfileStore(appHome, 'global');
    expect(loaded.listHistory()).toHaveLength(1);
    expect(loaded.listBookmarks('work')).toHaveLength(1);
    expect(loaded.getPermission('https://example.com', 'notifications')).toBe('deny');
    expect(loaded.listPermissions('https://example.com')).toEqual([
      {
        origin: 'https://example.com',
        permission: 'notifications',
        decision: 'deny',
      },
    ]);
    loaded.setPermission('https://example.com', 'camera', 'allow');
    loaded.clearPermissions('https://example.com', 'notifications');
    expect(loaded.listPermissions('https://example.com')).toEqual([
      {
        origin: 'https://example.com',
        permission: 'camera',
        decision: 'allow',
      },
    ]);
    loaded.clearPermissions('https://example.com');
    expect(loaded.listPermissions('https://example.com')).toEqual([]);
    expect(loaded.getZoomLevel()).toBe(1.5);
    expect(loaded.isBackgroundNetworkRestricted()).toBe(true);
    expect(loaded.isUnsafeOrigin('https://example.com')).toBe(true);
    expect(loaded.listScriptCleanupOrigins()).toEqual(['https://scripted.example.com']);
    loaded.clearScriptCleanupOrigin('https://scripted.example.com');
    expect(new BrowserProfileStore(appHome, 'global').listScriptCleanupOrigins()).toEqual([]);
    loaded.clearUnsafeOrigin('https://example.com');
    expect(new BrowserProfileStore(appHome, 'global').isUnsafeOrigin('https://example.com')).toBe(false);

    const conversation = new BrowserProfileStore(appHome, 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(conversation.listHistory()).toEqual([]);
    expect(conversation.isBackgroundNetworkRestricted()).toBe(false);
    expect(conversation.isUnsafeOrigin('https://example.com')).toBe(false);
    expect(conversation.listScriptCleanupOrigins()).toEqual([]);
    conversation.setZoomLevel(0);
    expect(listStoredBrowserScopeKeys(appHome).sort()).toEqual(['conversation-aaaaaaaaaaaaaaaaaaaaaaaa', 'global']);
  });

  it('rejects non-finite zoom values without corrupting the persisted profile', () => {
    const appHome = home();
    const store = new BrowserProfileStore(appHome, 'global');
    store.setZoomLevel(1.5);

    expect(() => store.setZoomLevel(Number.NaN)).toThrow(/finite number/);
    expect(() => store.setZoomLevel(Number.POSITIVE_INFINITY)).toThrow(/finite number/);

    const loaded = new BrowserProfileStore(appHome, 'global');
    expect(loaded.getZoomLevel()).toBe(1.5);
  });

  it('moves legacy inline history and downloads to sidecars without retaining stale copies', async () => {
    const appHome = home();
    const directory = join(appHome, 'browser', 'profiles');
    const filePath = join(directory, 'global.json');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        history: [
          {
            id: 'history-1',
            scopeKey: 'global',
            title: 'Legacy history',
            url: 'https://history.example/private-path',
            visitedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        bookmarks: [
          {
            id: 'bookmark-1',
            scopeKey: 'global',
            title: 'Saved bookmark',
            url: 'https://bookmark.example',
            folder: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        downloads: [
          {
            id: 'download-1',
            tabId: 'tab-1',
            filename: 'private.pdf',
            receivedBytes: 10,
            totalBytes: 10,
            state: 'completed',
            path: '/tmp/private.pdf',
            url: 'https://download.example/private.pdf',
          },
        ],
        permissions: {},
        zoomLevel: 0,
        backgroundNetworkRestricted: false,
      }),
    );

    const store = new BrowserProfileStore(appHome, 'global');
    await Promise.all([store.flushHistory(), store.flushDownloads()]);

    const base = JSON.parse(readFileSync(filePath, 'utf8')) as { history: unknown[]; downloads: unknown[] };
    expect(base.history).toEqual([]);
    expect(base.downloads).toEqual([]);
    expect(readFileSync(join(directory, 'global.history.json'), 'utf8')).toContain('private-path');
    expect(readFileSync(join(directory, 'global.downloads.json'), 'utf8')).toContain('private.pdf');
    expect(new BrowserProfileStore(appHome, 'global').listHistory()).toHaveLength(1);
    expect(new BrowserProfileStore(appHome, 'global').listDownloads()).toHaveLength(1);
  });

  it('counts inactive profile metadata without constructing a live store', async () => {
    const appHome = home();
    const store = new BrowserProfileStore(appHome, 'global');
    store.addHistory('Example', 'https://example.com/history');
    store.addBookmark('Example', 'https://example.com/bookmark');
    store.addDownload({
      id: 'download-1',
      tabId: 'tab-1',
      filename: 'report.pdf',
      receivedBytes: 10,
      totalBytes: 10,
      state: 'completed',
    });
    await store.flush();

    expect(readStoredBrowserProfileCounts(appHome, 'global')).toEqual({
      historyCount: 1,
      bookmarkCount: 1,
      downloadCount: 1,
    });
    await expect(readStoredBrowserProfileCountsAsync(appHome, 'global')).resolves.toEqual({
      historyCount: 1,
      bookmarkCount: 1,
      downloadCount: 1,
    });
  });

  it('preflights download metadata from the authoritative sidecar before falling back to a legacy profile', async () => {
    const appHome = home();
    const directory = join(appHome, 'browser', 'profiles');
    mkdirSync(directory, { recursive: true });
    const legacyDownload = {
      id: 'legacy-download',
      tabId: 'tab-1',
      filename: 'legacy.pdf',
      receivedBytes: 1,
      totalBytes: 1,
      state: 'completed',
    };
    const sidecarDownload = {
      id: 'sidecar-download',
      tabId: 'tab-2',
      filename: 'sidecar.pdf',
      receivedBytes: 2,
      totalBytes: 2,
      state: 'completed',
    };
    writeFileSync(join(directory, 'global.json'), JSON.stringify({ downloads: [legacyDownload] }));

    await expect(readStoredBrowserDownloadsAsync(appHome, 'global')).resolves.toEqual([legacyDownload]);

    writeFileSync(
      join(directory, 'global.downloads.json'),
      JSON.stringify({ version: 1, downloads: [sidecarDownload] }),
    );
    await expect(readStoredBrowserDownloadsAsync(appHome, 'global')).resolves.toEqual([sidecarDownload]);
  });

  it('clears metadata without touching unrelated profile files', async () => {
    const appHome = home();
    const globalStore = new BrowserProfileStore(appHome, 'global');
    const conversation = new BrowserProfileStore(appHome, 'conversation-bbbbbbbbbbbbbbbbbbbbbbbb');
    globalStore.addHistory('Global', 'https://global.example');
    conversation.addHistory('Chat', 'https://chat.example');
    conversation.restrictBackgroundNetwork();
    conversation.markUnsafeOrigin('https://chat.example');
    await Promise.all([globalStore.flushHistory(), conversation.flushHistory()]);
    await conversation.clear();
    expect(new BrowserProfileStore(appHome, 'global').listHistory()).toHaveLength(1);
    expect(new BrowserProfileStore(appHome, 'conversation-bbbbbbbbbbbbbbbbbbbbbbbb').listHistory()).toEqual([]);
    expect(
      new BrowserProfileStore(appHome, 'conversation-bbbbbbbbbbbbbbbbbbbbbbbb').isBackgroundNetworkRestricted(),
    ).toBe(false);
    expect(
      new BrowserProfileStore(appHome, 'conversation-bbbbbbbbbbbbbbbbbbbbbbbb').isUnsafeOrigin('https://chat.example'),
    ).toBe(false);
  });

  it('rejects malformed unsafe-origin provenance without publishing a partial mutation', () => {
    const store = new BrowserProfileStore(home(), 'global');

    expect(() => store.markUnsafeOrigin('file:///private/data')).toThrow(/Invalid unsafe Browser origin/);
    expect(() => store.markUnsafeOrigin('https://user:password@example.com')).toThrow(/Invalid unsafe Browser origin/);
    expect(store.isUnsafeOrigin('https://example.com')).toBe(false);
  });

  it('waits for every profile removal before recovering from a deletion failure', async () => {
    const appHome = home();
    const delayedHistoryRemoval = deferred<void>();
    const removeProfileFile = vi.fn(async (path: string, options: { force: boolean }) => {
      if (path.endsWith('/global.json')) throw new Error('profile file is locked');
      if (path.endsWith('/global.history.json')) await delayedHistoryRemoval.promise;
      await removeFile(path, options);
    });
    const store = new BrowserProfileStore(appHome, 'global', removeProfileFile);
    store.addHistory('Before clear', 'https://before.example');
    await store.flushHistory();

    let clearSettled = false;
    const clearing = store.clear().then(() => {
      clearSettled = true;
    });
    await vi.waitFor(() => expect(removeProfileFile).toHaveBeenCalledTimes(3));
    await Promise.resolve();
    expect(clearSettled).toBe(false);

    delayedHistoryRemoval.resolve();
    await clearing;
    store.addHistory('After clear', 'https://after.example');
    await store.flushHistory();

    expect(new BrowserProfileStore(appHome, 'global').listHistory()).toEqual([
      expect.objectContaining({ title: 'After clear', url: 'https://after.example' }),
    ]);
  });

  it('keeps fallback sidecars authoritative after a profile removal fails', async () => {
    const appHome = home();
    const directory = join(appHome, 'browser', 'profiles');
    const removeProfileFile = vi.fn(async (path: string, options: { force: boolean }) => {
      if (path.endsWith('/global.json')) throw new Error('profile file is locked');
      await removeFile(path, options);
    });
    const store = new BrowserProfileStore(appHome, 'global', removeProfileFile);

    await store.clear();
    store.addHistory('After clear', 'https://history.example/after-clear');
    store.addDownload({
      id: 'download-after-clear',
      tabId: 'tab-1',
      filename: 'after-clear.pdf',
      receivedBytes: 10,
      totalBytes: 10,
      state: 'completed',
    });
    // This synchronous base-profile write must not inline data whose freshly
    // recreated sidecars are authoritative while their debounced writes wait.
    store.addBookmark('Saved', 'https://bookmark.example');

    const base = JSON.parse(readFileSync(join(directory, 'global.json'), 'utf8')) as {
      history: unknown[];
      downloads: unknown[];
    };
    expect(base.history).toEqual([]);
    expect(base.downloads).toEqual([]);

    await store.flush();
    expect(new BrowserProfileStore(appHome, 'global').listHistory()).toHaveLength(1);
    expect(new BrowserProfileStore(appHome, 'global').listDownloads()).toHaveLength(1);
  });

  it('clears both fallback sidecars when the base profile fallback write fails', async () => {
    const appHome = home();
    const directory = join(appHome, 'browser', 'profiles');
    const removeProfileFile = vi.fn(async (path: string, options: { force: boolean }) => {
      if (path.endsWith('/global.json')) throw new Error('profile file is locked');
      await removeFile(path, options);
    });
    const store = new BrowserProfileStore(appHome, 'global', removeProfileFile);
    store.addHistory('Private history', 'https://history.example/private');
    store.addDownload({
      id: 'private-download',
      tabId: 'tab-1',
      filename: 'private.pdf',
      receivedBytes: 10,
      totalBytes: 10,
      state: 'completed',
    });
    await store.flush();
    Reflect.set(
      store,
      'save',
      vi.fn(() => {
        throw new Error('base fallback write failed');
      }),
    );

    await expect(store.clear()).rejects.toThrow(/fallback files could not all be cleared/i);

    expect(JSON.parse(readFileSync(join(directory, 'global.history.json'), 'utf8'))).toEqual({
      version: 1,
      history: [],
    });
    expect(JSON.parse(readFileSync(join(directory, 'global.downloads.json'), 'utf8'))).toEqual({
      version: 1,
      downloads: [],
    });
  });

  it('drains both metadata streams before returning a flush failure', async () => {
    const store = new BrowserProfileStore(home(), 'global');
    const downloads = deferred<void>();
    const historyFailure = new Error('history disk failure');
    const flushHistory = vi.spyOn(store, 'flushHistory').mockRejectedValue(historyFailure);
    const flushDownloads = vi.spyOn(store, 'flushDownloads').mockReturnValue(downloads.promise);

    let settled = false;
    const observed = store.flush().then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await Promise.resolve();

    expect(flushHistory).toHaveBeenCalledOnce();
    expect(flushDownloads).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    downloads.resolve();
    await expect(observed).resolves.toBe(historyFailure);
  });

  it('bounds titles and URLs before persisting history and bookmarks', async () => {
    const store = new BrowserProfileStore(home(), 'global');
    const history = store.addHistory('t'.repeat(2_000), `https://example.com/${'u'.repeat(40_000)}`);
    const bookmark = store.addBookmark('b'.repeat(2_000), `https://example.com/${'v'.repeat(40_000)}`);

    await store.flushHistory();

    expect(history.title.length).toBe(512);
    expect(history.url.length).toBe(8 * 1_024);
    expect(bookmark.title.length).toBe(1_024);
    expect(bookmark.url.length).toBe(32 * 1_024);
  });

  it('bounds bookmark folders and rejects aggregate count and serialized-size overflow', () => {
    const store = new BrowserProfileStore(home(), 'global');
    const folder = Array.from({ length: 100 }, (_, index) => ` folder-${index}-${'x'.repeat(100)} `).join('/');
    const bookmark = store.addBookmark('Bounded folder', 'https://example.com/folder', folder);

    expect(bookmark.folder.length).toBeLessThanOrEqual(MAX_BOOKMARK_FOLDER_CHARS);
    expect(bookmark.folder.split('/').length).toBeLessThanOrEqual(MAX_BOOKMARK_FOLDER_DEPTH);

    expect(() =>
      store.replaceBookmarks(
        Array.from({ length: MAX_BOOKMARKS }, (_, index) => ({
          title: `Bookmark ${index}`,
          url: `https://count.example/${index}`,
          folder: '',
        })),
      ),
    ).toThrow(/limited to 10,000 entries/);

    expect(() =>
      store.replaceBookmarks(
        Array.from({ length: 300 }, (_, index) => ({
          title: `Large ${index}`,
          url: `https://size.example/${index}/${'u'.repeat(32 * 1_024)}`,
          folder: '',
        })),
      ),
    ).toThrow(/8 MB metadata limit/);
  });

  it('preserves a corrupt profile and rejects mutations until the user clears it', async () => {
    const appHome = home();
    const directory = join(appHome, 'browser', 'profiles');
    const filePath = join(directory, 'global.json');
    const malformed = '{"version":1,"history":[';
    mkdirSync(directory, { recursive: true });
    writeFileSync(filePath, malformed);
    const store = new BrowserProfileStore(appHome, 'global');

    expect(store.listHistory()).toEqual([]);
    expect(store.isBackgroundNetworkRestricted()).toBe(true);
    expect(() => store.addHistory('New', 'https://example.com')).toThrow(/unreadable or corrupted/);
    expect(() => store.addBookmark('New', 'https://example.com')).toThrow(/unreadable or corrupted/);
    expect(() => store.setPermission('https://example.com', 'camera', 'allow')).toThrow(/unreadable or corrupted/);
    expect(() => store.clearUnsafeOrigin('https://example.com')).toThrow(/unreadable or corrupted/);
    expect(() => readStoredBrowserProfileCounts(appHome, 'global')).toThrow();
    await expect(readStoredBrowserProfileCountsAsync(appHome, 'global')).rejects.toThrow();
    expect(readFileSync(filePath, 'utf8')).toBe(malformed);

    await store.clear();
    expect(() => store.addHistory('New', 'https://example.com')).not.toThrow();
    await store.flushHistory();
  });

  it('rejects invalid unsafe-origin provenance from lightweight profile summaries', async () => {
    const appHome = home();
    const directory = join(appHome, 'browser', 'profiles');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'global.json'),
      JSON.stringify({
        version: 1,
        history: [],
        bookmarks: [],
        downloads: [],
        permissions: {},
        zoomLevel: 0,
        backgroundNetworkRestricted: false,
        unsafeOrigins: ['not-a-canonical-origin'],
      }),
    );

    expect(() => readStoredBrowserProfileCounts(appHome, 'global')).toThrow(/Invalid browser profile data/);
    await expect(readStoredBrowserProfileCountsAsync(appHome, 'global')).rejects.toThrow(
      /Invalid browser profile data/,
    );
  });

  for (const [fileName, maxBytes] of [
    ['global.json', MAX_BROWSER_PROFILE_BYTES],
    ['global.history.json', MAX_BROWSER_HISTORY_BYTES],
    ['global.downloads.json', MAX_BROWSER_DOWNLOAD_BYTES],
  ] as const) {
    it(`rejects an oversized ${fileName} before parsing or replacing it`, async () => {
      const appHome = home();
      const directory = join(appHome, 'browser', 'profiles');
      const filePath = join(directory, fileName);
      mkdirSync(directory, { recursive: true });
      writeFileSync(filePath, '');
      truncateSync(filePath, maxBytes + 1);

      const store = new BrowserProfileStore(appHome, 'global');
      expect(store.listHistory()).toEqual([]);
      expect(store.isBackgroundNetworkRestricted()).toBe(true);
      expect(() => store.setZoomLevel(1)).toThrow(/unreadable or corrupted/);
      expect(() => readStoredBrowserProfileCounts(appHome, 'global')).toThrow(/size limit/i);
      await expect(readStoredBrowserProfileCountsAsync(appHome, 'global')).rejects.toThrow(/size limit/i);
      expect(statSync(filePath).size).toBe(maxBytes + 1);
    });
  }

  it.runIf(process.platform !== 'win32')(
    'refuses symlinked profile metadata in synchronous and asynchronous readers',
    async () => {
      const appHome = home();
      const directory = join(appHome, 'browser', 'profiles');
      const profilePath = join(directory, 'global.json');
      const targetPath = join(appHome, 'outside-profile.json');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        targetPath,
        JSON.stringify({
          version: 1,
          history: [],
          bookmarks: [],
          downloads: [],
          permissions: {},
          zoomLevel: 0,
        }),
      );
      symlinkSync(targetPath, profilePath);

      const store = new BrowserProfileStore(appHome, 'global');
      expect(store.isBackgroundNetworkRestricted()).toBe(true);
      expect(() => store.setZoomLevel(1)).toThrow(/unreadable or corrupted/);
      expect(() => readStoredBrowserProfileCounts(appHome, 'global')).toThrow();
      await expect(readStoredBrowserProfileCountsAsync(appHome, 'global')).rejects.toThrow();
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects profile metadata directories and FIFOs without blocking',
    async () => {
      const appHome = home();
      const directory = join(appHome, 'browser', 'profiles');
      const profilePath = join(directory, 'global.json');
      mkdirSync(profilePath, { recursive: true });

      expect(() => readStoredBrowserProfileCounts(appHome, 'global')).toThrow(/regular file/i);
      await expect(readStoredBrowserProfileCountsAsync(appHome, 'global')).rejects.toThrow(/regular file/i);

      rmSync(profilePath, { recursive: true });
      execFileSync('mkfifo', [profilePath]);
      expect(() => readStoredBrowserProfileCounts(appHome, 'global')).toThrow(/regular file/i);
      await expect(readStoredBrowserProfileCountsAsync(appHome, 'global')).rejects.toThrow(/regular file/i);
    },
  );

  it('rejects oversized permission sets before publishing or persisting them', () => {
    const store = new BrowserProfileStore(home(), 'global');
    expect(() =>
      store.setPermissions(
        'https://example.com',
        Array.from({ length: MAX_PERMISSIONS_PER_ORIGIN + 1 }, (_, index) => `permission-${index}`),
        'allow',
      ),
    ).toThrow(/entries per site/);
    expect(store.getPermission('https://example.com', 'permission-0')).toBeUndefined();

    const appHome = home();
    const directory = join(appHome, 'browser', 'profiles');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'global.json'),
      JSON.stringify({
        version: 1,
        history: [],
        bookmarks: [],
        downloads: [],
        permissions: Object.fromEntries(
          Array.from({ length: MAX_PERMISSION_ORIGINS + 1 }, (_, index) => [
            `https://${index}.example.com`,
            { camera: 'deny' },
          ]),
        ),
        zoomLevel: 0,
        backgroundNetworkRestricted: false,
      }),
    );
    const loaded = new BrowserProfileStore(appHome, 'global');
    expect(() => loaded.setZoomLevel(1)).toThrow(/unreadable or corrupted/);
  });

  it('debounces page-driven history into a separate async bounded file', async () => {
    const appHome = home();
    const store = new BrowserProfileStore(appHome, 'conversation-cccccccccccccccccccccccc');
    for (let index = 0; index < 300; index++) {
      store.addHistory(`Title ${index}`, `https://example.com/${index}/${'x'.repeat(9_000)}`);
    }

    const profileDir = join(appHome, 'browser', 'profiles');
    expect(existsSync(join(profileDir, 'conversation-cccccccccccccccccccccccc.json'))).toBe(false);
    await store.flushHistory();

    const historyPath = join(profileDir, 'conversation-cccccccccccccccccccccccc.history.json');
    expect(existsSync(historyPath)).toBe(true);
    expect(readFileSync(historyPath, 'utf8').length).toBeLessThan(2.2 * 1024 * 1024);
    expect(store.listHistory().length).toBeLessThan(300);
    expect(listStoredBrowserScopeKeys(appHome)).toContain('conversation-cccccccccccccccccccccccc');
  });

  it('reports a final debounced history persistence failure', async () => {
    vi.useFakeTimers();
    try {
      const blockedWrite = deferred<void>();
      const onPersistenceError = vi.fn();
      const store = new BrowserProfileStore(home(), 'global', undefined, onPersistenceError);
      Reflect.set(store, 'historyWriteTail', blockedWrite.promise);
      store.addHistory('Example', 'https://example.com');

      await vi.advanceTimersByTimeAsync(500);
      blockedWrite.reject(new Error('history disk full'));

      await vi.waitFor(() =>
        expect(onPersistenceError).toHaveBeenCalledWith(
          'history',
          expect.objectContaining({ message: 'history disk full' }),
        ),
      );
      expect(onPersistenceError).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('debounces download progress into a separate async profile file', async () => {
    const appHome = home();
    const store = new BrowserProfileStore(appHome, 'conversation-dddddddddddddddddddddddd');
    for (let receivedBytes = 0; receivedBytes <= 100; receivedBytes += 10) {
      store.addDownload({
        id: 'download-1',
        tabId: 'tab-1',
        filename: 'report.pdf',
        receivedBytes,
        totalBytes: 100,
        state: receivedBytes === 100 ? 'completed' : 'progressing',
      });
    }

    const profileDir = join(appHome, 'browser', 'profiles');
    expect(existsSync(join(profileDir, 'conversation-dddddddddddddddddddddddd.json'))).toBe(false);
    await store.flushDownloads();

    const downloadsPath = join(profileDir, 'conversation-dddddddddddddddddddddddd.downloads.json');
    expect(existsSync(downloadsPath)).toBe(true);
    expect(new BrowserProfileStore(appHome, 'conversation-dddddddddddddddddddddddd').listDownloads()).toEqual([
      expect.objectContaining({ id: 'download-1', state: 'completed', receivedBytes: 100 }),
    ]);
    expect(listStoredBrowserScopeKeys(appHome)).toContain('conversation-dddddddddddddddddddddddd');
  });

  it('clears only the matching quarantined download path and persists it as unavailable', async () => {
    const appHome = home();
    const store = new BrowserProfileStore(appHome, 'global');
    const quarantinedPath = '/tmp/Kai-00000000-0000-4000-8000-000000000001.download';
    store.addDownload({
      id: 'download-1',
      tabId: 'tab-1',
      filename: 'report.pdf',
      receivedBytes: 10,
      totalBytes: 10,
      state: 'completed',
      quarantined: true,
      path: quarantinedPath,
    });
    store.addDownload({
      id: 'download-2',
      tabId: 'tab-1',
      filename: 'user-report.pdf',
      receivedBytes: 10,
      totalBytes: 10,
      state: 'completed',
      path: '/tmp/user-report.pdf',
    });

    expect(store.clearQuarantinedDownloadPath('download-1', '/tmp/different.download')).toBeNull();
    expect(store.clearQuarantinedDownloadPath('download-2', '/tmp/user-report.pdf')).toBeNull();
    const cleared = store.clearQuarantinedDownloadPath('download-1', quarantinedPath);
    expect(cleared).toMatchObject({ id: 'download-1', quarantined: true });
    expect(cleared).not.toHaveProperty('path');

    await store.flushDownloads();
    const persisted = new BrowserProfileStore(appHome, 'global').listDownloads();
    expect(persisted).toEqual([
      expect.objectContaining({ id: 'download-2', path: '/tmp/user-report.pdf' }),
      expect.objectContaining({ id: 'download-1' }),
    ]);
    expect(persisted[1]).not.toHaveProperty('path');
  });

  it('evicts oldest downloads before aggregate sidecar metadata can poison the profile', async () => {
    const appHome = home();
    const store = new BrowserProfileStore(appHome, 'global');
    const escaped = '\u0001'.repeat(32 * 1_024);
    for (let index = 0; index < 80; index++) {
      store.addDownload({
        id: `download-${index}`,
        tabId: 'tab-1',
        filename: `report-${index}.pdf`,
        receivedBytes: index,
        totalBytes: 80,
        state: 'completed',
        path: `/tmp/${escaped}`,
        url: `https://download.example/${escaped}`,
      });
    }

    expect(store.listDownloads().length).toBeLessThan(80);
    await expect(store.flushDownloads()).resolves.toBeUndefined();
    const downloadsPath = join(appHome, 'browser', 'profiles', 'global.downloads.json');
    expect(statSync(downloadsPath).size).toBeLessThanOrEqual(MAX_BROWSER_DOWNLOAD_BYTES);

    expect(() => store.setZoomLevel(1.25)).not.toThrow();
    expect(new BrowserProfileStore(appHome, 'global').getZoomLevel()).toBe(1.25);
  });
});

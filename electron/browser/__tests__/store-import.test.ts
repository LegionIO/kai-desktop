import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { writeFile, writeFileAsync } = vi.hoisted(() => ({ writeFile: vi.fn(), writeFileAsync: vi.fn() }));

vi.mock('../../utils/atomic-write.js', () => ({ atomicWriteFile: writeFileAsync, atomicWriteFileSync: writeFile }));

import { BrowserProfileStore } from '../store.js';

const directories: string[] = [];

afterEach(() => {
  writeFile.mockReset();
  writeFileAsync.mockReset();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('BrowserProfileStore bookmark import', () => {
  it('merges a whole import in memory and persists once', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-import-'));
    directories.push(appHome);
    const store = new BrowserProfileStore(appHome, 'global');
    const bookmarks = Array.from({ length: 250 }, (_, index) => ({
      title: `Bookmark ${index}`,
      url: `https://example.com/${index}`,
      folder: index % 2 === 0 ? 'Even' : 'Odd',
    }));

    expect(store.replaceBookmarks(bookmarks)).toBe(250);
    expect(store.listBookmarks()).toHaveLength(250);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('publishes synchronous profile mutations only after their durable write succeeds', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-transactional-profile-'));
    directories.push(appHome);
    const store = new BrowserProfileStore(appHome, 'global');
    const first = store.addBookmark('First', 'https://first.example');
    const second = store.addBookmark('Second', 'https://second.example');
    store.setPermission('https://first.example', 'camera', 'deny');
    store.setZoomLevel(1);
    const originalBookmarks = store.listBookmarks().map((bookmark) => ({ ...bookmark }));
    const failNextWrite = () =>
      writeFile.mockImplementationOnce(() => {
        throw new Error('profile disk failure');
      });

    failNextWrite();
    expect(() => store.addBookmark('Third', 'https://third.example')).toThrow(/profile disk failure/);
    expect(store.listBookmarks()).toEqual(originalBookmarks);

    failNextWrite();
    expect(() => store.updateBookmark({ ...first, title: 'Changed' })).toThrow(/profile disk failure/);
    expect(store.listBookmarks()).toEqual(originalBookmarks);

    failNextWrite();
    expect(() => store.removeBookmark(first.id)).toThrow(/profile disk failure/);
    expect(store.listBookmarks()).toEqual(originalBookmarks);

    failNextWrite();
    expect(() => store.reorderBookmarks([second.id, first.id])).toThrow(/profile disk failure/);
    expect(store.listBookmarks()).toEqual(originalBookmarks);

    failNextWrite();
    expect(() => store.replaceBookmarks([{ title: 'Imported', url: 'https://imported.example', folder: '' }])).toThrow(
      /profile disk failure/,
    );
    expect(store.listBookmarks()).toEqual(originalBookmarks);

    failNextWrite();
    expect(() => store.setPermissions('https://first.example', ['camera', 'microphone'], 'allow')).toThrow(
      /profile disk failure/,
    );
    expect(store.getPermission('https://first.example', 'camera')).toBe('deny');
    expect(store.getPermission('https://first.example', 'microphone')).toBeUndefined();

    failNextWrite();
    expect(() => store.setZoomLevel(2)).toThrow(/profile disk failure/);
    expect(store.getZoomLevel()).toBe(1);
  });

  it('recovers from an in-flight history write failure when data is cleared', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-clear-recovery-'));
    directories.push(appHome);
    let rejectWrite!: (reason: unknown) => void;
    const failedWrite = new Promise<void>((_resolve, reject) => {
      rejectWrite = reject;
    });
    writeFileAsync.mockReturnValueOnce(failedWrite);
    const store = new BrowserProfileStore(appHome, 'global');
    store.addHistory('Example', 'https://example.com');

    const flush = store.flushHistory();
    await Promise.resolve();
    expect(writeFileAsync).toHaveBeenCalledOnce();
    const clear = store.clear();
    rejectWrite(new Error('disk unavailable'));
    await expect(flush).rejects.toThrow(/disk unavailable/);
    await expect(clear).resolves.toBeUndefined();

    expect(() => store.addBookmark('Recovered', 'https://example.com/recovered')).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import {
  browserPermissionTargetLabel,
  browserPermissionStorageKeys,
  describeBrowserPermission,
  isPersistentBrowserPermissionOrigin,
  isPersistableBrowserPermission,
  normalizeBrowserPermissionOrigin,
} from '../permissions.js';

describe('browser permission scopes', () => {
  it('keeps microphone and camera grants independent', () => {
    expect(browserPermissionStorageKeys('media', { mediaType: 'audio' })).toEqual(['media:audio']);
    expect(browserPermissionStorageKeys('media', { mediaType: 'video' })).toEqual(['media:video']);
    expect(browserPermissionStorageKeys('media', { mediaTypes: ['video', 'audio'] })).toEqual([
      'media:audio',
      'media:video',
    ]);
    expect(describeBrowserPermission('media', { mediaTypes: ['audio', 'video'] })).toBe('media (audio and video)');
  });

  it('scopes file-system grants to path, access mode, and target kind without storing the raw path', () => {
    const readableFile = browserPermissionStorageKeys('fileSystem', {
      filePath: '/private/example/secret.txt',
      fileAccessType: 'readable',
      isDirectory: false,
    });
    const writableFile = browserPermissionStorageKeys('fileSystem', {
      filePath: '/private/example/secret.txt',
      fileAccessType: 'writable',
      isDirectory: false,
    });
    const readableDirectory = browserPermissionStorageKeys('fileSystem', {
      filePath: '/private/example/secret.txt',
      fileAccessType: 'readable',
      isDirectory: true,
    });
    const otherPath = browserPermissionStorageKeys('fileSystem', {
      filePath: '/private/example/other.txt',
      fileAccessType: 'readable',
      isDirectory: false,
    });

    expect(new Set([readableFile[0], writableFile[0], readableDirectory[0], otherPath[0]]).size).toBe(4);
    expect(readableFile[0]).not.toContain('/private/example/secret.txt');
    expect(
      browserPermissionTargetLabel('fileSystem', {
        filePath: '/private/example/secret.txt',
        fileAccessType: 'readable',
        isDirectory: false,
      }),
    ).toBe('File: /private/example/secret.txt');
    expect(isPersistableBrowserPermission('fileSystem')).toBe(false);
    expect(isPersistableBrowserPermission('media')).toBe(true);
  });

  it('fails closed when Electron omits any file-system grant scope', () => {
    expect(browserPermissionStorageKeys('fileSystem')).toEqual([]);
    expect(
      browserPermissionStorageKeys('fileSystem', {
        filePath: '/private/example/secret.txt',
        fileAccessType: 'readable',
      }),
    ).toEqual([]);
    expect(
      browserPermissionStorageKeys('fileSystem', {
        filePath: '/private/example/secret.txt',
        isDirectory: false,
      }),
    ).toEqual([]);
    expect(
      browserPermissionStorageKeys('fileSystem', {
        fileAccessType: 'readable',
        isDirectory: false,
      }),
    ).toEqual([]);
  });

  it('preserves ordinary permission names', () => {
    expect(browserPermissionStorageKeys('notifications')).toEqual(['notifications']);
  });

  it('scopes external-app grants to one safe destination and never persists them', () => {
    const first = browserPermissionStorageKeys('openExternal', {
      externalURL: 'https://example.com/one?token=secret',
    });
    const equivalent = browserPermissionStorageKeys('openExternal', {
      externalURL: 'https://example.com:443/one?token=secret',
    });
    const second = browserPermissionStorageKeys('openExternal', {
      externalURL: 'https://example.com/two',
    });

    expect(first).toEqual(equivalent);
    expect(first).not.toEqual(second);
    expect(first[0]).not.toContain('example.com');
    expect(first[0]).not.toContain('secret');
    expect(isPersistableBrowserPermission('openExternal')).toBe(false);
    expect(
      browserPermissionTargetLabel('openExternal', {
        externalURL: 'https://example.com/one?token=secret',
      }),
    ).toBe('External URL: https://example.com/one?token=secret');
  });

  it('rejects missing, malformed, and unsafe external-app destinations', () => {
    expect(browserPermissionStorageKeys('openExternal')).toEqual([]);
    expect(browserPermissionStorageKeys('openExternal', { externalURL: 'not a URL' })).toEqual([]);
    expect(browserPermissionStorageKeys('openExternal', { externalURL: 'file:///etc/passwd' })).toEqual([]);
    expect(browserPermissionStorageKeys('openExternal', { externalURL: 'custom-handler://payload' })).toEqual([]);
    expect(browserPermissionTargetLabel('openExternal', { externalURL: 'file:///etc/passwd' })).toBeUndefined();
  });

  it('bounds external-app destination labels', () => {
    const label = browserPermissionTargetLabel('openExternal', {
      externalURL: `https://example.com/${'a'.repeat(1_000)}`,
    });

    expect(label).toHaveLength('External URL: '.length + 512);
    expect(label).toMatch(/^External URL: https:\/\/example\.com\//);
    expect(label).toMatch(/…$/);
  });

  it('never treats opaque or malformed origins as persistent permission buckets', () => {
    expect(normalizeBrowserPermissionOrigin('data:text/html,hello')).toBe('opaque page');
    expect(normalizeBrowserPermissionOrigin('not a url')).toBe('unknown page');
    expect(isPersistentBrowserPermissionOrigin('opaque page')).toBe(false);
    expect(isPersistentBrowserPermissionOrigin('unknown page')).toBe(false);
    expect(isPersistentBrowserPermissionOrigin('https://example.com')).toBe(true);
  });
});

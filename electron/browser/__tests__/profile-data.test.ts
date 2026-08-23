import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearChromiumBrowserScopeCleared,
  clearPendingBrowserCleanupScopeKey,
  finalizePendingBrowserCleanupRecovery,
  hasStoredBrowserScopeData,
  isChromiumBrowserScopeCleared,
  listPendingBrowserCleanupScopeKeys,
  listStoredChromiumBrowserScopeKeys,
  MAX_PENDING_BROWSER_CLEANUP_FILE_BYTES,
  MAX_PENDING_BROWSER_CLEANUP_SCOPE_KEYS,
  markChromiumBrowserScopeCleared,
  markPendingBrowserCleanupScopeKey,
} from '../profile-data.js';
import { browserPartitionForScopeKey } from '../session.js';
import { assistantDownloadQuarantineDirectory } from '../download-quarantine.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('browser profile data detection', () => {
  it('does not instantiate nonexistent conversation profiles during cleanup', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-profile-'));
    homes.push(appHome);
    const sessionDataPath = join(appHome, 'chromium-session-data');
    const scopeKey = 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa';
    expect(hasStoredBrowserScopeData(appHome, sessionDataPath, scopeKey)).toBe(false);

    const partitionName = browserPartitionForScopeKey(scopeKey).slice('persist:'.length);
    mkdirSync(join(sessionDataPath, 'Partitions', partitionName), { recursive: true });
    expect(hasStoredBrowserScopeData(appHome, sessionDataPath, scopeKey)).toBe(true);
  });

  it('detects profiles containing only independently persisted history or downloads', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-profile-'));
    homes.push(appHome);
    const sessionDataPath = join(appHome, 'chromium-session-data');
    const profileDirectory = join(appHome, 'browser', 'profiles');
    mkdirSync(profileDirectory, { recursive: true });
    const historyScope = 'conversation-cccccccccccccccccccccccc';
    const downloadsScope = 'conversation-dddddddddddddddddddddddd';
    writeFileSync(join(profileDirectory, `${historyScope}.history.json`), '{}');
    writeFileSync(join(profileDirectory, `${downloadsScope}.downloads.json`), '{}');

    expect(hasStoredBrowserScopeData(appHome, sessionDataPath, historyScope)).toBe(true);
    expect(hasStoredBrowserScopeData(appHome, sessionDataPath, downloadsScope)).toBe(true);
  });

  it('detects a crash-left assistant download quarantine before shelf metadata exists', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-profile-'));
    homes.push(appHome);
    const sessionDataPath = join(appHome, 'chromium-session-data');
    const scopeKey = 'conversation-bbbbbbbbbbbbbbbbbbbbbbbb';
    mkdirSync(assistantDownloadQuarantineDirectory(appHome, scopeKey), { recursive: true });

    expect(hasStoredBrowserScopeData(appHome, sessionDataPath, scopeKey)).toBe(true);
  });

  it('enumerates only validated Browser-owned Chromium partition directories', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-profile-'));
    homes.push(appHome);
    const sessionDataPath = join(appHome, 'chromium-session-data');
    const partitions = join(sessionDataPath, 'Partitions');
    const conversationScope = 'conversation-eeeeeeeeeeeeeeeeeeeeeeee';
    for (const name of [
      browserPartitionForScopeKey('global').slice('persist:'.length),
      browserPartitionForScopeKey(conversationScope).slice('persist:'.length),
      'plugin-owned-partition',
      'kai-browser-conversation-not-a-valid-key',
    ]) {
      mkdirSync(join(partitions, name), { recursive: true });
    }
    writeFileSync(join(partitions, 'kai-browser-conversation-ffffffffffffffffffffffff'), 'not a directory');

    expect(listStoredChromiumBrowserScopeKeys(appHome, sessionDataPath).sort()).toEqual(
      ['global', conversationScope].sort(),
    );
  });

  it('does not resurrect cleared profiles from Chromium partition scaffolding', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-profile-'));
    homes.push(appHome);
    const sessionDataPath = join(appHome, 'chromium-session-data');
    const scopeKey = 'conversation-ffffffffffffffffffffffff';
    const partitionName = browserPartitionForScopeKey(scopeKey).slice('persist:'.length);
    mkdirSync(join(sessionDataPath, 'Partitions', partitionName), { recursive: true });

    markChromiumBrowserScopeCleared(appHome, scopeKey);
    expect(isChromiumBrowserScopeCleared(appHome, scopeKey)).toBe(true);
    expect(listStoredChromiumBrowserScopeKeys(appHome, sessionDataPath)).not.toContain(scopeKey);
    expect(hasStoredBrowserScopeData(appHome, sessionDataPath, scopeKey)).toBe(false);

    clearChromiumBrowserScopeCleared(appHome, scopeKey);
    expect(isChromiumBrowserScopeCleared(appHome, scopeKey)).toBe(false);
    expect(listStoredChromiumBrowserScopeKeys(appHome, sessionDataPath)).toContain(scopeKey);
    expect(hasStoredBrowserScopeData(appHome, sessionDataPath, scopeKey)).toBe(true);
  });

  it('retains failed deleted-conversation cleanup as a retryable Browser Data profile', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-profile-'));
    homes.push(appHome);
    const first = 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa';
    const second = 'conversation-bbbbbbbbbbbbbbbbbbbbbbbb';

    markPendingBrowserCleanupScopeKey(appHome, first);
    markPendingBrowserCleanupScopeKey(appHome, second);
    markPendingBrowserCleanupScopeKey(appHome, first);
    expect(listPendingBrowserCleanupScopeKeys(appHome)).toEqual([first, second]);

    clearPendingBrowserCleanupScopeKey(appHome, first);
    expect(listPendingBrowserCleanupScopeKeys(appHome)).toEqual([second]);
    clearPendingBrowserCleanupScopeKey(appHome, second);
    expect(listPendingBrowserCleanupScopeKeys(appHome)).toEqual([]);
  });

  it('surfaces corrupt cleanup metadata and unreadable partition layouts', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-profile-'));
    homes.push(appHome);
    const browserDirectory = join(appHome, 'browser');
    mkdirSync(browserDirectory, { recursive: true });
    writeFileSync(join(browserDirectory, 'pending-profile-cleanup.json'), '{not-json');

    expect(() => listPendingBrowserCleanupScopeKeys(appHome)).toThrow();

    const recoveredScope = 'conversation-aaaaaaaaaaaaaaaaaaaaaaaa';
    expect(markPendingBrowserCleanupScopeKey(appHome, recoveredScope)).toBe(false);
    expect(() => listPendingBrowserCleanupScopeKeys(appHome)).toThrow();
    expect(clearPendingBrowserCleanupScopeKey(appHome, recoveredScope)).toBe(false);
    expect(() => listPendingBrowserCleanupScopeKeys(appHome)).toThrow();
    expect(markPendingBrowserCleanupScopeKey(appHome, recoveredScope)).toBe(false);
    expect(() => finalizePendingBrowserCleanupRecovery(appHome, new Set())).toThrow(/was not cleared/i);
    finalizePendingBrowserCleanupRecovery(appHome, new Set([recoveredScope]));
    expect(listPendingBrowserCleanupScopeKeys(appHome)).toEqual([]);

    const sessionDataPath = join(appHome, 'chromium-session-data');
    mkdirSync(sessionDataPath, { recursive: true });
    writeFileSync(join(sessionDataPath, 'Partitions'), 'not a directory');
    expect(() => listStoredChromiumBrowserScopeKeys(appHome, sessionDataPath)).toThrow();
  });

  it('bounds legacy cleanup metadata before parsing or enumerating entries', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-profile-'));
    homes.push(appHome);
    const browserDirectory = join(appHome, 'browser');
    const markerPath = join(browserDirectory, 'pending-profile-cleanup.json');
    mkdirSync(browserDirectory, { recursive: true });

    writeFileSync(markerPath, 'x'.repeat(MAX_PENDING_BROWSER_CLEANUP_FILE_BYTES + 1));
    expect(() => listPendingBrowserCleanupScopeKeys(appHome)).toThrow(/too large/i);

    const scopeKeys = Array.from(
      { length: MAX_PENDING_BROWSER_CLEANUP_SCOPE_KEYS + 1 },
      (_, index) => `conversation-${index.toString(16).padStart(24, '0')}`,
    );
    writeFileSync(markerPath, JSON.stringify({ version: 1, scopeKeys }));
    expect(() => listPendingBrowserCleanupScopeKeys(appHome)).toThrow(/invalid pending/i);
  });

  it.runIf(process.platform !== 'win32')('refuses symlinked legacy cleanup metadata', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-profile-'));
    homes.push(appHome);
    const browserDirectory = join(appHome, 'browser');
    const markerPath = join(browserDirectory, 'pending-profile-cleanup.json');
    const targetPath = join(appHome, 'outside-cleanup.json');
    mkdirSync(browserDirectory, { recursive: true });
    writeFileSync(targetPath, JSON.stringify({ version: 1, scopeKeys: ['global'] }));
    symlinkSync(targetPath, markerPath);

    expect(() => listPendingBrowserCleanupScopeKeys(appHome)).toThrow();
  });

  it.runIf(process.platform !== 'win32')('rejects cleanup metadata directories and FIFOs without blocking', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-profile-'));
    homes.push(appHome);
    const browserDirectory = join(appHome, 'browser');
    const markerPath = join(browserDirectory, 'pending-profile-cleanup.json');
    mkdirSync(markerPath, { recursive: true });

    expect(() => listPendingBrowserCleanupScopeKeys(appHome)).toThrow(/regular file/i);

    rmSync(markerPath, { recursive: true });
    execFileSync('mkfifo', [markerPath]);
    expect(() => listPendingBrowserCleanupScopeKeys(appHome)).toThrow(/regular file/i);
  });

  it('repairs oversized aggregate cleanup metadata only through explicit full-profile recovery', () => {
    const appHome = mkdtempSync(join(tmpdir(), 'kai-browser-profile-'));
    homes.push(appHome);
    const browserDirectory = join(appHome, 'browser');
    mkdirSync(browserDirectory, { recursive: true });
    writeFileSync(
      join(browserDirectory, 'pending-profile-cleanup.json'),
      'x'.repeat(MAX_PENDING_BROWSER_CLEANUP_FILE_BYTES + 1),
    );

    expect(() => listPendingBrowserCleanupScopeKeys(appHome)).toThrow(/too large/i);
    finalizePendingBrowserCleanupRecovery(appHome, new Set(['global']));
    expect(listPendingBrowserCleanupScopeKeys(appHome)).toEqual([]);
  });
});

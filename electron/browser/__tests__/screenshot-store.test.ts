import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_BROWSER_SCREENSHOT_RETENTION,
  prepareBrowserScreenshotRetention,
  removeBrowserScreenshotsForConversation,
  removeBrowserScreenshotsForScopeKey,
  type BrowserScreenshotRetention,
} from '../screenshot-store.js';
import { browserScopeKey } from '../session.js';

function retention(patch: Partial<BrowserScreenshotRetention>): BrowserScreenshotRetention {
  return { ...DEFAULT_BROWSER_SCREENSHOT_RETENTION, ...patch };
}

describe('retained Browser screenshots', () => {
  let appHome: string;

  beforeEach(() => {
    appHome = mkdtempSync(join(tmpdir(), 'kai-browser-screenshots-'));
  });

  afterEach(() => {
    rmSync(appHome, { recursive: true, force: true });
  });

  it('stores private captures beneath an opaque conversation directory', () => {
    const capture = prepareBrowserScreenshotRetention(appHome, '../../conversation-secret', 'global');
    capture.persist(Buffer.from('png-data'));

    expect(capture.filePath).toMatch(/\/media\/browser\/conversations\/[a-f0-9]{24}\/browser-g-\d+-[a-f0-9]{8}\.png$/);
    expect(capture.filePath).not.toContain('conversation-secret');
    expect(readFileSync(capture.filePath).toString()).toBe('png-data');
    expect(statSync(capture.filePath).mode & 0o777).toBe(0o600);
  });

  it('evicts the oldest conversation capture at count and byte ceilings', () => {
    const limits = retention({
      maxAgeMs: 0,
      maxPerConversationCount: 2,
      maxPerConversationBytes: 8,
      maxGlobalCount: 100,
      maxGlobalBytes: 1_000,
    });
    const first = prepareBrowserScreenshotRetention(appHome, 'chat-1', 'global', limits);
    first.persist(Buffer.from('1111'));
    utimesSync(first.filePath, 1, 1);
    const second = prepareBrowserScreenshotRetention(appHome, 'chat-1', 'global', limits);
    second.persist(Buffer.from('2222'));
    utimesSync(second.filePath, 2, 2);
    const third = prepareBrowserScreenshotRetention(appHome, 'chat-1', 'global', limits);
    third.persist(Buffer.from('3333'));

    expect(existsSync(first.filePath)).toBe(false);
    expect(existsSync(second.filePath)).toBe(true);
    expect(existsSync(third.filePath)).toBe(true);
  });

  it('enforces aggregate age and count retention across conversations', () => {
    const limits = retention({
      maxAgeMs: 1_000,
      maxPerConversationCount: 20,
      maxPerConversationBytes: 1_000,
      maxGlobalCount: 2,
      maxGlobalBytes: 1_000,
    });
    const nowSeconds = Date.now() / 1_000;
    const expired = prepareBrowserScreenshotRetention(appHome, 'chat-expired', 'global', limits);
    expired.persist(Buffer.from('old'));
    utimesSync(expired.filePath, nowSeconds - 10, nowSeconds - 10);
    const first = prepareBrowserScreenshotRetention(appHome, 'chat-1', 'global', limits);
    first.persist(Buffer.from('one'));
    utimesSync(first.filePath, nowSeconds - 0.5, nowSeconds - 0.5);
    const second = prepareBrowserScreenshotRetention(appHome, 'chat-2', 'global', limits);
    second.persist(Buffer.from('two'));
    utimesSync(second.filePath, nowSeconds - 0.25, nowSeconds - 0.25);
    const third = prepareBrowserScreenshotRetention(appHome, 'chat-3', 'global', limits);
    third.persist(Buffer.from('three'));

    expect(existsSync(expired.filePath)).toBe(false);
    expect(existsSync(first.filePath)).toBe(false);
    expect(existsSync(second.filePath)).toBe(true);
    expect(existsSync(third.filePath)).toBe(true);
  });

  it('clears profile captures independently and removes every scope when a conversation is deleted', () => {
    const chatOneScope = browserScopeKey('conversation', 'chat-1');
    const chatTwoScope = browserScopeKey('conversation', 'chat-2');
    const globalOne = prepareBrowserScreenshotRetention(appHome, 'chat-1', 'global');
    const scopedOne = prepareBrowserScreenshotRetention(appHome, 'chat-1', chatOneScope);
    const globalTwo = prepareBrowserScreenshotRetention(appHome, 'chat-2', 'global');
    const scopedTwo = prepareBrowserScreenshotRetention(appHome, 'chat-2', chatTwoScope);
    globalOne.persist(Buffer.from('global-one'));
    scopedOne.persist(Buffer.from('scoped-one'));
    globalTwo.persist(Buffer.from('global-two'));
    scopedTwo.persist(Buffer.from('scoped-two'));
    const legacyGlobalPath = globalOne.filePath.replace(
      /browser-g-\d+-[a-f0-9]{8}\.png$/,
      'browser-1700000000000-deadbeef.png',
    );
    writeFileSync(legacyGlobalPath, 'legacy-global');

    removeBrowserScreenshotsForScopeKey(appHome, 'global');
    expect(existsSync(globalOne.filePath)).toBe(false);
    expect(existsSync(globalTwo.filePath)).toBe(false);
    expect(existsSync(legacyGlobalPath)).toBe(false);
    expect(existsSync(scopedOne.filePath)).toBe(true);
    expect(existsSync(scopedTwo.filePath)).toBe(true);

    const globalRetryOne = prepareBrowserScreenshotRetention(appHome, 'chat-1', 'global');
    globalRetryOne.persist(Buffer.from('global-retry-one'));
    removeBrowserScreenshotsForScopeKey(appHome, chatOneScope);
    expect(existsSync(globalRetryOne.filePath)).toBe(false);
    expect(existsSync(scopedOne.filePath)).toBe(false);
    expect(existsSync(scopedTwo.filePath)).toBe(true);

    removeBrowserScreenshotsForConversation(appHome, 'chat-2');
    expect(existsSync(scopedTwo.filePath)).toBe(false);
  });

  it('rejects a conversation-profile capture for a different conversation', () => {
    expect(() =>
      prepareBrowserScreenshotRetention(appHome, 'chat-1', browserScopeKey('conversation', 'chat-2')),
    ).toThrow(/does not belong/);
  });
});

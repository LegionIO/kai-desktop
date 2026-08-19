import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { browserScopeKey, isBrowserScopeKey } from './session.js';

export type BrowserScreenshotRetention = Readonly<{
  maxAgeMs: number;
  maxPerConversationCount: number;
  maxPerConversationBytes: number;
  maxGlobalCount: number;
  maxGlobalBytes: number;
}>;

export const DEFAULT_BROWSER_SCREENSHOT_RETENTION: BrowserScreenshotRetention = {
  maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
  maxPerConversationCount: 50,
  maxPerConversationBytes: 256 * 1024 * 1024,
  maxGlobalCount: 500,
  maxGlobalBytes: 1024 * 1024 * 1024,
};

const CONVERSATION_DIRECTORY_RE = /^[a-f0-9]{24}$/;
const SCREENSHOT_FILENAME_RE = /^browser-([gc])-\d{1,16}-[a-f0-9]{8}\.png$/;
const LEGACY_SCREENSHOT_FILENAME_RE = /^browser-\d{1,16}-[a-f0-9]{8}\.png$/;

type StoredScreenshot = {
  filePath: string;
  conversationDigest: string;
  scopeKey: string | null;
  size: number;
  mtimeMs: number;
  name: string;
};

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}

function screenshotRoot(appHome: string): string {
  return join(appHome, 'media', 'browser');
}

function conversationDigest(conversationId: string): string {
  return browserScopeKey('conversation', conversationId).slice('conversation-'.length);
}

function verifyDirectory(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Browser screenshot storage is not a private directory: ${path}`);
  }
}

function ensurePrivateChild(parent: string, name: string): string {
  const target = join(parent, name);
  try {
    verifyDirectory(target);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    try {
      mkdirSync(target, { mode: 0o700 });
    } catch (mkdirError) {
      if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError;
    }
    verifyDirectory(target);
  }
  return target;
}

function ensureConversationDirectory(appHome: string, digest: string): string {
  mkdirSync(appHome, { recursive: true, mode: 0o700 });
  const media = ensurePrivateChild(appHome, 'media');
  const browser = ensurePrivateChild(media, 'browser');
  const conversations = ensurePrivateChild(browser, 'conversations');
  return ensurePrivateChild(conversations, digest);
}

function existingPrivateChild(parent: string, name: string): string | null {
  const target = join(parent, name);
  try {
    verifyDirectory(target);
    return target;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function listDirectory(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
}

function listStoredScreenshots(appHome: string): StoredScreenshot[] {
  const root = screenshotRoot(appHome);
  const conversations = join(root, 'conversations');
  const stored: StoredScreenshot[] = [];
  for (const directory of listDirectory(conversations)) {
    if (!directory.isDirectory() || !CONVERSATION_DIRECTORY_RE.test(directory.name)) continue;
    const directoryPath = join(conversations, directory.name);
    for (const file of listDirectory(directoryPath)) {
      if (!file.isFile()) continue;
      const scopeMarker = SCREENSHOT_FILENAME_RE.exec(file.name)?.[1];
      if (!scopeMarker && !LEGACY_SCREENSHOT_FILENAME_RE.test(file.name)) continue;
      const filePath = join(directoryPath, file.name);
      try {
        const stats = lstatSync(filePath);
        if (stats.isSymbolicLink() || !stats.isFile()) continue;
        stored.push({
          filePath,
          conversationDigest: directory.name,
          scopeKey: scopeMarker === 'g' ? 'global' : scopeMarker === 'c' ? `conversation-${directory.name}` : null,
          size: Math.max(0, stats.size),
          mtimeMs: stats.mtimeMs,
          name: file.name,
        });
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
  }
  return stored.sort(
    (left, right) =>
      left.mtimeMs - right.mtimeMs ||
      left.name.localeCompare(right.name) ||
      left.filePath.localeCompare(right.filePath),
  );
}

function exceedsLimit(entries: StoredScreenshot[], maxCount: number, maxBytes: number): boolean {
  return (
    (maxCount > 0 && entries.length > maxCount) ||
    (maxBytes > 0 && entries.reduce((total, entry) => total + entry.size, 0) > maxBytes)
  );
}

function enforceBrowserScreenshotRetention(
  appHome: string,
  currentFilePath: string,
  retention: BrowserScreenshotRetention,
): void {
  let entries = listStoredScreenshots(appHome);
  const remove = (entry: StoredScreenshot): void => {
    rmSync(entry.filePath, { force: true });
    entries = entries.filter((candidate) => candidate.filePath !== entry.filePath);
  };
  const evictUntil = (select: (entry: StoredScreenshot) => boolean, maxCount: number, maxBytes: number): void => {
    let selected = entries.filter(select);
    while (exceedsLimit(selected, maxCount, maxBytes)) {
      const candidate = selected.find((entry) => entry.filePath !== currentFilePath);
      if (!candidate) break;
      remove(candidate);
      selected = entries.filter(select);
    }
  };

  if (retention.maxAgeMs > 0) {
    const cutoff = Date.now() - retention.maxAgeMs;
    for (const entry of [...entries]) {
      if (entry.filePath !== currentFilePath && entry.mtimeMs < cutoff) remove(entry);
    }
  }

  const digests = new Set(entries.map((entry) => entry.conversationDigest));
  for (const digest of digests) {
    evictUntil(
      (entry) => entry.conversationDigest === digest,
      retention.maxPerConversationCount,
      retention.maxPerConversationBytes,
    );
  }
  evictUntil(() => true, retention.maxGlobalCount, retention.maxGlobalBytes);

  // Re-read actual disk sizes after eviction. If an undeletable/racing entry
  // leaves the store above a hard ceiling, roll back this new capture rather
  // than allowing repeated model calls to grow storage without bound.
  const finalEntries = listStoredScreenshots(appHome);
  const current = finalEntries.find((entry) => entry.filePath === currentFilePath);
  const currentConversation = current
    ? finalEntries.filter((entry) => entry.conversationDigest === current.conversationDigest)
    : [];
  if (
    !current ||
    exceedsLimit(currentConversation, retention.maxPerConversationCount, retention.maxPerConversationBytes) ||
    exceedsLimit(finalEntries, retention.maxGlobalCount, retention.maxGlobalBytes)
  ) {
    rmSync(currentFilePath, { force: true });
    throw new Error('Browser screenshot retention limits could not be enforced; the new capture was not retained.');
  }
}

export function prepareBrowserScreenshotRetention(
  appHome: string,
  conversationId: string,
  scopeKey: string,
  retention: BrowserScreenshotRetention = DEFAULT_BROWSER_SCREENSHOT_RETENTION,
): { filePath: string; persist: (png: Buffer) => void } {
  const digest = conversationDigest(conversationId);
  const conversationScopeKey = `conversation-${digest}`;
  if (scopeKey !== 'global' && scopeKey !== conversationScopeKey) {
    throw new Error('Browser screenshot profile does not belong to this conversation.');
  }
  const scopeMarker = scopeKey === 'global' ? 'g' : 'c';
  const filename = `browser-${scopeMarker}-${Date.now()}-${randomUUID().replaceAll('-', '').slice(0, 8)}.png`;
  const filePath = join(screenshotRoot(appHome), 'conversations', digest, filename);
  return {
    filePath,
    persist: (png: Buffer) => {
      const directory = ensureConversationDirectory(appHome, digest);
      const expectedPath = join(directory, filename);
      if (expectedPath !== filePath) throw new Error('Browser screenshot storage path changed unexpectedly.');
      atomicWriteFileSync(filePath, png, { mode: 0o600 });
      try {
        enforceBrowserScreenshotRetention(appHome, filePath, retention);
      } catch (error) {
        rmSync(filePath, { force: true });
        throw error;
      }
    },
  };
}

export function removeBrowserScreenshotsForScopeKey(appHome: string, scopeKey: string): void {
  if (!isBrowserScopeKey(scopeKey)) throw new Error('Invalid browser profile key.');
  if (scopeKey !== 'global') {
    // A failed conversation deletion is retried through its conversation
    // profile marker, but retained captures are conversation-owned even when
    // they were taken with the global cookie/storage profile. Remove the whole
    // private conversation directory so a successful retry cannot clear the
    // durable marker while leaving browser-g-* captures orphaned.
    removeBrowserScreenshotsForConversationDigest(appHome, scopeKey.slice('conversation-'.length));
    return;
  }
  for (const entry of listStoredScreenshots(appHome)) {
    // Captures created before scope markers were added have no recoverable
    // profile attribution. Browser data was global by default, so treat those
    // legacy files as global for explicit clearing instead of reporting a
    // successful clear while retaining them indefinitely.
    if (entry.scopeKey === scopeKey || entry.scopeKey === null) rmSync(entry.filePath, { force: true });
  }
}

function removeBrowserScreenshotsForConversationDigest(appHome: string, digest: string): void {
  const media = existingPrivateChild(appHome, 'media');
  if (!media) return;
  const browser = existingPrivateChild(media, 'browser');
  if (!browser) return;
  const conversations = existingPrivateChild(browser, 'conversations');
  if (!conversations) return;
  const directory = existingPrivateChild(conversations, digest);
  if (directory) rmSync(directory, { recursive: true, force: true });
}

export function removeBrowserScreenshotsForConversation(appHome: string, conversationId: string): void {
  removeBrowserScreenshotsForConversationDigest(appHome, conversationDigest(conversationId));
}

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { assistantDownloadQuarantineDirectory } from './download-quarantine.js';
import { browserPartitionForScopeKey, isBrowserScopeKey } from './session.js';

type PendingBrowserCleanupFile = { version: 1; scopeKeys: string[] };

export const MAX_PENDING_BROWSER_CLEANUP_FILE_BYTES = 256 * 1024;
export const MAX_PENDING_BROWSER_CLEANUP_SCOPE_KEYS = 4_096;
const PENDING_BROWSER_CLEANUP_MARKER_SUFFIX = '.pending';

class InvalidPendingBrowserCleanupDataError extends Error {}

function pendingCleanupPath(appHome: string): string {
  return join(appHome, 'browser', 'pending-profile-cleanup.json');
}

function pendingCleanupDirectory(appHome: string): string {
  return join(appHome, 'browser', 'pending-profile-cleanup');
}

function pendingCleanupScopePath(appHome: string, scopeKey: string): string {
  if (!isBrowserScopeKey(scopeKey)) throw new Error('Invalid browser profile key.');
  return join(pendingCleanupDirectory(appHome), `${scopeKey}${PENDING_BROWSER_CLEANUP_MARKER_SUFFIX}`);
}

function clearedChromiumProfilesDirectory(appHome: string): string {
  return join(appHome, 'browser', 'cleared-chromium-profiles');
}

function clearedChromiumProfilePath(appHome: string, scopeKey: string): string {
  if (!isBrowserScopeKey(scopeKey)) throw new Error('Invalid browser profile key.');
  return join(clearedChromiumProfilesDirectory(appHome), `${scopeKey}.cleared`);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function pathExists(filePath: string): boolean {
  try {
    statSync(filePath);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

/** Electron intentionally keeps a persistent partition directory after
 * clearStorageData(). Remember that the remaining directory is only Chromium
 * scaffolding so Settings does not resurrect an empty deleted-chat profile on
 * every restart. A subsequent main-frame navigation removes this tombstone. */
export function markChromiumBrowserScopeCleared(appHome: string, scopeKey: string): void {
  const filePath = clearedChromiumProfilePath(appHome, scopeKey);
  mkdirSync(clearedChromiumProfilesDirectory(appHome), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(filePath, '', { mode: 0o600 });
}

export function clearChromiumBrowserScopeCleared(appHome: string, scopeKey: string): void {
  rmSync(clearedChromiumProfilePath(appHome, scopeKey), { force: true });
}

export function isChromiumBrowserScopeCleared(appHome: string, scopeKey: string): boolean {
  return pathExists(clearedChromiumProfilePath(appHome, scopeKey));
}

function readBoundedPendingCleanupFile(filePath: string): string {
  const descriptor = openSync(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new InvalidPendingBrowserCleanupDataError(
        'Pending Browser-profile cleanup metadata must be a regular file.',
      );
    }
    if (
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 0 ||
      metadata.size > MAX_PENDING_BROWSER_CLEANUP_FILE_BYTES
    ) {
      throw new InvalidPendingBrowserCleanupDataError('Pending Browser-profile cleanup data is too large.');
    }
    const buffer = Buffer.allocUnsafe(metadata.size);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const next = readSync(descriptor, buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
      if (next === 0) break;
      bytesRead += next;
    }
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

function readLegacyPendingBrowserCleanupScopeKeys(appHome: string): string[] {
  const filePath = pendingCleanupPath(appHome);
  try {
    let parsed: Partial<PendingBrowserCleanupFile>;
    try {
      parsed = JSON.parse(readBoundedPendingCleanupFile(filePath)) as Partial<PendingBrowserCleanupFile>;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new InvalidPendingBrowserCleanupDataError('Invalid pending Browser-profile cleanup data.');
      }
      throw error;
    }
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.scopeKeys) ||
      parsed.scopeKeys.length > MAX_PENDING_BROWSER_CLEANUP_SCOPE_KEYS ||
      !parsed.scopeKeys.every((scopeKey): scopeKey is string => isBrowserScopeKey(scopeKey))
    ) {
      throw new InvalidPendingBrowserCleanupDataError('Invalid pending Browser-profile cleanup data.');
    }
    return [...new Set(parsed.scopeKeys)];
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

export function listPendingBrowserCleanupMarkerScopeKeys(appHome: string): string[] {
  let directory: ReturnType<typeof opendirSync> | undefined;
  try {
    directory = opendirSync(pendingCleanupDirectory(appHome));
    const scopeKeys: string[] = [];
    let entriesSeen = 0;
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      entriesSeen += 1;
      if (entriesSeen > MAX_PENDING_BROWSER_CLEANUP_SCOPE_KEYS) {
        throw new InvalidPendingBrowserCleanupDataError('Too many pending Browser-profile cleanup entries.');
      }
      if (!entry.isFile() || !entry.name.endsWith(PENDING_BROWSER_CLEANUP_MARKER_SUFFIX)) continue;
      const scopeKey = entry.name.slice(0, -PENDING_BROWSER_CLEANUP_MARKER_SUFFIX.length);
      if (!isBrowserScopeKey(scopeKey)) {
        throw new InvalidPendingBrowserCleanupDataError('Invalid pending Browser-profile cleanup entry.');
      }
      scopeKeys.push(scopeKey);
    }
    return scopeKeys;
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  } finally {
    try {
      directory?.closeSync();
    } catch {
      // A fully consumed directory can already be closed by the runtime.
    }
  }
}

function writePendingBrowserCleanupScopeMarker(appHome: string, scopeKey: string): void {
  const filePath = pendingCleanupScopePath(appHome, scopeKey);
  mkdirSync(pendingCleanupDirectory(appHome), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(filePath, '', { mode: 0o600 });
}

/** Profiles whose conversation deletion succeeded but Browser-data cleanup did
 * not. Retaining the scope key makes an otherwise Chromium-only profile visible
 * and retryable from Settings after the owning conversation no longer exists. */
export function listPendingBrowserCleanupScopeKeys(appHome: string): string[] {
  const scopeKeys = new Set([
    ...readLegacyPendingBrowserCleanupScopeKeys(appHome),
    ...listPendingBrowserCleanupMarkerScopeKeys(appHome),
  ]);
  if (scopeKeys.size > MAX_PENDING_BROWSER_CLEANUP_SCOPE_KEYS) {
    throw new InvalidPendingBrowserCleanupDataError('Too many pending Browser-profile cleanup entries.');
  }
  return [...scopeKeys].sort();
}

/** Record one failed profile cleanup with an O(1) sidecar marker. The legacy
 * aggregate JSON remains read-only until a successful clear migrates it, which
 * avoids quadratic read/serialize/rewrite work during bulk deletion failures.
 * Returns false when an unknown legacy marker keeps process-wide quarantine. */
export function markPendingBrowserCleanupScopeKey(appHome: string, scopeKey: string): boolean {
  if (!isBrowserScopeKey(scopeKey)) throw new Error('Invalid browser profile key.');
  writePendingBrowserCleanupScopeMarker(appHome, scopeKey);
  try {
    readLegacyPendingBrowserCleanupScopeKeys(appHome);
    return true;
  } catch (error) {
    if (!(error instanceof InvalidPendingBrowserCleanupDataError)) throw error;
    return false;
  }
}

/** Remove one exact marker. A malformed/oversized legacy aggregate has unknown
 * scope and is deliberately retained; clearing one profile cannot prove every
 * profile represented by that marker is safe. Returns whether the durable
 * marker state is fully readable after this update. */
export function clearPendingBrowserCleanupScopeKey(appHome: string, scopeKey: string): boolean {
  if (!isBrowserScopeKey(scopeKey)) throw new Error('Invalid browser profile key.');
  rmSync(pendingCleanupScopePath(appHome, scopeKey), { force: true });
  const filePath = pendingCleanupPath(appHome);
  let legacyScopeKeys: string[];
  try {
    legacyScopeKeys = readLegacyPendingBrowserCleanupScopeKeys(appHome);
  } catch (error) {
    if (!(error instanceof InvalidPendingBrowserCleanupDataError)) throw error;
    return false;
  }
  // Migrate the bounded legacy aggregate to independent markers once. Future
  // failed bulk updates and retries stay constant-work per profile.
  for (const pendingScopeKey of legacyScopeKeys) {
    if (pendingScopeKey !== scopeKey) writePendingBrowserCleanupScopeMarker(appHome, pendingScopeKey);
  }
  rmSync(filePath, { force: true });
  return true;
}

/** Commit an explicit full-profile recovery after every discoverable Browser
 * profile has been cleared. Unknown legacy entries are safe to forget only at
 * this point; independently readable sidecar entries must all be represented
 * in the successful clear set. */
export function finalizePendingBrowserCleanupRecovery(appHome: string, clearedScopeKeys: ReadonlySet<string>): void {
  let legacyScopeKeys: string[] | null;
  try {
    legacyScopeKeys = readLegacyPendingBrowserCleanupScopeKeys(appHome);
  } catch (error) {
    if (!(error instanceof InvalidPendingBrowserCleanupDataError)) throw error;
    legacyScopeKeys = null;
  }
  const markerScopeKeys = listPendingBrowserCleanupMarkerScopeKeys(appHome);
  for (const scopeKey of [...(legacyScopeKeys ?? []), ...markerScopeKeys]) {
    if (!clearedScopeKeys.has(scopeKey)) {
      throw new Error(`Browser profile ${scopeKey} was not cleared during full cleanup recovery.`);
    }
  }
  // Remove the unknown aggregate first. A crash while deleting the validated
  // sidecars leaves a narrower readable quarantine rather than no quarantine.
  rmSync(pendingCleanupPath(appHome), { force: true });
  for (const scopeKey of markerScopeKeys) {
    rmSync(pendingCleanupScopePath(appHome, scopeKey), { force: true });
  }
}

/** Detect a persistent profile without instantiating Electron's Session. Merely
 * calling session.fromPartition creates process state, so bulk conversation
 * deletion first checks Kai metadata/vault files and Chromium's partition
 * directory and skips conversations that have never used conversation-scoped
 * Browser data. */
export function hasStoredBrowserScopeData(appHome: string, sessionDataPath: string, scopeKey: string): boolean {
  const partitionName = browserPartitionForScopeKey(scopeKey).slice('persist:'.length);
  if (pathExists(join(appHome, 'browser', 'profiles', `${scopeKey}.json`))) return true;
  if (pathExists(join(appHome, 'browser', 'profiles', `${scopeKey}.history.json`))) return true;
  if (pathExists(join(appHome, 'browser', 'profiles', `${scopeKey}.downloads.json`))) return true;
  if (pathExists(join(appHome, 'browser', 'credentials', `${scopeKey}.json`))) return true;
  // DownloadItem can create its private destination before the shelf sidecar is
  // durably written. Treat even an empty crash-left directory as profile data.
  if (pathExists(assistantDownloadQuarantineDirectory(appHome, scopeKey))) return true;
  return (
    !isChromiumBrowserScopeCleared(appHome, scopeKey) && pathExists(join(sessionDataPath, 'Partitions', partitionName))
  );
}

/** Enumerate Browser-owned Chromium profiles even when Kai's companion
 * metadata was never written (for example, after an interrupted cleanup). */
export function listStoredChromiumBrowserScopeKeys(appHome: string, sessionDataPath: string): string[] {
  const partitionsDirectory = join(sessionDataPath, 'Partitions');
  const globalPartitionName = browserPartitionForScopeKey('global').slice('persist:'.length).toLowerCase();
  const prefix = globalPartitionName.slice(0, -'global'.length);
  try {
    return [
      ...new Set(
        readdirSync(partitionsDirectory, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name.toLowerCase())
          .filter((name) => name.startsWith(prefix))
          .map((name) => name.slice(prefix.length))
          .filter((scopeKey): scopeKey is string => isBrowserScopeKey(scopeKey))
          .filter((scopeKey) => !isChromiumBrowserScopeCleared(appHome, scopeKey)),
      ),
    ];
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

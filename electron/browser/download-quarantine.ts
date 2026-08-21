import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  promises as fsPromises,
  readdirSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const MAX_ASSISTANT_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_ASSISTANT_QUARANTINE_FILES_PER_SCOPE = 25;
export const MAX_ASSISTANT_QUARANTINE_BYTES_PER_SCOPE = 512 * 1024 * 1024;
export const MAX_ASSISTANT_QUARANTINE_AGE_MS = 24 * 60 * 60 * 1_000;

const QUARANTINE_FILENAME =
  /^Kai-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.download$/i;
const QUARANTINE_PARTIAL_FILENAME =
  /^Kai-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.download\.crdownload$/i;
const QUARANTINE_SCOPE_KEY = /^(global|conversation-[a-f0-9]{24})$/;
const EXPORT_JOURNAL_FILENAME =
  /^Kai-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;
const MAX_EXPORT_JOURNAL_BYTES = 16 * 1024;
const MAX_XATTR_ERROR_BYTES = 8 * 1_024;

type AssistantDownloadExportOptions = {
  platform?: NodeJS.Platform;
  now?: number;
  exportId?: string;
  writeMacOsQuarantineAttribute?: (path: string, value: string, handle: FileHandle) => Promise<void>;
  removeExportJournal?: (path: string) => Promise<void>;
};

export type PrunedAssistantDownload = {
  id: string;
  path: string;
};

export type PrunedAssistantDownloadScope = {
  scopeKey: string;
  downloads: PrunedAssistantDownload[];
};

function safeScopeKey(value: string): string {
  if (!QUARANTINE_SCOPE_KEY.test(value)) {
    throw new Error('Invalid browser download profile key.');
  }
  return value;
}

function safeDownloadId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Invalid browser download id.');
  }
  return value.toLowerCase();
}

export function assistantDownloadQuarantineRoot(appHome: string): string {
  return join(appHome, 'browser', 'download-quarantine');
}

export function assistantDownloadExportJournalDirectory(appHome: string): string {
  return join(appHome, 'browser', 'download-export-journal');
}

export function assistantDownloadQuarantineDirectory(appHome: string, scopeKey: string): string {
  return join(assistantDownloadQuarantineRoot(appHome), safeScopeKey(scopeKey));
}

export function assistantDownloadQuarantinePath(appHome: string, scopeKey: string, id: string): string {
  return join(assistantDownloadQuarantineDirectory(appHome, scopeKey), `Kai-${safeDownloadId(id)}.download`);
}

function verifyOwnedDirectory(path: string): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error('The assistant download quarantine contains an unsafe non-directory path.', { cause: error });
  }
  try {
    if (!fstatSync(descriptor).isDirectory()) {
      throw new Error('The assistant download quarantine contains an unsafe non-directory path.');
    }
  } finally {
    closeSync(descriptor);
  }
  return true;
}

function ensurePrivateOwnedDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  let descriptor: number;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    throw new Error('The assistant download quarantine path must be an app-owned directory.', { cause: error });
  }
  try {
    if (!fstatSync(descriptor).isDirectory()) {
      throw new Error('The assistant download quarantine path must be an app-owned directory.');
    }
    // Apply permissions through the no-follow descriptor so a planted symlink
    // can never redirect chmod to an unrelated directory.
    fchmodSync(descriptor, 0o700);
  } finally {
    closeSync(descriptor);
  }
}

function verifyQuarantineHierarchy(appHome: string, scopeKey?: string): boolean {
  const browserDirectory = join(appHome, 'browser');
  if (!verifyOwnedDirectory(browserDirectory)) return false;
  const root = assistantDownloadQuarantineRoot(appHome);
  if (!verifyOwnedDirectory(root)) return false;
  return scopeKey === undefined ? true : verifyOwnedDirectory(assistantDownloadQuarantineDirectory(appHome, scopeKey));
}

function ensureQuarantineHierarchy(appHome: string, scopeKey: string): void {
  ensurePrivateOwnedDirectory(join(appHome, 'browser'));
  ensurePrivateOwnedDirectory(assistantDownloadQuarantineRoot(appHome));
  ensurePrivateOwnedDirectory(assistantDownloadQuarantineDirectory(appHome, scopeKey));
}

function ensureExportJournalHierarchy(appHome: string): void {
  ensurePrivateOwnedDirectory(join(appHome, 'browser'));
  ensurePrivateOwnedDirectory(assistantDownloadExportJournalDirectory(appHome));
}

export function isAssistantDownloadQuarantinePath(
  appHome: string,
  scopeKey: string,
  id: string,
  candidate: string,
): boolean {
  try {
    return resolve(candidate) === resolve(assistantDownloadQuarantinePath(appHome, scopeKey, id));
  } catch {
    return false;
  }
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function removeFileIfPresent(path: string): Promise<void> {
  try {
    await fsPromises.unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function pruneAssistantDownloadQuarantine(
  appHome: string,
  scopeKey: string,
  protectedPaths: ReadonlySet<string> = new Set(),
  options: {
    now?: number;
    reserveFiles?: number;
    reserveBytes?: number;
    reservationsIncludeProtectedPaths?: boolean;
  } = {},
): PrunedAssistantDownload[] {
  const directory = assistantDownloadQuarantineDirectory(appHome, scopeKey);
  if (!verifyQuarantineHierarchy(appHome, scopeKey)) return [];
  const protectedResolved = new Set([...protectedPaths].map((path) => resolve(path)));
  const now = options.now ?? Date.now();
  const entries: Array<{ id: string; path: string; size: number; modifiedAt: number; protected: boolean }> = [];
  const pruned: PrunedAssistantDownload[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const match = QUARANTINE_FILENAME.exec(entry.name);
    const partialMatch = QUARANTINE_PARTIAL_FILENAME.exec(entry.name);
    if (partialMatch) {
      const path = join(directory, entry.name);
      const finalPath = path.slice(0, -'.crdownload'.length);
      const protectedFile = protectedResolved.has(resolve(finalPath)) || protectedResolved.has(resolve(path));
      const stats = lstatSync(path);
      if (!protectedFile) {
        if (!stats.isDirectory()) removeFile(path);
        pruned.push({ id: partialMatch[1].toLowerCase(), path: finalPath });
        continue;
      }
      if (!stats.isFile()) continue;
      entries.push({
        id: partialMatch[1].toLowerCase(),
        path,
        size: stats.size,
        modifiedAt: stats.mtimeMs,
        protected: true,
      });
      continue;
    }
    if (!match) continue;
    const path = join(directory, entry.name);
    const protectedFile = protectedResolved.has(resolve(path));
    const stats = lstatSync(path);
    if (!stats.isFile()) {
      // A locally planted symlink/device must never be exported or counted as
      // browser-owned content. Unlink it without following the target and mark
      // any matching metadata unavailable; a directory is left intact but is
      // likewise never advertised as an exportable download.
      if (!protectedFile) {
        if (stats.isSymbolicLink() || !entry.isDirectory()) removeFile(path);
        pruned.push({ id: match[1].toLowerCase(), path });
      }
      continue;
    }
    if (!protectedFile && now - stats.mtimeMs > MAX_ASSISTANT_QUARANTINE_AGE_MS) {
      removeFile(path);
      pruned.push({ id: match[1].toLowerCase(), path });
      continue;
    }
    entries.push({
      id: match[1].toLowerCase(),
      path,
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      protected: protectedFile,
    });
  }

  const maxFiles = Math.max(0, MAX_ASSISTANT_QUARANTINE_FILES_PER_SCOPE - (options.reserveFiles ?? 0));
  const maxBytes = Math.max(0, MAX_ASSISTANT_QUARANTINE_BYTES_PER_SCOPE - (options.reserveBytes ?? 0));
  const protectedEntries = entries.filter((entry) => entry.protected);
  // Active downloads are protected from pruning. Callers that reserve their
  // complete worst-case size have already accounted for these entries, so do
  // not count their current partial files a second time against completed-file
  // retention. This leaves exactly the unreserved capacity for old artifacts.
  let retainedCount = options.reservationsIncludeProtectedPaths ? 0 : protectedEntries.length;
  let retainedBytes = options.reservationsIncludeProtectedPaths
    ? 0
    : protectedEntries.reduce((total, entry) => total + entry.size, 0);
  const candidates = entries
    .filter((entry) => !entry.protected)
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const entry of candidates) {
    if (retainedCount >= maxFiles || retainedBytes + entry.size > maxBytes) {
      removeFile(entry.path);
      pruned.push({ id: entry.id, path: entry.path });
      continue;
    }
    retainedCount += 1;
    retainedBytes += entry.size;
  }
  return pruned;
}

export function prepareAssistantDownloadQuarantine(
  appHome: string,
  scopeKey: string,
  id: string,
  protectedPaths: ReadonlySet<string> = new Set(),
  onPruned?: (downloads: PrunedAssistantDownload[]) => void,
): string {
  // `will-download` callbacks run synchronously on Electron's main thread. By
  // admitting a new item only after reserving the full per-file ceiling for it
  // and every already-active item, parallel network writers can never grow past
  // the aggregate profile quotas between progress events.
  const reservedFiles = protectedPaths.size + 1;
  const reservedBytes = reservedFiles * MAX_ASSISTANT_DOWNLOAD_BYTES;
  if (
    reservedFiles > MAX_ASSISTANT_QUARANTINE_FILES_PER_SCOPE ||
    reservedBytes > MAX_ASSISTANT_QUARANTINE_BYTES_PER_SCOPE
  ) {
    throw new Error('The assistant download quarantine has no capacity for another active download.');
  }
  ensureQuarantineHierarchy(appHome, scopeKey);
  const pruned = pruneAssistantDownloadQuarantine(appHome, scopeKey, protectedPaths, {
    reserveFiles: reservedFiles,
    reserveBytes: reservedBytes,
    reservationsIncludeProtectedPaths: true,
  });
  if (pruned.length > 0) onPruned?.(pruned);
  return assistantDownloadQuarantinePath(appHome, scopeKey, id);
}

export function secureAssistantDownloadFile(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > MAX_ASSISTANT_DOWNLOAD_BYTES) {
      throw new Error('The quarantined browser download is not a regular file or exceeds the download limit.');
    }
    // Validate and chmod the same opened inode. A local path replacement after
    // open can no longer redirect permissions to a symlink target or a
    // different file.
    fchmodSync(descriptor, 0o600);
  } catch (error) {
    if (error instanceof Error && error.message.includes('exceeds the download limit')) throw error;
    throw new Error('The quarantined browser download is not a regular file or exceeds the download limit.', {
      cause: error,
    });
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

async function openAssistantDownloadForExport(path: string): Promise<{ handle: FileHandle; size: number }> {
  let handle: FileHandle | null = null;
  try {
    handle = await fsPromises.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_ASSISTANT_DOWNLOAD_BYTES) {
      throw new Error('The quarantined browser download is unavailable or exceeds the export limit.');
    }
    return { handle, size: stats.size };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof Error && error.message.includes('exceeds the export limit')) throw error;
    throw new Error('The quarantined browser download is unavailable or exceeds the export limit.', {
      cause: error,
    });
  }
}

async function copyOpenedAssistantDownload(
  source: FileHandle,
  expectedSize: number,
  destination: string,
): Promise<FileHandle> {
  const output = await fsPromises.open(
    destination,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    0o600,
  );
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  try {
    while (position < expectedSize) {
      const requested = Math.min(buffer.length, expectedSize - position);
      const { bytesRead } = await source.read(buffer, 0, requested, position);
      if (bytesRead <= 0) {
        throw new Error('The quarantined browser download changed while it was being exported.');
      }
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten <= 0) {
          throw new Error('The quarantined browser download could not be copied completely.');
        }
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    // Do not let a file that grows after fstat bypass the per-download limit or
    // silently export a truncated payload. This read is against the same source
    // descriptor, not a second path lookup.
    const growthProbe = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await source.read(growthProbe, 0, 1, expectedSize);
    if (extraBytes !== 0) {
      throw new Error('The quarantined browser download changed while it was being exported.');
    }
    await output.chmod(0o600);
    await output.sync();
    return output;
  } catch (error) {
    await output.close();
    throw error;
  }
}

function macOsQuarantineValue(now: number, exportId: string): string {
  if (!Number.isFinite(now) || now < 0 || !/^[0-9a-f-]{36}$/i.test(exportId)) {
    throw new Error('The assistant download export quarantine metadata is invalid.');
  }
  // 0x0083 is the standard web-download quarantine flag used by Chromium on
  // macOS. A fresh event id avoids trusting page/download-provided metadata.
  return `0083;${Math.floor(now / 1_000).toString(16)};Kai;${exportId}`;
}

function assistantDownloadExportStagingPath(destination: string, exportId: string): string {
  // Keep the temporary name independent of the user-selected basename. A
  // destination can already be close to NAME_MAX, and repeating that basename
  // in the staging entry would make an otherwise valid export fail with
  // ENAMETOOLONG.
  return join(dirname(destination), `.kai-export-${safeDownloadId(exportId)}.tmp`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await fsPromises.open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeMacOsQuarantineAttribute(_path: string, value: string, handle?: FileHandle): Promise<void> {
  if (!handle) throw new Error('The assistant download export descriptor is unavailable.');
  await new Promise<void>((resolve, reject) => {
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    // Pass the already-open staging inode into xattr as fd 3. A page or another
    // process replacing the staging pathname cannot redirect quarantine metadata
    // to a different file while Kai still holds this descriptor.
    const child = spawn('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, '/dev/fd/3'], {
      stdio: ['ignore', 'ignore', 'pipe', handle.fd],
      timeout: 5_000,
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= MAX_XATTR_ERROR_BYTES) return;
      stderr = Buffer.concat([stderr, chunk.subarray(0, MAX_XATTR_ERROR_BYTES - stderr.length)]);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.toString('utf8').trim();
      finish(
        new Error(
          detail ||
            `Could not apply macOS quarantine metadata (${signal ? `signal ${signal}` : `exit ${String(code)}`}).`,
        ),
      );
    });
  });
}

async function assertOpenFileOwnsPath(handle: FileHandle, path: string, label: string): Promise<void> {
  const [opened, named] = await Promise.all([handle.stat({ bigint: true }), fsPromises.lstat(path, { bigint: true })]);
  if (!opened.isFile() || !named.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
    throw new Error(`The assistant download ${label} changed while it was being exported.`);
  }
}

export async function exportAssistantDownloadFile(
  appHome: string,
  source: string,
  destination: string,
  options: AssistantDownloadExportOptions = {},
): Promise<void> {
  const openedSource = await openAssistantDownloadForExport(source);
  const exportId = safeDownloadId(options.exportId ?? randomUUID());
  const staged = assistantDownloadExportStagingPath(destination, exportId);
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    let stagedHandle: FileHandle | undefined;
    try {
      stagedHandle = await copyOpenedAssistantDownload(openedSource.handle, openedSource.size, staged);
      await assertOpenFileOwnsPath(stagedHandle, staged, 'staging file');
      await fsPromises.rename(staged, destination);
      await assertOpenFileOwnsPath(stagedHandle, destination, 'destination');
    } catch (error) {
      await fsPromises.rm(staged, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await stagedHandle?.close().catch(() => undefined);
      await openedSource.handle.close().catch(() => undefined);
    }
    return;
  }

  // copyFile() does not preserve extended attributes. Stage beside the chosen
  // destination, apply a fresh Gatekeeper quarantine attribute, and only then
  // atomically replace the selected path. A failed xattr operation therefore
  // cannot publish an unquarantined file or destroy an existing destination.
  const journalDirectory = assistantDownloadExportJournalDirectory(appHome);
  const journalPath = join(journalDirectory, `Kai-${safeDownloadId(exportId)}.json`);
  const journalRecord = JSON.stringify({ version: 1, exportId, destination, staged });
  let published = false;
  let stagedHandle: FileHandle | undefined;
  try {
    ensureExportJournalHierarchy(appHome);
    const journal = await fsPromises.open(
      journalPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await journal.writeFile(journalRecord, 'utf8');
      await journal.sync();
    } finally {
      await journal.close();
    }
    await syncDirectory(journalDirectory);
    stagedHandle = await copyOpenedAssistantDownload(openedSource.handle, openedSource.size, staged);
    await (options.writeMacOsQuarantineAttribute ?? writeMacOsQuarantineAttribute)(
      staged,
      macOsQuarantineValue(options.now ?? Date.now(), exportId),
      stagedHandle,
    );
    // The xattr is applied through the open descriptor. Sync that same inode and
    // prove its pathname still names it immediately before and after rename.
    // Together, those checks prevent a substituted unquarantined staging file
    // from being reported as a successful export.
    await stagedHandle.sync();
    await assertOpenFileOwnsPath(stagedHandle, staged, 'staging file');
    await fsPromises.rename(staged, destination);
    await assertOpenFileOwnsPath(stagedHandle, destination, 'destination');
    // rename is atomic but is not crash-durable until the containing directory
    // has been synced.
    await syncDirectory(dirname(destination));
    published = true;
  } catch (error) {
    if (!published) {
      await fsPromises.rm(staged, { force: true }).catch(() => undefined);
      await fsPromises.rm(journalPath, { force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await stagedHandle?.close().catch(() => undefined);
    await openedSource.handle.close().catch(() => undefined);
  }
  // rename() is the publication commit point. A journal deletion failure after
  // that point must not tell the caller that an already-visible, quarantined
  // destination failed to export. Leave the recovery record in place; startup
  // reconciliation safely observes the missing staging file and retries only
  // this cleanup without touching the published destination.
  const journalRemoved = await (
    options.removeExportJournal ?? ((path: string) => fsPromises.rm(path, { force: true }))
  )(journalPath)
    .then(() => true)
    .catch(() => false);
  if (journalRemoved) {
    // A crash may otherwise resurrect the journal entry. That is safe but
    // needlessly repeats recovery, so durably commit its deletion too. Failure
    // remains post-publication best effort for the same reason as rm above.
    await syncDirectory(journalDirectory).catch(() => undefined);
  }
}

/** Remove macOS export staging files recorded durably before copying began. A
 * journal can survive either side of the final rename; deleting a missing stage
 * is therefore expected and never removes the successfully published file. */
export async function reconcileAssistantDownloadExportJournal(appHome: string): Promise<string[]> {
  const journalDirectory = assistantDownloadExportJournalDirectory(appHome);
  try {
    if (!verifyOwnedDirectory(join(appHome, 'browser')) || !verifyOwnedDirectory(journalDirectory)) return [];
  } catch (error) {
    throw new Error('The assistant download export journal is unsafe.', { cause: error });
  }
  const removed: string[] = [];
  let journalDirectoryChanged = false;
  for (const entry of await fsPromises.readdir(journalDirectory, { withFileTypes: true })) {
    const match = EXPORT_JOURNAL_FILENAME.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    const journalPath = join(journalDirectory, entry.name);
    const journalStats = await fsPromises.lstat(journalPath);
    if (!journalStats.isFile() || journalStats.size > MAX_EXPORT_JOURNAL_BYTES) {
      await removeFileIfPresent(journalPath);
      journalDirectoryChanged = true;
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(await fsPromises.readFile(journalPath, 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) {
        await removeFileIfPresent(journalPath);
        journalDirectoryChanged = true;
        continue;
      }
      throw new Error('The assistant download export journal contains unreadable recovery data.', { cause: error });
    }
    if (!record || typeof record !== 'object') {
      await removeFileIfPresent(journalPath);
      journalDirectoryChanged = true;
      continue;
    }
    const candidate = record as Record<string, unknown>;
    const exportId = safeDownloadId(match[1]);
    if (
      candidate.version !== 1 ||
      candidate.exportId !== exportId ||
      typeof candidate.destination !== 'string' ||
      typeof candidate.staged !== 'string' ||
      !isAbsolute(candidate.destination) ||
      !isAbsolute(candidate.staged)
    ) {
      await removeFileIfPresent(journalPath);
      journalDirectoryChanged = true;
      continue;
    }
    const expectedStage = assistantDownloadExportStagingPath(candidate.destination, exportId);
    if (resolve(candidate.staged) !== resolve(expectedStage)) {
      await removeFileIfPresent(journalPath);
      journalDirectoryChanged = true;
      continue;
    }
    let stagedWasMissing = false;
    try {
      const stagedStats = await fsPromises.lstat(expectedStage);
      if (stagedStats.isDirectory()) {
        throw new Error('The assistant download export staging path is an unexpected directory.');
      }
      await fsPromises.unlink(expectedStage);
      removed.push(expectedStage);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      stagedWasMissing = true;
    }
    // A missing stage can mean the crash happened after rename but before the
    // destination-directory durability barrier. Repeating that barrier is
    // harmless when the destination was later removed and closes that window
    // before retiring the recovery record.
    if (stagedWasMissing) await syncDirectory(dirname(candidate.destination));
    await fsPromises.unlink(journalPath);
    journalDirectoryChanged = true;
  }
  if (journalDirectoryChanged) await syncDirectory(journalDirectory);
  return removed;
}

/** Validate persisted shelf metadata against the app-owned quarantine without
 * following symlinks. */
export function isAssistantDownloadQuarantineFileAvailable(
  appHome: string,
  scopeKey: string,
  id: string,
  candidate: string,
): boolean {
  if (!isAssistantDownloadQuarantinePath(appHome, scopeKey, id, candidate)) return false;
  try {
    if (!verifyQuarantineHierarchy(appHome, scopeKey)) return false;
    const stats = lstatSync(candidate);
    return stats.isFile() && stats.size <= MAX_ASSISTANT_DOWNLOAD_BYTES;
  } catch {
    return false;
  }
}

export function removeAssistantDownloadFile(path: string): void {
  const finalPath = path.endsWith('.crdownload') ? path.slice(0, -'.crdownload'.length) : path;
  removeFile(finalPath);
  removeFile(`${finalPath}.crdownload`);
}

export function removeAssistantDownloadQuarantineForScope(appHome: string, scopeKey: string): void {
  const directory = assistantDownloadQuarantineDirectory(appHome, scopeKey);
  if (!verifyQuarantineHierarchy(appHome)) return;
  try {
    const stats = lstatSync(directory);
    if (!stats.isDirectory()) {
      // A valid scope name may contain crash-left metadata or a hostile symlink.
      // Remove only that directory entry and never follow it.
      unlinkSync(directory);
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  rmSync(directory, { recursive: true, force: true, maxRetries: 2 });
}

/** Enumerate every profile with quarantine state, including an empty directory
 * created immediately before a crash and a non-directory entry planted at a
 * valid owned name. Callers can then expose/clear that state without relying on
 * download shelf metadata having been persisted first. */
export function listAssistantDownloadQuarantineScopeKeys(appHome: string): string[] {
  const root = assistantDownloadQuarantineRoot(appHome);
  if (!verifyQuarantineHierarchy(appHome)) return [];
  try {
    return [
      ...new Set(
        readdirSync(root, { withFileTypes: true })
          .map((entry) => entry.name)
          .filter((scopeKey) => QUARANTINE_SCOPE_KEY.test(scopeKey)),
      ),
    ];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function pruneAllAssistantDownloadQuarantines(
  appHome: string,
  protectedPathsForScope: (scopeKey: string) => ReadonlySet<string> = () => new Set(),
): PrunedAssistantDownloadScope[] {
  const root = assistantDownloadQuarantineRoot(appHome);
  if (!verifyQuarantineHierarchy(appHome)) return [];
  const scopes: PrunedAssistantDownloadScope[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !QUARANTINE_SCOPE_KEY.test(entry.name)) continue;
    const downloads = pruneAssistantDownloadQuarantine(appHome, entry.name, protectedPathsForScope(entry.name));
    if (downloads.length > 0) scopes.push({ scopeKey: entry.name, downloads });
  }
  return scopes;
}

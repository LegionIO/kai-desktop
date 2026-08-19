import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';

export type PluginBrowserWindowHandle = {
  isDestroyed: () => boolean;
  destroy: () => void;
};

const trackedPluginBrowserWindows = new Map<PluginBrowserWindowHandle, string>();
const clearingPluginBrowserPartitions = new Map<string, number>();
const activePluginBrowserPartitionOperations = new Map<string, number>();
const pluginBrowserPartitionOperationWaiters = new Map<string, Set<() => void>>();
const quarantinedPluginBrowserPartitions = new Set<string>();
let pluginBrowserQuarantineAppHome: string | null = null;
const QUARANTINE_MARKER_RE = /^([a-f0-9]{64})\.pending$/;
const MAX_QUARANTINE_MARKER_BYTES = 16 * 1024;
const MAX_PLUGIN_PARTITION_NAME_CHARS = 4 * 1024;

export type PluginBrowserQuarantineSummary = {
  partitionNames: string[];
  corruptMarkerCount: number;
  directoryUnreadable: boolean;
};

function storageNameForRuntimePartition(partition: string): string {
  return partition.startsWith('persist:') ? partition.slice('persist:'.length) : partition;
}

/** Electron reserves the `persist:` runtime prefix. A storage directory whose
 * literal name starts with that prefix therefore has no same-named in-memory
 * runtime: `persist:foo` is the persistent runtime for directory `foo`, while
 * directory `persist:foo` is opened as `persist:persist:foo`. */
export function pluginBrowserRuntimePartitionsForStorageName(partitionName: string): string[] {
  const persistentPartition = `persist:${partitionName}`;
  return partitionName.startsWith('persist:') ? [persistentPartition] : [persistentPartition, partitionName];
}

function quarantineMarkerDirectory(appHome: string): string {
  return join(appHome, 'browser', 'pending-plugin-partition-cleanup');
}

function quarantineMarkerPath(appHome: string, partitionName: string): string {
  const digest = createHash('sha256').update(partitionName, 'utf8').digest('hex');
  return join(quarantineMarkerDirectory(appHome), `${digest}.pending`);
}

function validPluginPartitionStorageName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PLUGIN_PARTITION_NAME_CHARS &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('..') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

function quarantineMarkerPayload(partitionName: string): string {
  if (!validPluginPartitionStorageName(partitionName)) {
    throw new Error('Invalid plugin browser partition name.');
  }
  return JSON.stringify({ version: 1, partitionName });
}

function readQuarantineMarker(directory: string, entry: Dirent): string {
  const match = QUARANTINE_MARKER_RE.exec(entry.name);
  if (!match || !entry.isFile()) throw new Error('Invalid plugin browser cleanup marker.');
  const markerPath = join(directory, entry.name);
  const size = statSync(markerPath).size;
  if (size <= 0 || size > MAX_QUARANTINE_MARKER_BYTES) {
    throw new Error('Invalid plugin browser cleanup marker.');
  }
  const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as {
    version?: unknown;
    partitionName?: unknown;
  };
  if (
    parsed.version !== 1 ||
    !validPluginPartitionStorageName(parsed.partitionName) ||
    createHash('sha256').update(parsed.partitionName, 'utf8').digest('hex') !== match[1]
  ) {
    throw new Error('Invalid plugin browser cleanup marker.');
  }
  return parsed.partitionName;
}

/** Enumerate durable cleanup fences independently of Chromium's Partitions
 * directory. A crash can occur after that directory was deleted but before the
 * marker commit, and Settings must still be able to offer a retry. Marker names
 * remain hashed; the bounded payload is accepted only when its digest matches.
 * A corrupt marker is reported separately instead of hiding every valid row. */
export function inspectQuarantinedPluginBrowserPartitions(): PluginBrowserQuarantineSummary {
  if (!pluginBrowserQuarantineAppHome) {
    return { partitionNames: [], corruptMarkerCount: 0, directoryUnreadable: false };
  }
  const directory = quarantineMarkerDirectory(pluginBrowserQuarantineAppHome);
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { partitionNames: [], corruptMarkerCount: 0, directoryUnreadable: false };
    }
    return { partitionNames: [], corruptMarkerCount: 0, directoryUnreadable: true };
  }
  const names = new Set<string>();
  let corruptMarkerCount = 0;
  for (const entry of entries) {
    if (!QUARANTINE_MARKER_RE.test(entry.name)) continue;
    try {
      names.add(readQuarantineMarker(directory, entry));
    } catch {
      corruptMarkerCount += 1;
    }
  }
  return { partitionNames: [...names], corruptMarkerCount, directoryUnreadable: false };
}

export function listQuarantinedPluginBrowserPartitionNames(): string[] {
  return inspectQuarantinedPluginBrowserPartitions().partitionNames;
}

/** Remove only markers that remain invalid at recovery commit time. Callers
 * first clear every known plugin Browser profile under a global recovery
 * request; valid markers are deliberately retained for their normal retry. */
export function clearCorruptPluginBrowserQuarantineMarkers(): number {
  if (!pluginBrowserQuarantineAppHome) return 0;
  const directory = quarantineMarkerDirectory(pluginBrowserQuarantineAppHome);
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let cleared = 0;
  for (const entry of entries) {
    if (!QUARANTINE_MARKER_RE.test(entry.name)) continue;
    try {
      readQuarantineMarker(directory, entry);
    } catch {
      rmSync(join(directory, entry.name), { recursive: true, force: true });
      cleared += 1;
    }
  }
  return cleared;
}

/** Profiles with a live window/operation may not yet have an on-disk directory.
 * Include them in recover-all so their renderers and Sessions are fenced too. */
export function listKnownPluginBrowserPartitionNames(): string[] {
  const names = new Set<string>([
    ...quarantinedPluginBrowserPartitions,
    ...clearingPluginBrowserPartitions.keys(),
    ...activePluginBrowserPartitionOperations.keys(),
  ]);
  for (const partition of trackedPluginBrowserWindows.values()) names.add(storageNameForRuntimePartition(partition));
  return [...names];
}

function durableQuarantineExists(partitionName: string): boolean {
  if (!pluginBrowserQuarantineAppHome) return false;
  try {
    // lstat keeps even a broken/replaced symlink fail-closed as an extant marker.
    lstatSync(quarantineMarkerPath(pluginBrowserQuarantineAppHome, partitionName));
    return true;
  } catch (error) {
    // Metadata errors other than an absent marker are fail-closed: a profile
    // whose recovery state cannot be read must not regain a live renderer.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function persistQuarantine(partitionName: string): void {
  if (!pluginBrowserQuarantineAppHome) return;
  mkdirSync(quarantineMarkerDirectory(pluginBrowserQuarantineAppHome), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(
    quarantineMarkerPath(pluginBrowserQuarantineAppHome, partitionName),
    quarantineMarkerPayload(partitionName),
    { mode: 0o600 },
  );
}

function clearPersistedQuarantine(partitionName: string): void {
  if (!pluginBrowserQuarantineAppHome) return;
  rmSync(quarantineMarkerPath(pluginBrowserQuarantineAppHome, partitionName), { force: true });
}

/** Configure the durable fail-closed fence before any plugin BrowserWindow can
 * open. Calling this again with no live/clearing windows models a new process:
 * volatile state is reset, while marker files remain authoritative. */
export function initializePluginBrowserPartitionLifecycle(appHome: string): void {
  if (
    trackedPluginBrowserWindows.size > 0 ||
    clearingPluginBrowserPartitions.size > 0 ||
    activePluginBrowserPartitionOperations.size > 0
  ) {
    throw new Error('Plugin browser partition lifecycle cannot be reinitialized while windows or clears are active.');
  }
  pluginBrowserQuarantineAppHome = appHome;
  quarantinedPluginBrowserPartitions.clear();
}

function pluginBrowserPartitionUnavailableMessage(partition: string): string | null {
  // Callers pass Electron runtime partition ids here. Persistent ids carry one
  // synthetic `persist:` prefix that is not part of the on-disk directory
  // name, even when the directory name itself also starts with `persist:`.
  const clearName = storageNameForRuntimePartition(partition);
  if ((clearingPluginBrowserPartitions.get(clearName) ?? 0) > 0) {
    return `Plugin browser partition "${clearName}" is currently being cleared.`;
  }
  if (quarantinedPluginBrowserPartitions.has(clearName) || durableQuarantineExists(clearName)) {
    return `Plugin browser partition "${clearName}" remains quarantined after an incomplete clear.`;
  }
  return null;
}

/** Preflight before session.fromPartition/BrowserWindow construction so a
 * restart-persisted quarantine cannot even revive background session state. */
export function assertPluginBrowserPartitionAvailable(partition: string): void {
  const unavailable = pluginBrowserPartitionUnavailableMessage(partition);
  if (unavailable) throw new Error(unavailable);
}

/** Acquire a synchronous lease before constructing or mutating a plugin
 * Session. A Browser Data clear installs its creation fence first, then waits
 * for leases that started earlier to drain before touching Chromium state. */
export function beginPluginBrowserPartitionOperation(partition: string): () => void {
  assertPluginBrowserPartitionAvailable(partition);
  const clearName = storageNameForRuntimePartition(partition);
  activePluginBrowserPartitionOperations.set(
    clearName,
    (activePluginBrowserPartitionOperations.get(clearName) ?? 0) + 1,
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activePluginBrowserPartitionOperations.get(clearName) ?? 1) - 1;
    if (remaining > 0) {
      activePluginBrowserPartitionOperations.set(clearName, remaining);
      return;
    }
    activePluginBrowserPartitionOperations.delete(clearName);
    const waiters = pluginBrowserPartitionOperationWaiters.get(clearName);
    pluginBrowserPartitionOperationWaiters.delete(clearName);
    for (const resolve of waiters ?? []) resolve();
  };
}

/** Wait only after beginPluginBrowserPartitionClear has installed its fence;
 * otherwise a new operation could enter between this check and the clear. */
export async function waitForPluginBrowserPartitionOperations(partitionNames: readonly string[]): Promise<void> {
  await Promise.all(
    [...new Set(partitionNames)].map((clearName) => {
      if ((activePluginBrowserPartitionOperations.get(clearName) ?? 0) === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const waiters = pluginBrowserPartitionOperationWaiters.get(clearName) ?? new Set<() => void>();
        waiters.add(resolve);
        pluginBrowserPartitionOperationWaiters.set(clearName, waiters);
      });
    }),
  );
}

/** Track the Chromium profile owned by a plugin BrowserWindow so Browser Data
 * clearing can tear down every live renderer before mutating that profile. */
export function trackPluginBrowserWindow(window: PluginBrowserWindowHandle, partition: string): () => void {
  const unavailable = pluginBrowserPartitionUnavailableMessage(partition);
  if (unavailable) {
    try {
      if (!window.isDestroyed()) window.destroy();
    } catch (error) {
      throw new AggregateError([error], 'A plugin browser window opened during profile clearing and could not close.');
    }
    throw new Error(unavailable);
  }
  trackedPluginBrowserWindows.set(window, partition);
  return () => trackedPluginBrowserWindows.delete(window);
}

function partitionMatchesClearName(partition: string, clearName: string): boolean {
  return pluginBrowserRuntimePartitionsForStorageName(clearName).includes(partition);
}

/** Destroy matching plugin renderers synchronously before their Session is
 * cleared. A surviving page could otherwise rewrite cookies/storage while the
 * asynchronous Chromium clear operations are running. */
export function destroyPluginBrowserWindowsForPartitions(partitionNames: readonly string[]): number {
  if (partitionNames.length === 0) return 0;
  const failures: unknown[] = [];
  let destroyed = 0;
  for (const [window, partition] of [...trackedPluginBrowserWindows]) {
    if (!partitionNames.some((name) => partitionMatchesClearName(partition, name))) continue;
    try {
      if (window.isDestroyed()) {
        trackedPluginBrowserWindows.delete(window);
        continue;
      }
      window.destroy();
      trackedPluginBrowserWindows.delete(window);
      destroyed += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more live plugin browser windows could not be closed.');
  }
  return destroyed;
}

/** Hold a partition-level creation fence for the complete asynchronous clear.
 * Existing windows are destroyed after the fence is installed; a plugin racing
 * a new BrowserWindow into the clear is synchronously destroyed by track(). */
export function beginPluginBrowserPartitionClear(partitionNames: readonly string[]): () => void {
  // These are Chromium Partitions directory names, not Electron runtime ids.
  // Preserve them exactly: directory `persist:foo` is opened at runtime as
  // `persist:persist:foo`.
  const clearNames = [...new Set(partitionNames)];
  for (const clearName of clearNames) {
    quarantinedPluginBrowserPartitions.add(clearName);
    clearingPluginBrowserPartitions.set(clearName, (clearingPluginBrowserPartitions.get(clearName) ?? 0) + 1);
  }
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    for (const clearName of clearNames) {
      const remaining = (clearingPluginBrowserPartitions.get(clearName) ?? 1) - 1;
      if (remaining > 0) clearingPluginBrowserPartitions.set(clearName, remaining);
      else clearingPluginBrowserPartitions.delete(clearName);
    }
  };
  try {
    // Persist before quiescing Chromium. A crash, force-quit, or failed clear
    // must retain the creation fence across the next app launch.
    for (const clearName of clearNames) persistQuarantine(clearName);
    destroyPluginBrowserWindowsForPartitions(clearNames);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

/** Mark a partition clear as fully committed. The quarantine is retained while
 * any overlapping clear is still running: a later overlapping failure must not
 * inherit an earlier caller's success and reopen a profile in an unknown state. */
export function completePluginBrowserPartitionClear(partitionName: string): void {
  const clearName = partitionName;
  if ((clearingPluginBrowserPartitions.get(clearName) ?? 0) <= 1) {
    // Removing the durable marker is the commit point. If it fails, throw while
    // both the marker and in-memory quarantine still block renderer creation.
    clearPersistedQuarantine(clearName);
    quarantinedPluginBrowserPartitions.delete(clearName);
  }
}

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  statSync,
  type BigIntStats,
} from 'node:fs';
import { join, relative } from 'node:path';
import type { PluginManifest, PluginPermission, ExecScopeDeclaration, AllowedBinary } from './types.js';

export type PluginIntegrity = {
  fileHash: string;
  permissions: PluginPermission[];
  version: string;
};

export type PluginDirectorySnapshot = {
  fileHash: string;
  files: ReadonlyMap<string, Uint8Array>;
};

export const MAX_PLUGIN_DIRECTORY_DEPTH = 32;
export const MAX_PLUGIN_DIRECTORY_ENTRIES = 10_000;
export const MAX_PLUGIN_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_PLUGIN_DIRECTORY_BYTES = 128 * 1024 * 1024;
export const MAX_PLUGIN_RENDERER_ASSET_BYTES = 16 * 1024 * 1024;
export const MAX_PLUGIN_RENDERER_BYTES = 32 * 1024 * 1024;

type PluginFile = {
  path: string;
  relativePath: string;
  size: number;
  identity: PluginPathIdentity;
};

type PluginPathIdentity = {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

export const AUTHENTICATED_BROWSER_PERMISSION: PluginPermission = 'browser:authenticated-session';

/** Frontend plugin modules execute in Kai's primary renderer. That renderer
 * owns the authenticated Browser bridge, so loading frontend.js is itself an
 * elevated capability even when the plugin never declares a browser API.
 * Keep this host-inferred consent marker outside readPluginManifest(): parsing
 * a manifest must never fabricate a capability that was not present on disk. */
export function effectivePluginPermissions(
  pluginDir: string,
  declared: readonly PluginPermission[],
): PluginPermission[] {
  const permissions = [...new Set(declared)];
  let hasFrontend = false;
  const frontendPath = join(pluginDir, 'frontend.js');
  try {
    const stats = lstatSync(frontendPath, { bigint: true });
    if (stats.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in plugin directories: ${frontendPath}`);
    }
    hasFrontend = stats.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (hasFrontend && !permissions.includes(AUTHENTICATED_BROWSER_PERMISSION)) {
    permissions.push(AUTHENTICATED_BROWSER_PERMISSION);
  }
  return permissions;
}

function shouldHashPluginFile(relativePath: string): boolean {
  return relativePath !== 'settings.json';
}

function pluginPathIdentity(stats: BigIntStats): PluginPathIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function samePluginPathIdentity(left: PluginPathIdentity, right: PluginPathIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function checkedPluginFile(
  path: string,
  stats: BigIntStats,
  maxBytes = MAX_PLUGIN_FILE_BYTES,
): {
  size: number;
  identity: PluginPathIdentity;
} {
  if (!stats.isFile()) throw new Error(`Plugin path is not a regular file: ${path}`);
  if (stats.size < 0n || stats.size > BigInt(maxBytes) || stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Plugin file exceeds the ${maxBytes} byte limit: ${path}`);
  }
  return { size: Number(stats.size), identity: pluginPathIdentity(stats) };
}

/** Open without following the final component, validate the already-open file,
 * and read at most its checked size from that same descriptor. Comparing both
 * ends of the read catches in-place mutation; comparing a collected identity
 * catches path or parent-directory replacement before any bytes are exposed. */
function readBoundedPluginFile(
  path: string,
  expectedIdentity?: PluginPathIdentity,
  maxBytes = MAX_PLUGIN_FILE_BYTES,
): Buffer {
  const collected = checkedPluginFile(path, lstatSync(path, { bigint: true }), maxBytes);
  if (expectedIdentity && !samePluginPathIdentity(expectedIdentity, collected.identity)) {
    throw new Error(`Plugin file changed while it was being validated: ${path}`);
  }

  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw new Error(`Plugin file could not be opened without following symbolic links: ${path}`, { cause: error });
  }
  try {
    const opened = checkedPluginFile(path, fstatSync(descriptor, { bigint: true }), maxBytes);
    if (!samePluginPathIdentity(collected.identity, opened.identity)) {
      throw new Error(`Plugin file changed while it was being opened: ${path}`);
    }
    const data = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < data.byteLength) {
      const bytesRead = readSync(descriptor, data, offset, data.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const overflowProbe = Buffer.allocUnsafe(1);
    const extraBytes = readSync(descriptor, overflowProbe, 0, 1, null);
    const completed = pluginPathIdentity(fstatSync(descriptor, { bigint: true }));
    if (offset !== data.byteLength || extraBytes !== 0 || !samePluginPathIdentity(opened.identity, completed)) {
      throw new Error(`Plugin file changed while it was being read: ${path}`);
    }
    return data;
  } finally {
    closeSync(descriptor);
  }
}

function collectPluginFiles(rootDir: string): PluginFile[] {
  const files: PluginFile[] = [];
  let entriesSeen = 0;
  let totalBytes = 0;
  const visit = (currentDir: string, depth: number): void => {
    if (depth > MAX_PLUGIN_DIRECTORY_DEPTH) {
      throw new Error(`Plugin directory exceeds the maximum depth of ${MAX_PLUGIN_DIRECTORY_DEPTH}.`);
    }
    const directoryStats = lstatSync(currentDir, { bigint: true });
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw new Error(`Plugin directory path is not a regular directory: ${currentDir}`);
    }
    const directoryIdentity = pluginPathIdentity(directoryStats);
    const directory = opendirSync(currentDir);
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        entriesSeen++;
        if (entriesSeen > MAX_PLUGIN_DIRECTORY_ENTRIES) {
          throw new Error(`Plugin directory exceeds the ${MAX_PLUGIN_DIRECTORY_ENTRIES} entry limit.`);
        }
        const fullPath = join(currentDir, entry.name);
        const stats = lstatSync(fullPath, { bigint: true });
        if (stats.isSymbolicLink()) {
          throw new Error(`Symbolic links are not allowed in plugin directories: ${fullPath}`);
        }
        if (stats.isDirectory()) {
          visit(fullPath, depth + 1);
          continue;
        }
        if (!stats.isFile()) continue;
        const { size, identity } = checkedPluginFile(fullPath, stats);
        totalBytes += size;
        if (totalBytes > MAX_PLUGIN_DIRECTORY_BYTES) {
          throw new Error(`Plugin directory exceeds the ${MAX_PLUGIN_DIRECTORY_BYTES} byte limit.`);
        }
        const relativePath = relative(rootDir, fullPath).replace(/\\/g, '/');
        if (shouldHashPluginFile(relativePath)) files.push({ path: fullPath, relativePath, size, identity });
      }
    } finally {
      directory.closeSync();
    }
    const completedDirectory = lstatSync(currentDir, { bigint: true });
    if (
      completedDirectory.isSymbolicLink() ||
      !completedDirectory.isDirectory() ||
      !samePluginPathIdentity(directoryIdentity, pluginPathIdentity(completedDirectory))
    ) {
      throw new Error(`Plugin directory changed while it was being validated: ${currentDir}`);
    }
  };
  visit(rootDir, 0);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function hashPluginFile(path: string): string {
  const data = readBoundedPluginFile(path);
  return createHash('sha256').update(data).digest('hex');
}

function digestPluginFiles(
  files: readonly PluginFile[],
  capture?: (relativePath: string, data: Uint8Array) => void,
): string {
  const hash = createHash('sha256');
  let actualBytes = 0;

  for (const file of files) {
    const data = readBoundedPluginFile(file.path, file.identity);
    actualBytes += data.byteLength;
    if (data.byteLength > MAX_PLUGIN_FILE_BYTES || actualBytes > MAX_PLUGIN_DIRECTORY_BYTES) {
      throw new Error('Plugin files changed while enforcing directory resource limits.');
    }
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(data);
    hash.update('\0');
    capture?.(file.relativePath, data);
  }

  return hash.digest('hex');
}

function shouldCaptureRendererAsset(relativePath: string): boolean {
  if (relativePath === 'plugin.json' || relativePath === 'backend.js') return false;
  // Plugin frontends historically could request any regular plugin-local file,
  // with unknown extensions served as application/octet-stream. Capture every
  // bounded asset (including extensionless data and node_modules dependencies)
  // so immutable serving preserves that contract without reopening live reads.
  return true;
}

export function snapshotPluginDirectory(
  dir: string,
  rendererEntryPath: string | null = 'frontend.js',
): PluginDirectorySnapshot {
  const files = collectPluginFiles(dir);
  const rendererFiles = new Set<string>();
  let rendererBytes = 0;
  // Backend-only plugins never expose plugin-local files to Kai's renderer.
  // Keep hashing the complete directory, but apply the tighter renderer
  // capture budget only when the caller's renderer entry point exists in the
  // approved directory snapshot. Production plugins use root frontend.js;
  // renderer-build callers may select another plugin-local entry point.
  if (rendererEntryPath !== null && files.some((file) => file.relativePath === rendererEntryPath)) {
    for (const file of files) {
      if (!shouldCaptureRendererAsset(file.relativePath)) continue;
      if (file.size > MAX_PLUGIN_RENDERER_ASSET_BYTES) {
        throw new Error(`Plugin renderer asset exceeds the ${MAX_PLUGIN_RENDERER_ASSET_BYTES} byte limit.`);
      }
      rendererBytes += file.size;
      if (rendererBytes > MAX_PLUGIN_RENDERER_BYTES) {
        throw new Error(`Plugin renderer assets exceed the ${MAX_PLUGIN_RENDERER_BYTES} byte limit.`);
      }
      rendererFiles.add(file.relativePath);
    }
  }
  const snapshot = new Map<string, Uint8Array>();
  let capturedBytes = 0;
  const fileHash = digestPluginFiles(files, (relativePath, data) => {
    if (!rendererFiles.has(relativePath)) return;
    capturedBytes += data.byteLength;
    if (data.byteLength > MAX_PLUGIN_RENDERER_ASSET_BYTES || capturedBytes > MAX_PLUGIN_RENDERER_BYTES) {
      throw new Error('Plugin renderer assets changed while enforcing resource limits.');
    }
    snapshot.set(relativePath, data);
  });
  return { fileHash, files: snapshot };
}

export function hashPluginDirectory(dir: string): string {
  // Hash-only callers can run while an approved renderer snapshot is already
  // resident. Stream one file at a time instead of allocating a second map of
  // every plugin byte and doubling peak startup memory.
  return digestPluginFiles(collectPluginFiles(dir));
}

export function readPluginManifest(pluginDir: string, fallbackName?: string): PluginManifest {
  const raw = JSON.parse(readBoundedPluginFile(join(pluginDir, 'plugin.json')).toString('utf-8')) as Record<
    string,
    unknown
  >;
  const name = typeof raw.name === 'string' ? raw.name : (fallbackName ?? '');

  return {
    name,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : name,
    version: typeof raw.version === 'string' ? raw.version : '0.0.0',
    description: typeof raw.description === 'string' ? raw.description : '',
    author: typeof raw.author === 'string' ? raw.author : undefined,
    icon:
      raw.icon && typeof raw.icon === 'object' && !Array.isArray(raw.icon)
        ? (raw.icon as { lucide: string } | { svg: string })
        : undefined,
    permissions: Array.isArray(raw.permissions)
      ? raw.permissions.filter((value): value is PluginPermission => typeof value === 'string')
      : [],
    configSchema:
      raw.configSchema && typeof raw.configSchema === 'object'
        ? (raw.configSchema as Record<string, unknown>)
        : undefined,
    execScope: parseExecScope(raw.execScope),
    engines: parseEngines(raw.engines),
    capabilities: Array.isArray(raw.capabilities)
      ? raw.capabilities.filter((v): v is string => typeof v === 'string')
      : undefined,
  };
}

export function getPluginIntegrity(pluginDir: string, fallbackName?: string): PluginIntegrity {
  const manifest = readPluginManifest(pluginDir, fallbackName);
  return {
    fileHash: hashPluginDirectory(pluginDir),
    permissions: effectivePluginPermissions(pluginDir, manifest.permissions),
    version: manifest.version,
  };
}

/**
 * Existence classification that distinguishes "genuinely absent" (ENOENT) from
 * "present but UNREADABLE" (transient EIO/EACCES/EMFILE/…). Plain `existsSync`
 * collapses BOTH to `false`, which on faithful-discovery / cleanup-protection paths
 * silently treats an unreadable directory as absent (R39P1/R40P1). Shared by the
 * plugin manager's discovery and the bundled-plugin bootstrap so both fail closed on
 * an unconfirmed path rather than proceeding as if it were missing.
 */
export function pathAvailability(p: string): 'present' | 'absent' | 'error' {
  try {
    statSync(p);
    return 'present';
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'error';
  }
}

/**
 * Transient filesystem errno set — failures a retry (next launch) can plausibly
 * clear, as opposed to a DETERMINISTIC content defect (malformed JSON, a size/name
 * limit) that will fail identically forever. Used to decide whether a manifest-read
 * failure should mark discovery INCOMPLETE (and thereby block app updates until a
 * clean launch): only transient failures should — a deterministic one must not wedge
 * updates with no recovery path (R40P1#structured). Checks the error AND its `cause`
 * because plugin-integrity wraps some low-level fs errors.
 */
const TRANSIENT_FS_CODES = new Set(['EIO', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE', 'EBUSY', 'EAGAIN', 'ETIMEDOUT']);
export function isTransientFsError(err: unknown): boolean {
  const codeOf = (e: unknown): string | undefined =>
    e && typeof e === 'object' ? (e as NodeJS.ErrnoException).code : undefined;
  if (codeOf(err) && TRANSIENT_FS_CODES.has(codeOf(err)!)) return true;
  const cause = err && typeof err === 'object' ? (err as { cause?: unknown }).cause : undefined;
  return !!codeOf(cause) && TRANSIENT_FS_CODES.has(codeOf(cause)!);
}

export function arePermissionSetsEqual(left: readonly string[] = [], right: readonly string[] = []): boolean {
  if (left.length !== right.length) return false;

  const leftSet = new Set(left);
  if (leftSet.size !== right.length) return false;

  for (const permission of right) {
    if (!leftSet.has(permission)) return false;
  }

  return true;
}

/** Match only the rollout migration where the host-inferred authenticated
 * Browser permission is the sole addition to a previously trusted snapshot. */
export function isLegacyInferredBrowserPermissionSnapshot(
  previous: readonly string[] | undefined,
  current: readonly string[],
): boolean {
  if (
    !previous ||
    previous.includes(AUTHENTICATED_BROWSER_PERMISSION) ||
    !current.includes(AUTHENTICATED_BROWSER_PERMISSION)
  ) {
    return false;
  }
  return arePermissionSetsEqual(
    previous,
    current.filter((permission) => permission !== AUTHENTICATED_BROWSER_PERMISSION),
  );
}

/** Legacy approvals predate permission snapshots. Preserve their compatibility
 * except when a plugin now acquires authenticated Browser access, which must
 * always be represented explicitly so the user sees a fresh consent prompt. */
export function approvalPermissionsMatch(approved: readonly string[] | undefined, current: readonly string[]): boolean {
  if (!approved) return !current.includes('browser:authenticated-session');
  return arePermissionSetsEqual(approved, current);
}

/**
 * Permission-match decision for the DEFERRED (owed-cleanup) integrity path.
 *
 * A deferred required plugin's OLD on-disk generation is trusted against its
 * PREVIOUSLY-PERSISTED record (hash+version already verified by the caller) rather
 * than the newer catalog/bundle. Beyond an exact permission match we also accept the
 * single rollout migration where the persisted snapshot predates the host-inferred
 * authenticated-Browser permission and the manifest adds exactly that one permission
 * (R31P2). Rejecting that delta would leave the owed plugin unloadable — its cleanup
 * hook never registers, installs stay blocked, and the debt is discarded at the
 * give-up cap. Because the sole added permission IS the authenticated-Browser one,
 * the caller's `ensurePluginApproved` still gates activation behind a fresh consent
 * prompt, so this tolerance never bypasses consent.
 *
 * `base` selects the non-legacy comparison: marketplace records use exact set equality
 * (`exact`), bundled approvals use `approvalPermissionsMatch` (`approval`).
 */
export function deferredPermissionsTrusted(
  persisted: readonly string[] | undefined,
  manifest: readonly string[],
  base: 'exact' | 'approval',
): boolean {
  const baseOk =
    base === 'exact'
      ? !!persisted && arePermissionSetsEqual(persisted, manifest)
      : approvalPermissionsMatch(persisted, manifest);
  if (baseOk) return true;
  return isLegacyInferredBrowserPermissionSnapshot(persisted, manifest);
}

// ─── Scope Parsing Helpers ──────────────────────────────────────────────────

function parseEngines(raw: unknown): { kai?: string } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const kai = typeof obj.kai === 'string' ? obj.kai : undefined;
  if (!kai) return undefined;
  return { kai };
}

const VALID_ALLOWED_BINARIES = new Set<string>([
  'claude',
  'codex',
  'node',
  'npm',
  'pip',
  'pip3',
  'python',
  'python3',
  'git',
  'bash',
]);

function parseExecScope(raw: unknown): ExecScopeDeclaration | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;

  const binaries = Array.isArray(obj.binaries)
    ? obj.binaries.filter((b): b is AllowedBinary => typeof b === 'string' && VALID_ALLOWED_BINARIES.has(b))
    : [];

  if (binaries.length === 0) return undefined;

  let argPatterns: Record<string, string[]> | undefined;
  if (obj.argPatterns && typeof obj.argPatterns === 'object' && !Array.isArray(obj.argPatterns)) {
    argPatterns = {};
    for (const [key, value] of Object.entries(obj.argPatterns as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        const patterns = value.filter((v): v is string => typeof v === 'string');
        if (patterns.length > 0) {
          argPatterns[key] = patterns;
        }
      }
    }
    if (Object.keys(argPatterns).length === 0) argPatterns = undefined;
  }

  return { binaries, argPatterns };
}

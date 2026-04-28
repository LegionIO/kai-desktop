import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import type { PluginManifest, PluginPermission, FsScopeDeclaration, ExecScopeDeclaration, ScopedDirectory, AllowedBinary } from './types.js';

export type PluginIntegrity = {
  fileHash: string;
  permissions: PluginPermission[];
  version: string;
};

function shouldHashPluginFile(relativePath: string): boolean {
  return relativePath !== 'settings.json';
}

function collectPluginFiles(rootDir: string, currentDir = rootDir): string[] {
  const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a: Dirent, b: Dirent) => a.name.localeCompare(b.name));
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectPluginFiles(rootDir, fullPath));
      continue;
    }
    if (entry.isFile()) {
      const relativePath = relative(rootDir, fullPath).replace(/\\/g, '/');
      if (shouldHashPluginFile(relativePath)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

export function hashPluginDirectory(dir: string): string {
  const hash = createHash('sha256');
  const files = collectPluginFiles(dir);

  for (const filePath of files) {
    const relativePath = relative(dir, filePath).replace(/\\/g, '/');
    hash.update(relativePath);
    hash.update('\0');
    hash.update(readFileSync(filePath));
    hash.update('\0');
  }

  return hash.digest('hex');
}

export function readPluginManifest(pluginDir: string, fallbackName?: string): PluginManifest {
  const raw = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf-8')) as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name : fallbackName ?? '';

  return {
    name,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : name,
    version: typeof raw.version === 'string' ? raw.version : '0.0.0',
    description: typeof raw.description === 'string' ? raw.description : '',
    author: typeof raw.author === 'string' ? raw.author : undefined,
    icon: raw.icon && typeof raw.icon === 'object' && !Array.isArray(raw.icon)
      ? raw.icon as { lucide: string } | { svg: string }
      : undefined,
    permissions: Array.isArray(raw.permissions)
      ? raw.permissions.filter((value): value is PluginPermission => typeof value === 'string')
      : [],
    configSchema: raw.configSchema && typeof raw.configSchema === 'object'
      ? raw.configSchema as Record<string, unknown>
      : undefined,
    fsScope: parseFsScope(raw.fsScope),
    execScope: parseExecScope(raw.execScope),
  };
}

export function getPluginIntegrity(pluginDir: string, fallbackName?: string): PluginIntegrity {
  const manifest = readPluginManifest(pluginDir, fallbackName);
  return {
    fileHash: hashPluginDirectory(pluginDir),
    permissions: manifest.permissions,
    version: manifest.version,
  };
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

// ─── Scope Parsing Helpers ──────────────────────────────────────────────────

const VALID_SCOPED_DIRECTORIES = new Set<string>([
  'claude-home', 'codex-home', 'plugin-own', 'kai-home', 'otc-repo',
]);

const VALID_FS_OPERATIONS = new Set<string>([
  'read', 'write', 'mkdir', 'exists', 'readdir', 'remove',
]);

const VALID_ALLOWED_BINARIES = new Set<string>([
  'claude', 'codex', 'node', 'npm', 'pip', 'pip3', 'python', 'python3', 'git', 'bash',
]);

function parseFsScope(raw: unknown): FsScopeDeclaration | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;

  const directories = Array.isArray(obj.directories)
    ? obj.directories.filter((d): d is ScopedDirectory => typeof d === 'string' && VALID_SCOPED_DIRECTORIES.has(d))
    : [];

  const operations = Array.isArray(obj.operations)
    ? obj.operations.filter((o): o is FsScopeDeclaration['operations'][number] => typeof o === 'string' && VALID_FS_OPERATIONS.has(o))
    : [];

  if (directories.length === 0 || operations.length === 0) return undefined;

  return { directories, operations };
}

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

import { accessSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { constants } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { PluginHostRuntime } from './plugin-process-host.js';
import type { PluginManifest } from '../types.js';

const MAX_FILES = 50_000;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx']);
const ELECTRON_DEPENDENCY =
  /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:node:)?electron(?:\/[^'"]*)?['"]|process\.(?:versions\.electron|type)\b/;
const ZOD_DEPENDENCY = /(?:from\s*|import\s*\(|require\s*\()\s*['"]zod(?:\/[^'"]*)?['"]/;
const UTILITY_MEMORY_PERMISSIONS = new Set<PluginManifest['permissions'][number]>([
  'safe-storage',
  'conversations:read',
  'conversations:write',
  'system:env',
  'agent:inference-provider',
]);

export type PluginRuntimeSelection = {
  runtime: PluginHostRuntime;
  seaHostPath?: string;
  reason: string;
};

function executableName(): string {
  return process.platform === 'win32' ? 'kai-plugin-host.exe' : 'kai-plugin-host';
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve the signed packaged host, or an explicit development/test host. */
export function resolveSeaHostExecutable(): string | null {
  const explicit = process.env.KAI_PLUGIN_SEA_HOST?.trim();
  const platformArch = `${process.platform}-${process.arch}`;
  const name = executableName();
  const candidates = [
    ...(explicit ? [resolve(explicit)] : []),
    ...(process.resourcesPath ? [join(process.resourcesPath, 'plugin-host', platformArch, name)] : []),
    join(process.cwd(), 'resources', 'plugin-host', platformArch, name),
    join(import.meta.dirname, '..', '..', '..', 'resources', 'plugin-host', platformArch, name),
  ];
  return candidates.find(isExecutable) ?? null;
}

type Compatibility = { compatible: true; usesZod: boolean } | { compatible: false; reason: string };

function packageUsesZod(manifest: Record<string, unknown>): boolean {
  return ['dependencies', 'optionalDependencies', 'peerDependencies'].some((field) => {
    const dependencies = manifest[field];
    return !!dependencies && typeof dependencies === 'object' && 'zod' in dependencies;
  });
}

/**
 * Conservatively classify a plugin before activation. A false negative only
 * costs a few MB by retaining the Electron utility fallback; a false positive
 * could break a plugin after side effects have begun, so limits/errors route to
 * Electron and fallback is never attempted after activation starts.
 */
export function inspectSeaCompatibility(pluginDir: string, backendPath: string): Compatibility {
  let files = 0;
  let sourceBytes = 0;
  const visitedDirectories = new Set<string>();
  const stack = [pluginDir];
  let backendInspected = false;
  let usesZod = false;
  const rootPackagePath = resolve(pluginDir, 'package.json');
  const dependencySegment = `${sep}node_modules${sep}`;

  try {
    while (stack.length > 0) {
      const directory = stack.pop()!;
      const realDirectory = realpathSync(directory);
      if (visitedDirectories.has(realDirectory)) continue;
      visitedDirectories.add(realDirectory);

      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        files += 1;
        if (files > MAX_FILES)
          return { compatible: false, reason: 'plugin tree exceeded the compatibility scan limit' };
        const path = join(directory, entry.name);
        const extension = extname(entry.name).toLowerCase();
        if (extension === '.node') return { compatible: false, reason: `native addon detected (${entry.name})` };

        const metadata = entry.isSymbolicLink() ? lstatSync(path) : null;
        if (entry.isDirectory()) {
          stack.push(path);
          continue;
        }
        if (metadata?.isSymbolicLink()) {
          const target = statSync(path);
          if (target.isDirectory()) stack.push(path);
          else if (extname(realpathSync(path)).toLowerCase() === '.node') {
            return { compatible: false, reason: `native addon symlink detected (${entry.name})` };
          }
        }

        if (entry.name === 'package.json') {
          const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
          if (manifest.gypfile === true || (manifest.binary && typeof manifest.binary === 'object')) {
            return { compatible: false, reason: `native package metadata detected (${path})` };
          }
          if (resolve(path) === rootPackagePath && packageUsesZod(manifest)) usesZod = true;
        }
        if (!SOURCE_EXTENSIONS.has(extension)) continue;
        const size = statSync(path).size;
        sourceBytes += size;
        if (sourceBytes > MAX_SOURCE_BYTES) {
          return { compatible: false, reason: 'plugin sources exceeded the compatibility scan limit' };
        }
        const source = readFileSync(path, 'utf8');
        if (resolve(path) === resolve(backendPath)) backendInspected = true;
        if (ELECTRON_DEPENDENCY.test(source)) {
          return { compatible: false, reason: `direct Electron dependency detected (${entry.name})` };
        }
        if (!resolve(path).includes(dependencySegment) && ZOD_DEPENDENCY.test(source)) usesZod = true;
      }
    }
  } catch (error) {
    return {
      compatible: false,
      reason: `compatibility scan failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!backendInspected) return { compatible: false, reason: 'plugin backend was outside the scanned plugin tree' };
  return { compatible: true, usesZod };
}

export function selectPluginHostRuntime(
  manifest: PluginManifest,
  pluginDir: string,
  backendPath: string,
): PluginRuntimeSelection {
  const override = process.env.KAI_PLUGIN_HOST_RUNTIME?.trim().toLowerCase();
  if (override === 'electron') {
    return { runtime: 'electron-utility', reason: 'Electron runtime forced by KAI_PLUGIN_HOST_RUNTIME' };
  }

  const seaHostPath = resolveSeaHostExecutable();
  if (!seaHostPath) {
    return { runtime: 'electron-utility', reason: 'signed Node SEA host is unavailable' };
  }
  if (override === 'sea') {
    return { runtime: 'node-sea', seaHostPath, reason: 'Node SEA runtime forced by KAI_PLUGIN_HOST_RUNTIME' };
  }

  const expensivePermission = manifest.permissions.find((permission) => UTILITY_MEMORY_PERMISSIONS.has(permission));
  if (expensivePermission) {
    return {
      runtime: 'electron-utility',
      reason: `Electron host has the lower measured footprint for ${expensivePermission} compatibility`,
    };
  }

  const compatibility = inspectSeaCompatibility(pluginDir, backendPath);
  if (!compatibility.compatible) {
    return { runtime: 'electron-utility', reason: compatibility.reason };
  }
  if (manifest.permissions.includes('tools:register') && compatibility.usesZod) {
    return {
      runtime: 'electron-utility',
      reason: 'Electron host has the lower measured footprint for Zod-backed tool compatibility',
    };
  }
  return { runtime: 'node-sea', seaHostPath, reason: 'pure JavaScript plugin passed SEA compatibility preflight' };
}

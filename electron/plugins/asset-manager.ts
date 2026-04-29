/**
 * Plugin Asset Manager — platform-level installation/uninstallation of plugin
 * assets into external tool directories (~/.claude/, ~/.codex/, etc.).
 *
 * Plugins declare asset mappings in plugin.json:
 *   "assets": { "mappings": [{ "src": "assets/commands", "target": { "scope": "claude-home", "path": "commands" } }] }
 *
 * The platform copies files on plugin load, tracks what was installed via a
 * manifest, and removes only plugin-installed (unmodified) files on uninstall.
 */

import { createHash } from 'crypto';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
  statSync,
} from 'fs';
import { join } from 'path';

import { resolveScopeDirectory } from './sandboxed-exec.js';
import type { PluginManifest, AssetMapping } from './types.js';

// ---------------------------------------------------------------------------
// Manifest Types
// ---------------------------------------------------------------------------

type AssetManifestEntry = {
  /** Relative source path within the plugin dir */
  source: string;
  /** Absolute target path on disk */
  target: string;
  /** SHA-256 hash prefixed with "sha256:" for tamper detection */
  hash: string;
};

type AssetManifest = {
  pluginName: string;
  pluginVersion: string;
  installedAt: string;
  files: AssetManifestEntry[];
};

const MANIFEST_FILENAME = '.kai-asset-manifest.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/**
 * Test whether a filename matches any of the include patterns.
 * Each pattern is treated as a regex (anchored to the full filename).
 */
function matchesInclude(filename: string, include?: string[]): boolean {
  if (!include || include.length === 0) return true;
  return include.some((pattern) => {
    try {
      return new RegExp(pattern).test(filename);
    } catch {
      // If the pattern is invalid regex, treat as literal substring match
      return filename.includes(pattern);
    }
  });
}

/**
 * Recursively list all files in a directory (non-recursive — single level).
 * Skips directories and dotfiles.
 */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => {
    if (f.startsWith('.')) return false;
    try {
      return statSync(join(dir, f)).isFile();
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Install plugin assets declared in manifest.assets into their target
 * scope directories. Returns the number of files installed.
 *
 * - Skips files that already exist at the target (unless overwrite is set)
 * - Writes a manifest to the plugin directory so uninstall knows what to remove
 */
export function installPluginAssets(
  manifest: PluginManifest,
  pluginDir: string,
): number {
  const mappings = manifest.assets?.mappings;
  if (!mappings?.length) return 0;

  const entries: AssetManifestEntry[] = [];

  for (const mapping of mappings) {
    const srcDir = join(pluginDir, mapping.src);
    if (!existsSync(srcDir)) continue;

    const targetRoot = resolveScopeDirectory(mapping.target.scope, pluginDir);
    const targetDir = mapping.target.path
      ? join(targetRoot, mapping.target.path)
      : targetRoot;
    mkdirSync(targetDir, { recursive: true });

    const files = listFiles(srcDir);

    for (const file of files) {
      if (!matchesInclude(file, mapping.include)) continue;

      const targetPath = join(targetDir, file);

      // Don't overwrite existing files unless explicitly configured
      if (!mapping.overwrite && existsSync(targetPath)) continue;

      const content = readFileSync(join(srcDir, file));
      writeFileSync(targetPath, content);

      entries.push({
        source: `${mapping.src}/${file}`,
        target: targetPath,
        hash: sha256(content),
      });
    }
  }

  // Write the asset manifest so uninstall knows what to clean up
  if (entries.length > 0) {
    const assetManifest: AssetManifest = {
      pluginName: manifest.name,
      pluginVersion: manifest.version,
      installedAt: new Date().toISOString(),
      files: entries,
    };
    writeFileSync(
      join(pluginDir, MANIFEST_FILENAME),
      JSON.stringify(assetManifest, null, 2),
    );
  }

  return entries.length;
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

/**
 * Remove assets that were installed by this plugin. Only removes files
 * whose content still matches the hash recorded at install time (i.e.,
 * user-modified files are preserved).
 *
 * Returns the number of files removed.
 */
export function uninstallPluginAssets(pluginDir: string): number {
  const manifestPath = join(pluginDir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return 0;

  let assetManifest: AssetManifest;
  try {
    assetManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of assetManifest.files) {
    if (!existsSync(entry.target)) continue;

    // Only remove if the file hasn't been modified by the user
    const currentContent = readFileSync(entry.target);
    if (sha256(currentContent) === entry.hash) {
      try {
        unlinkSync(entry.target);
        removed++;
      } catch {
        // Best-effort removal — skip files we can't delete
      }
    }
  }

  // Clean up the manifest itself
  try {
    unlinkSync(manifestPath);
  } catch {
    // Ignore
  }

  return removed;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Read the asset manifest for a plugin directory, if one exists.
 */
export function getAssetManifest(pluginDir: string): AssetManifest | null {
  const manifestPath = join(pluginDir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return null;

  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }
}

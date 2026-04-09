import { createHash } from 'node:crypto';
import { existsSync, cpSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/**
 * Resolve the path to the bundled-plugins directory.
 *
 * In development (`electron-vite dev`) the source tree is used directly.
 * In packaged builds, `extraResources` places the folder alongside the asar.
 */
function getBundledPluginsDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bundled-plugins');
  }
  // Dev mode — bundled-plugins/ lives at the project root
  return join(__dirname, '../../bundled-plugins');
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
      files.push(fullPath);
    }
  }

  return files;
}

function hashPluginDirectory(dir: string): string {
  const hash = createHash('sha256');
  const files = collectPluginFiles(dir);

  for (const filePath of files) {
    const relativePath = filePath.slice(dir.length + 1).replace(/\\/g, '/');
    hash.update(relativePath);
    hash.update('\0');
    hash.update(readFileSync(filePath));
    hash.update('\0');
  }

  return hash.digest('hex');
}

/**
 * Copy brand-required plugins from the bundled resources into the user's
 * plugins directory (`~/.{appSlug}/plugins/`).
 *
 * Skips any plugin whose target directory already exists (idempotent).
 * This runs synchronously during startup, before plugin discovery.
 */
export function bootstrapBundledPlugins(pluginsDir: string): void {
  const bundledDir = getBundledPluginsDir();
  if (!existsSync(bundledDir)) return;

  let entries: string[];
  try {
    entries = readdirSync(bundledDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry === '.gitkeep') continue;

    const srcDir = join(bundledDir, entry);
    const destDir = join(pluginsDir, entry);

    try {
      let action = 'Installed';
      const sourceHash = hashPluginDirectory(srcDir);
      if (existsSync(destDir)) {
        const installedHash = hashPluginDirectory(destDir);
        if (installedHash === sourceHash) continue;
        rmSync(destDir, { recursive: true, force: true });
        action = 'Updated';
      }

      cpSync(srcDir, destDir, { recursive: true });
      console.info(`[PluginBootstrap] ${action} bundled plugin "${entry}"`);
    } catch (err) {
      console.warn(`[PluginBootstrap] Failed to install bundled plugin "${entry}":`, err);
    }
  }
}

/**
 * Returns the set of plugin names that the current brand mandates.
 */
export function getBrandRequiredPluginNames(): Set<string> {
  try {
    return new Set(__BRAND_REQUIRED_PLUGINS);
  } catch {
    return new Set();
  }
}

import { existsSync, cpSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { getPluginIntegrity, hashPluginDirectory } from './plugin-integrity.js';
import type { PluginIntegrity } from './plugin-integrity.js';

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
  return join(import.meta.dirname, '../../bundled-plugins');
}

/**
 * Copy brand-required plugins from the bundled resources into the user's
 * plugins directory (`~/.{appSlug}/plugins/`).
 *
 * Skips any plugin whose target directory already exists (idempotent).
 * This runs synchronously during startup, before plugin discovery.
 *
 * When marketplace URLs are configured, this function is a no-op — the
 * marketplace service handles required plugin installation instead.
 */
export function bootstrapBundledPlugins(pluginsDir: string): void {
  // Skip bundled-plugin copy when marketplace is configured
  try {
    if (Array.isArray(__BRAND_MARKETPLACE_URLS) && __BRAND_MARKETPLACE_URLS.length > 0) {
      return;
    }
  } catch {
    // __BRAND_MARKETPLACE_URLS not defined — continue with bundled bootstrap
  }

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
 * Returns integrity metadata for a bundled plugin when the current brand ships
 * one. Used as a trusted source for required-plugin load checks in builds that
 * do not use a marketplace.
 */
export function getBundledPluginIntegrity(pluginName: string): PluginIntegrity | null {
  const pluginDir = join(getBundledPluginsDir(), pluginName);
  if (!existsSync(pluginDir)) return null;

  try {
    return getPluginIntegrity(pluginDir, pluginName);
  } catch {
    return null;
  }
}

/**
 * Returns the set of plugin names that the current brand mandates.
 */
export function getBrandRequiredPluginNames(): string[] {
  try {
    return [...__BRAND_REQUIRED_PLUGINS];
  } catch {
    return [];
  }
}

/**
 * Returns the marketplace catalog URLs configured for the current brand.
 */
export function getBrandMarketplaceUrls(): string[] {
  try {
    return [...__BRAND_MARKETPLACE_URLS];
  } catch {
    return [];
  }
}

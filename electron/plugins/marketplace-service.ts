import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, readdirSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { net } from 'electron';
import type { AppConfig } from '../config/schema.js';

/* ── Marketplace JSON types ── */

export type MarketplacePluginEntry = {
  name: string;
  displayName: string;
  description: string;
  repository: string;
  version: string;
  author?: string;
  authorGithub?: string;
  tags?: string[];
  icon?: string;
};

export type MarketplaceCatalog = {
  schemaVersion: number;
  plugins: MarketplacePluginEntry[];
};

export type MarketplaceCatalogEntry = MarketplacePluginEntry & {
  installed: boolean;
  installedVersion?: string;
  marketplaceUrl: string;
};

/* ── Service ── */

export class MarketplaceService {
  private cachedCatalog: MarketplaceCatalogEntry[] | null = null;
  private cacheDir: string;

  constructor(
    private pluginsDir: string,
    private appHome: string,
    private getConfig: () => AppConfig,
    private setConfig: (path: string, value: unknown) => void,
  ) {
    this.cacheDir = join(appHome, 'data');
  }

  /* ── Catalog fetch & merge ── */

  async fetchCatalog(urls: string[]): Promise<MarketplaceCatalogEntry[]> {
    const allPlugins = new Map<string, MarketplaceCatalogEntry>();
    const installedPlugins = this.getConfig().marketplace?.installedPlugins ?? {};

    for (const url of urls) {
      try {
        const catalog = await this.fetchSingleCatalog(url, true);
        for (const plugin of catalog.plugins) {
          // First URL wins on name collisions (enterprise URLs should be listed first)
          if (!allPlugins.has(plugin.name)) {
            const installedInfo = installedPlugins[plugin.name];
            allPlugins.set(plugin.name, {
              ...plugin,
              installed: this.isPluginInstalled(plugin.name),
              installedVersion: installedInfo?.version,
              marketplaceUrl: url,
            });
          }
        }
      } catch (err) {
        console.warn(`[Marketplace] Failed to fetch catalog from ${url}:`, err);
      }
    }

    const entries = [...allPlugins.values()];
    this.cachedCatalog = entries;
    this.writeCatalogCache(entries);
    return entries;
  }

  private async fetchSingleCatalog(url: string, bustCache = false): Promise<MarketplaceCatalog> {
    const fetchUrl = bustCache ? `${url}?_=${Date.now()}` : url;
    const response = await net.fetch(fetchUrl, {
      headers: {
        'Accept': 'application/json',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as MarketplaceCatalog;
    if (!data.plugins || !Array.isArray(data.plugins)) {
      throw new Error('Invalid marketplace catalog: missing plugins array');
    }

    return data;
  }

  /* ── GitHub token resolution ── */

  private async resolveGitHubToken(repo: string): Promise<string | null> {
    // For private repos, try to get a token from gh CLI auth
    // This is pragmatic since enterprise users authenticate with gh
    try {
      const repoHost = 'github.com';
      const token = await new Promise<string>((resolve, reject) => {
        execFile('gh', ['auth', 'token', '--hostname', repoHost], { timeout: 5000 }, (err, stdout) => {
          if (err) return reject(err);
          resolve(stdout.trim());
        });
      });
      if (token) return token;
    } catch {
      // gh CLI not available or not authenticated — fall through
    }

    // Check if the repo remote URL in the config has an embedded token
    // (like the LegionIO repos use ghp_ tokens in remote URLs)
    try {
      const checkUrl = `https://api.github.com/repos/${repo}`;
      const publicCheck = await net.fetch(checkUrl, { method: 'HEAD' });
      if (publicCheck.ok) return null; // Public repo, no token needed
    } catch {
      // Can't reach API — try without token anyway
    }

    return null;
  }

  /* ── Plugin install ── */

  async installPlugin(entry: MarketplaceCatalogEntry): Promise<void> {
    const destDir = join(this.pluginsDir, entry.name);
    const tmpDir = join(this.pluginsDir, `.tmp-${entry.name}-${Date.now()}`);

    try {
      mkdirSync(this.pluginsDir, { recursive: true });
      mkdirSync(tmpDir, { recursive: true });

      // Download pre-built tarball from GitHub release assets
      const tag = `v${entry.version}`;
      const assetName = `${entry.name}-v${entry.version}.tar.gz`;
      const tarballUrl = `https://github.com/${entry.repository}/releases/download/${tag}/${assetName}`;
      const token = await this.resolveGitHubToken(entry.repository);
      const headers: Record<string, string> = { 'Accept': 'application/vnd.github+json' };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await net.fetch(tarballUrl, { headers });
      if (!response.ok) {
        throw new Error(`Failed to download plugin "${entry.name}": HTTP ${response.status}`);
      }

      // Write tarball to temp file
      const tarballPath = join(tmpDir, 'plugin.tar.gz');
      const arrayBuffer = await response.arrayBuffer();
      writeFileSync(tarballPath, Buffer.from(arrayBuffer));

      // Extract tarball
      await new Promise<void>((resolve, reject) => {
        execFile('tar', ['-xzf', tarballPath, '--strip-components=1', '-C', tmpDir], (err) => {
          if (err) return reject(new Error(`Failed to extract plugin "${entry.name}": ${err.message}`));
          resolve();
        });
      });

      // Remove tarball from extracted directory
      try { rmSync(tarballPath); } catch { /* ignore */ }

      // Check for plugin.json in extracted content
      if (!existsSync(join(tmpDir, 'plugin.json'))) {
        throw new Error(`Plugin "${entry.name}" archive does not contain a plugin.json`);
      }

      // No build step needed - plugins are pre-built in release assets

      // Swap in the new plugin directory
      if (existsSync(destDir)) {
        rmSync(destDir, { recursive: true, force: true });
      }
      renameSync(tmpDir, destDir);

      // Track installation in config
      const installedPlugins = {
        ...(this.getConfig().marketplace?.installedPlugins ?? {}),
        [entry.name]: {
          name: entry.name,
          repository: entry.repository,
          version: entry.version,
          installedAt: new Date().toISOString(),
          marketplaceUrl: entry.marketplaceUrl,
        },
      };
      this.setConfig('marketplace.installedPlugins', installedPlugins);

      console.info(`[Marketplace] Installed plugin "${entry.name}" from ${entry.repository}@v${entry.version}`);
    } catch (err) {
      // Clean up temp directory on failure
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw err;
    }
  }

  /* ── Plugin uninstall ── */

  uninstallPlugin(pluginName: string): void {
    const pluginDir = join(this.pluginsDir, pluginName);
    if (existsSync(pluginDir)) {
      rmSync(pluginDir, { recursive: true, force: true });
    }

    // Remove from installed tracking
    const installedPlugins = { ...(this.getConfig().marketplace?.installedPlugins ?? {}) };
    delete installedPlugins[pluginName];
    this.setConfig('marketplace.installedPlugins', installedPlugins);

    // Remove plugin approval
    const approvals = { ...(this.getConfig().pluginApprovals ?? {}) };
    delete approvals[pluginName];
    this.setConfig('pluginApprovals', approvals);

    // Remove plugin-specific config
    const plugins = { ...(this.getConfig().plugins ?? {}) };
    delete plugins[pluginName];
    this.setConfig('plugins', plugins);

    // Update cached catalog
    if (this.cachedCatalog) {
      this.cachedCatalog = this.cachedCatalog.map((entry) =>
        entry.name === pluginName
          ? { ...entry, installed: false, installedVersion: undefined }
          : entry,
      );
    }

    console.info(`[Marketplace] Uninstalled plugin "${pluginName}"`);
  }

  /* ── Auto-install required plugins ── */

  async autoInstallRequired(requiredNames: Set<string>, catalog: MarketplaceCatalogEntry[]): Promise<void> {
    for (const name of requiredNames) {
      if (this.isPluginInstalled(name)) continue;

      const entry = catalog.find((p) => p.name === name);
      if (!entry) {
        console.warn(`[Marketplace] Required plugin "${name}" not found in any marketplace catalog`);
        continue;
      }

      try {
        console.info(`[Marketplace] Auto-installing required plugin "${name}"...`);
        await this.installPlugin(entry);
      } catch (err) {
        console.error(`[Marketplace] Failed to auto-install required plugin "${name}":`, err);
      }
    }
  }

  /* ── Helpers ── */

  private isPluginInstalled(name: string): boolean {
    const pluginDir = join(this.pluginsDir, name);
    return existsSync(join(pluginDir, 'plugin.json'));
  }

  getCachedCatalog(): MarketplaceCatalogEntry[] | null {
    if (this.cachedCatalog) return this.cachedCatalog;

    // Try loading from disk cache
    try {
      const cachePath = join(this.cacheDir, 'marketplace.json');
      if (existsSync(cachePath)) {
        const raw = JSON.parse(readFileSync(cachePath, 'utf-8')) as MarketplaceCatalogEntry[];
        // Re-check installed status
        const installedPlugins = this.getConfig().marketplace?.installedPlugins ?? {};
        this.cachedCatalog = raw.map((entry) => ({
          ...entry,
          installed: this.isPluginInstalled(entry.name),
          installedVersion: installedPlugins[entry.name]?.version,
        }));
        return this.cachedCatalog;
      }
    } catch {
      // Ignore cache read errors
    }

    return null;
  }

  private writeCatalogCache(entries: MarketplaceCatalogEntry[]): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(join(this.cacheDir, 'marketplace.json'), JSON.stringify(entries, null, 2));
    } catch (err) {
      console.warn('[Marketplace] Failed to write catalog cache:', err);
    }
  }

  /** Return the list of locally installed plugin directory names (for discovery fallback). */
  getInstalledPluginNames(): string[] {
    if (!existsSync(this.pluginsDir)) return [];
    try {
      return readdirSync(this.pluginsDir).filter((entry) => {
        return existsSync(join(this.pluginsDir, entry, 'plugin.json'));
      });
    } catch {
      return [];
    }
  }
}

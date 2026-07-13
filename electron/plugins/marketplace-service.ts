import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, readdirSync } from 'fs';
import { join, resolve, sep } from 'path';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { net } from 'electron';
import type { AppConfig } from '../config/schema.js';
import {
  arePermissionSetsEqual,
  getPluginIntegrity,
  hashPluginDirectory,
  readPluginManifest,
} from './plugin-integrity.js';
import type { PluginIntegrity } from './plugin-integrity.js';
import { DANGEROUS_PLUGIN_PERMISSIONS } from './types.js';

type InstalledPluginRecord = NonNullable<NonNullable<AppConfig['marketplace']>['installedPlugins']>[string];
type PluginApprovalRecord = NonNullable<AppConfig['pluginApprovals']>[string];

export type InstallResult = PluginIntegrity & {
  backupDir?: string;
  priorInstalledRecord?: InstalledPluginRecord;
  priorApproval?: PluginApprovalRecord;
};
import { checkPluginCompatibility } from './plugin-compat.js';
import type { CompatCheckResult } from './plugin-compat.js';

/** Reject a marketplace/package URL that isn't HTTPS (localhost allowed for
 *  dev). A plaintext catalog/download lets a MITM swap the published integrity
 *  hashes AND the archive, making the integrity check attacker-controlled. */
function assertSecureMarketplaceUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid marketplace URL: ${rawUrl}`);
  }
  if (parsed.protocol === 'https:') return;
  const host = parsed.hostname;
  // Node reports the IPv6 loopback hostname WITH brackets ('[::1]'), so include
  // both forms for the localhost exception.
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (parsed.protocol === 'http:' && isLocal) return;
  throw new Error(`Refusing insecure marketplace URL (must be https): ${rawUrl}`);
}

/** Timeout for a marketplace network op (catalog fetch or tarball download),
 *  bounding BOTH the response-headers wait and the body read so a host that
 *  trickles the body slowly under the byte cap can't hang the install/refresh
 *  indefinitely. */
const MARKETPLACE_FETCH_TIMEOUT_MS = 60_000;

/** Hard cap on a downloaded plugin archive (before extraction). Real plugins are
 *  a small fraction of this; the cap only stops a malicious/broken host from
 *  exhausting memory/disk before the integrity check. */
const MAX_PLUGIN_ARCHIVE_BYTES = 128 * 1024 * 1024; // 128 MiB

/** Read a fetch Response body into a Buffer, aborting once it exceeds maxBytes
 *  OR the optional signal fires. read() takes no signal, so each read is raced
 *  against an abort promise — this bounds a host that trickles the body slowly
 *  under the byte cap (a hang the byte cap alone can't catch). */
async function readCappedResponse(
  response: Response,
  maxBytes: number,
  pluginName: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let completed = false;
  let onAbort: (() => void) | undefined;
  const abortPromise: Promise<never> | null = signal
    ? new Promise<never>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error(`Plugin "${pluginName}" download timed out or was aborted.`));
          return;
        }
        onAbort = () => reject(new Error(`Plugin "${pluginName}" download timed out or was aborted.`));
        signal.addEventListener('abort', onAbort, { once: true });
      })
    : null;
  try {
    for (;;) {
      const { done, value } = abortPromise ? await Promise.race([reader.read(), abortPromise]) : await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (value) {
        received += value.byteLength;
        if (received > maxBytes) {
          throw new Error(`Plugin "${pluginName}" archive exceeded ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    // Best-effort, non-awaited cancel on an EARLY exit (cap/abort/error) so a
    // trickling host's underlying download stops and a pathological cancel()
    // can't itself hang teardown. A cleanly-finished stream needs no cancel.
    if (!completed) {
      void reader.cancel().catch(() => {
        /* best-effort */
      });
    }
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/* ── Marketplace JSON types ── */

export type MarketplacePluginEntry = {
  name: string;
  displayName: string;
  description: string;
  repository: string;
  version: string;
  /** sha256 of the release tarball, verified before extraction. */
  archiveHash?: string;
  fileHash?: string;
  hash?: string;
  author?: string;
  tags?: string[];
  icon?: string;
  /** npm-style semver range constraint on the host plugin API version. */
  engines?: { kai?: string };
  /** Host capabilities this plugin requires. */
  capabilities?: string[];
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

/**
 * Thrown by {@link MarketplaceService.installPlugin} when the catalog entry
 * publishes no integrity hash (neither archiveHash, fileHash, nor hash). The
 * IPC handler catches this and surfaces a user-consent prompt before retrying.
 */
export class UnverifiedPluginError extends Error {
  constructor(public pluginName: string) {
    super(`Plugin "${pluginName}" has no published integrity hash`);
    this.name = 'UnverifiedPluginError';
  }
}

const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/* ── Service ── */

export class MarketplaceService {
  private cachedCatalog: MarketplaceCatalogEntry[] | null = null;
  private cacheDir: string;

  constructor(
    private pluginsDir: string,
    private appHome: string,
    private getConfig: () => AppConfig,
    private setConfig: (path: string, value: unknown) => void,
    private brandRequiredPluginNames: ReadonlySet<string> = new Set(),
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
    assertSecureMarketplaceUrl(url);
    const fetchUrl = bustCache ? `${url}?_=${Date.now()}` : url;
    const response = await net.fetch(fetchUrl, {
      signal: AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as MarketplaceCatalog;
    if (!data.plugins || !Array.isArray(data.plugins)) {
      throw new Error('Invalid marketplace catalog: missing plugins array');
    }

    return data;
  }

  /* ── GitHub token resolution ── */

  private async resolveGitHubToken(repo: string): Promise<string | null> {
    // Prefer explicit env vars (works in CI, containers, and GUI-launched apps)
    const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (envToken) return envToken;

    // Fall back to gh CLI auth
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

    // Check if the repo is public (no token needed)
    try {
      const checkUrl = `https://api.github.com/repos/${repo}`;
      const publicCheck = await net.fetch(checkUrl, { method: 'HEAD' });
      if (publicCheck.ok) return null;
    } catch {
      // Can't reach API — try without token anyway
    }

    return null;
  }

  /* ── Plugin install ── */

  async installPlugin(entry: MarketplaceCatalogEntry, opts?: { skipHashCheck?: boolean }): Promise<InstallResult> {
    if (!PLUGIN_NAME_RE.test(entry.name)) {
      throw new Error(`Invalid plugin name in catalog: ${entry.name}`);
    }
    // Only the "no hash published at all" case can be bypassed by user consent.
    // If an archiveHash *is* present it is still verified below regardless of
    // skipHashCheck — the bypass never weakens a hash that exists.
    if (!opts?.skipHashCheck && !entry.archiveHash && !entry.fileHash && !entry.hash) {
      throw new UnverifiedPluginError(entry.name);
    }

    const destDir = join(this.pluginsDir, entry.name);
    const tmpDir = join(this.pluginsDir, `.tmp-${entry.name}-${Date.now()}`);
    const backupDir = `${destDir}.prev`;
    let backedUp = false;
    const priorInstalledRecord = this.getConfig().marketplace?.installedPlugins?.[entry.name];
    const priorApproval = this.getConfig().pluginApprovals?.[entry.name];

    try {
      mkdirSync(this.pluginsDir, { recursive: true });
      mkdirSync(tmpDir, { recursive: true });

      // Download pre-built tarball
      const tag = `v${entry.version}`;
      const assetName = `${entry.name}-v${entry.version}.tar.gz`;
      const isGitHub =
        entry.marketplaceUrl.includes('github.com') || entry.marketplaceUrl.includes('raw.githubusercontent.com');

      let tarballUrl: string;
      let headers: Record<string, string> = {};

      if (isGitHub) {
        const token = await this.resolveGitHubToken(entry.repository);

        // Use the GitHub Releases API to resolve the binary download URL.
        // The browser-style download URL (github.com/.../releases/download/...)
        // returns HTML instead of binary content for private repositories, even
        // when a valid Bearer token is provided.
        const apiUrl = `https://api.github.com/repos/${entry.repository}/releases/tags/${tag}`;
        const apiHeaders: Record<string, string> = { Accept: 'application/vnd.github+json' };
        if (token) apiHeaders['Authorization'] = `Bearer ${token}`;

        const releaseResp = await net.fetch(apiUrl, { headers: apiHeaders });
        if (!releaseResp.ok) {
          throw new Error(`Failed to find release "${tag}" for plugin "${entry.name}": HTTP ${releaseResp.status}`);
        }

        const releaseData = (await releaseResp.json()) as { assets: Array<{ name: string; url: string }> };
        const asset = releaseData.assets.find((a) => a.name === assetName);
        if (!asset) {
          throw new Error(`Release "${tag}" for plugin "${entry.name}" has no asset named "${assetName}"`);
        }

        // Download via the asset API URL with octet-stream accept header
        tarballUrl = asset.url;
        headers = { Accept: 'application/octet-stream' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
      } else {
        // Self-hosted (S3, etc): tarballs are siblings of marketplace.json
        const baseUrl = entry.marketplaceUrl.replace(/\/[^/]*$/, '');
        tarballUrl = `${baseUrl}/${entry.name}/${tag}/${assetName}`;
      }

      // The resolved package URL must be HTTPS (or localhost) — a plaintext
      // download lets a MITM swap the archive before the hash check.
      assertSecureMarketplaceUrl(tarballUrl);

      // One deadline bounds BOTH the headers wait (via net.fetch signal) AND the
      // body read (via readCappedResponse racing each read) so a trickling host
      // can't hang the download indefinitely under the byte cap.
      const dlSignal = AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS);
      const response = await net.fetch(tarballUrl, { headers, signal: dlSignal });
      if (!response.ok) {
        throw new Error(`Failed to download plugin "${entry.name}": HTTP ${response.status}`);
      }

      // Reject an oversized advertised length up front, then read the body with
      // a hard byte cap so a malicious/broken host can't exhaust memory before
      // the integrity check runs. (A missing/garbage Content-Length yields NaN,
      // which fails the > check — the streaming cap below is the real gate; the
      // isFinite guard just documents that and keeps the early-out meaningful.)
      const advertised = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(advertised) && advertised > MAX_PLUGIN_ARCHIVE_BYTES) {
        throw new Error(`Plugin "${entry.name}" archive too large: ${advertised} > ${MAX_PLUGIN_ARCHIVE_BYTES}`);
      }
      const archiveBuffer = await readCappedResponse(response, MAX_PLUGIN_ARCHIVE_BYTES, entry.name, dlSignal);

      // Verify the tarball integrity BEFORE writing it to disk or feeding it
      // to tar — a malicious archive could otherwise exploit the extractor.
      // archiveHash is REQUIRED: without it, tar would run on unverified bytes
      // (a MITM'd/compromised origin could ship a traversal/symlink archive).
      if (!entry.archiveHash) {
        throw new Error(`Plugin "${entry.name}" has no archiveHash — refusing to install unverified package`);
      }
      const archiveHash = createHash('sha256').update(archiveBuffer).digest('hex');
      if (archiveHash !== entry.archiveHash) {
        throw new Error(
          `Plugin "${entry.name}" archive integrity check failed: expected ${entry.archiveHash}, got ${archiveHash}`,
        );
      }

      // Write tarball to temp file
      const tarballPath = join(tmpDir, 'plugin.tar.gz');
      writeFileSync(tarballPath, archiveBuffer);

      // Extract tarball
      await new Promise<void>((resolve, reject) => {
        execFile('tar', ['-xzf', tarballPath, '--strip-components=1', '-C', tmpDir], (err) => {
          if (err) return reject(new Error(`Failed to extract plugin "${entry.name}": ${err.message}`));
          resolve();
        });
      });

      // Remove tarball from extracted directory
      try {
        rmSync(tarballPath);
      } catch {
        /* ignore */
      }

      // Check for plugin.json in extracted content
      if (!existsSync(join(tmpDir, 'plugin.json'))) {
        throw new Error(`Plugin "${entry.name}" archive does not contain a plugin.json`);
      }

      const manifest = readPluginManifest(tmpDir, entry.name);
      if (manifest.name !== entry.name) {
        throw new Error(`Plugin archive name mismatch: expected "${entry.name}", got "${manifest.name}"`);
      }

      const fileHash = hashPluginDirectory(tmpDir);
      const expectedFileHash = this.getExpectedFileHash(entry);
      if (expectedFileHash && fileHash !== expectedFileHash) {
        throw new Error(`Plugin "${entry.name}" failed integrity check: expected ${expectedFileHash}, got ${fileHash}`);
      }

      // No build step needed - plugins are pre-built in release assets

      // Swap in the new plugin directory, keeping the previous one as a backup
      // so the caller can roll back if the new version fails to activate.
      if (existsSync(backupDir)) {
        rmSync(backupDir, { recursive: true, force: true });
      }
      if (existsSync(destDir)) {
        renameSync(destDir, backupDir);
        backedUp = true;
      }
      renameSync(tmpDir, destDir);

      // Track installation in config
      const installedPlugins = {
        ...(this.getConfig().marketplace?.installedPlugins ?? {}),
        [entry.name]: {
          name: entry.name,
          repository: entry.repository,
          version: entry.version,
          fileHash,
          permissions: manifest.permissions,
          installedAt: new Date().toISOString(),
          marketplaceUrl: entry.marketplaceUrl,
        },
      };
      this.setConfig('marketplace.installedPlugins', installedPlugins);

      const isBrandRequired = this.brandRequiredPluginNames.has(entry.name);
      const hasDangerous = manifest.permissions.some((p) => DANGEROUS_PLUGIN_PERMISSIONS.has(p));
      if (isBrandRequired || !hasDangerous) {
        this.persistPluginApproval(entry.name, fileHash, manifest.permissions);
      }
      if (this.cachedCatalog) {
        this.cachedCatalog = this.cachedCatalog.map((catalogEntry) =>
          catalogEntry.name === entry.name
            ? { ...catalogEntry, installed: true, installedVersion: entry.version }
            : catalogEntry,
        );
        this.writeCatalogCache(this.cachedCatalog);
      }

      console.info(`[Marketplace] Installed plugin "${entry.name}" from ${entry.repository}@v${entry.version}`);
      return {
        fileHash,
        permissions: manifest.permissions,
        version: manifest.version,
        backupDir: backedUp ? backupDir : undefined,
        priorInstalledRecord: priorInstalledRecord ? { ...priorInstalledRecord } : undefined,
        priorApproval: priorApproval ? { ...priorApproval } : undefined,
      };
    } catch (err) {
      // Clean up temp directory on failure
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      if (backedUp && existsSync(backupDir)) {
        try {
          if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
          renameSync(backupDir, destDir);
        } catch {
          /* ignore */
        }
      }
      throw err;
    }
  }

  rollbackInstall(
    pluginName: string,
    backupDir: string,
    prior: Pick<InstallResult, 'priorInstalledRecord' | 'priorApproval'>,
  ): void {
    const destDir = join(this.pluginsDir, pluginName);
    if (!existsSync(backupDir)) return;
    try {
      if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
      renameSync(backupDir, destDir);
    } catch (err) {
      console.error(`[Marketplace] Failed to roll back plugin "${pluginName}":`, err);
      return;
    }

    try {
      const installedPlugins = { ...(this.getConfig().marketplace?.installedPlugins ?? {}) };
      if (prior.priorInstalledRecord) {
        installedPlugins[pluginName] = { ...prior.priorInstalledRecord };
      } else {
        delete installedPlugins[pluginName];
      }
      this.setConfig('marketplace.installedPlugins', installedPlugins);

      const approvals = { ...(this.getConfig().pluginApprovals ?? {}) };
      if (prior.priorApproval) {
        approvals[pluginName] = { ...prior.priorApproval };
      } else {
        delete approvals[pluginName];
      }
      this.setConfig('pluginApprovals', approvals);

      if (this.cachedCatalog) {
        this.cachedCatalog = this.cachedCatalog.map((entry) =>
          entry.name === pluginName ? { ...entry, installedVersion: prior.priorInstalledRecord?.version } : entry,
        );
        this.writeCatalogCache(this.cachedCatalog);
      }
    } catch (err) {
      console.error(`[Marketplace] Failed to restore prior config for "${pluginName}" after rollback:`, err);
    }
  }

  discardBackup(backupDir: string): void {
    try {
      rmSync(backupDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  /**
   * Pre-check whether a marketplace entry is compatible with this host
   * before downloading/installing. Returns the compat result so the UI
   * can warn the user.
   */
  checkEntryCompatibility(entry: MarketplaceCatalogEntry): CompatCheckResult {
    // Build a synthetic partial manifest from marketplace entry metadata
    return checkPluginCompatibility({
      name: entry.name,
      displayName: entry.displayName,
      version: entry.version,
      description: entry.description,
      permissions: [],
      engines: entry.engines,
      capabilities: entry.capabilities,
    });
  }

  /* ── Plugin uninstall ── */

  uninstallPlugin(pluginName: string): void {
    if (
      !pluginName ||
      pluginName.includes('/') ||
      pluginName.includes('\\') ||
      pluginName === '.' ||
      pluginName === '..'
    ) {
      throw new Error('Invalid plugin name');
    }

    const pluginDir = join(this.pluginsDir, pluginName);
    if (!resolve(pluginDir).startsWith(resolve(this.pluginsDir) + sep)) {
      throw new Error('Invalid plugin name');
    }
    if (existsSync(pluginDir)) {
      rmSync(pluginDir, { recursive: true, force: true });
    }
    const backupDir = `${pluginDir}.prev`;
    if (existsSync(backupDir)) {
      rmSync(backupDir, { recursive: true, force: true });
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
        entry.name === pluginName ? { ...entry, installed: false, installedVersion: undefined } : entry,
      );
    }

    console.info(`[Marketplace] Uninstalled plugin "${pluginName}"`);
  }

  /* ── Auto-install required plugins ── */

  async autoInstallRequired(
    requiredNames: Set<string>,
    catalog: MarketplaceCatalogEntry[],
    hooks?: {
      afterInstall?: (name: string, result: InstallResult) => Promise<void>;
      serialize?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
    },
  ): Promise<string[]> {
    const installed: string[] = [];
    const serialize = hooks?.serialize ?? (<T>(_name: string, fn: () => Promise<T>) => fn());
    for (const name of requiredNames) {
      const entry = catalog.find((p) => p.name === name);
      if (!entry) {
        console.warn(`[Marketplace] Required plugin "${name}" not found in any marketplace catalog`);
        continue;
      }

      try {
        const reason = this.getRequiredInstallReason(entry);
        if (!reason) continue;

        console.info(`[Marketplace] Auto-installing required plugin "${name}" (${reason})...`);
        await serialize(name, async () => {
          const result = await this.installPlugin(entry);
          installed.push(name);
          await hooks?.afterInstall?.(name, result);
        });
      } catch (err) {
        console.error(`[Marketplace] Failed to auto-install required plugin "${name}":`, err);
      }
    }
    return installed;
  }

  /* ── Helpers ── */

  private isPluginInstalled(name: string): boolean {
    const pluginDir = join(this.pluginsDir, name);
    return existsSync(join(pluginDir, 'plugin.json'));
  }

  private getExpectedFileHash(entry: MarketplacePluginEntry): string | undefined {
    return entry.fileHash ?? entry.hash;
  }

  private getInstalledPluginIntegrity(name: string): PluginIntegrity | null {
    const pluginDir = join(this.pluginsDir, name);
    if (!existsSync(join(pluginDir, 'plugin.json'))) return null;

    try {
      return getPluginIntegrity(pluginDir, name);
    } catch {
      return null;
    }
  }

  private getRequiredInstallReason(entry: MarketplaceCatalogEntry): string | null {
    const installed = this.getInstalledPluginIntegrity(entry.name);
    if (!installed) return 'missing';

    const installedInfo = this.getConfig().marketplace?.installedPlugins?.[entry.name];
    const expectedFileHash = this.getExpectedFileHash(entry);
    if (expectedFileHash && installed.fileHash !== expectedFileHash) return 'integrity mismatch';
    if (installedInfo?.fileHash && installed.fileHash !== installedInfo.fileHash) return 'local files changed';
    if (!installedInfo?.fileHash) return 'untrusted install metadata';
    if (!installedInfo.permissions) return 'untrusted permission metadata';
    if (installedInfo.version !== entry.version || installed.version !== entry.version)
      return `update available ${installedInfo.version ?? installed.version} -> ${entry.version}`;
    if (!arePermissionSetsEqual(installedInfo.permissions, installed.permissions)) return 'permissions changed';

    const approval = this.getConfig().pluginApprovals?.[entry.name];
    if (
      !approval ||
      approval.hash !== installed.fileHash ||
      !arePermissionSetsEqual(approval.permissions, installed.permissions)
    ) {
      const isBrandRequired = this.brandRequiredPluginNames.has(entry.name);
      const hasDangerous = installed.permissions.some((p) => DANGEROUS_PLUGIN_PERMISSIONS.has(p));
      if (isBrandRequired || !hasDangerous) {
        this.persistPluginApproval(entry.name, installed.fileHash, installed.permissions);
      }
    }

    return null;
  }

  private persistPluginApproval(pluginName: string, fileHash: string, permissions: readonly string[]): void {
    this.setConfig('pluginApprovals', {
      ...(this.getConfig().pluginApprovals ?? {}),
      [pluginName]: {
        hash: fileHash,
        permissions: [...permissions],
        approvedAt: new Date().toISOString(),
      },
    });
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
        if (entry.startsWith('.') || entry.endsWith('.prev')) return false;
        return existsSync(join(this.pluginsDir, entry, 'plugin.json'));
      });
    } catch {
      return [];
    }
  }
}

/** Exposed for unit tests only. */
export const __internal = { assertSecureMarketplaceUrl, readCappedResponse, MARKETPLACE_FETCH_TIMEOUT_MS };

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { parse } from 'smol-toml';
import type { PluginHost } from '../../shared/plugin-bridge.js';
import { object, packageFile, readBoundedFile, safeLabel } from './files.js';
import type { InstalledPlugin } from './types.js';

export function hostHomes(overrides?: { claudeHome?: string; codexHome?: string }): Record<PluginHost, string> {
  return {
    claude: resolve(overrides?.claudeHome || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')),
    codex: resolve(overrides?.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex')),
  };
}
function json(path: string): Record<string, unknown> {
  return object(JSON.parse(readBoundedFile(path)));
}
function directories(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('plugin-install-'))
    .map((d) => d.name)
    .sort()
    .slice(0, 200);
}
function installedRoot(home: string, path: string): string {
  const root = realpathSync(path);
  const rel = relative(realpathSync(home), root);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('Installation is outside the configured host home. Development-folder imports are not supported.');
  }
  return root;
}

/** Read only explicitly configured marketplace metadata. Never traverse or
 * import its development sources, or fetch a remote catalog. */
function marketplaceVersions(codex: Record<string, unknown>): Map<string, string> {
  const versions = new Map<string, string>();
  for (const [marketName, value] of Object.entries(object(codex.marketplaces)).slice(0, 200)) {
    const market = object(value);
    const source = typeof market.source === 'string' ? market.source : object(market.source).path;
    if (typeof source !== 'string' || !isAbsolute(source)) continue;
    try {
      const metadata = [
        '.agents/plugins/marketplace.json',
        '.codex-plugin/marketplace.json',
        '.claude-plugin/marketplace.json',
        'marketplace.json',
      ].find((file) => existsSync(join(source, file)));
      if (!metadata) continue;
      const catalog = json(packageFile(source, metadata));
      for (const raw of (Array.isArray(catalog.plugins) ? catalog.plugins : []).slice(0, 200)) {
        const plugin = object(raw);
        if (typeof plugin.name !== 'string') continue;
        let version = typeof plugin.version === 'string' ? plugin.version : undefined;
        // A named, local manifest is metadata too. It may identify a cache
        // version, but its source path is NEVER offered as an installation.
        const path = typeof plugin.source === 'string' ? plugin.source : object(plugin.source).path;
        if (!version && typeof path === 'string' && path.startsWith('./')) {
          for (const file of ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
            try {
              const manifest = json(packageFile(source, join(path, file)));
              if (typeof manifest.version === 'string') version = manifest.version;
              break;
            } catch {
              /* Another supported manifest layout may exist. */
            }
          }
        }
        if (version) versions.set(`${plugin.name}@${marketName}`, version);
      }
    } catch {
      /* Unavailable metadata leaves the installed cache ambiguous. */
    }
  }
  return versions;
}

export function discoverInstallations(homes: Record<PluginHost, string>): {
  installations: InstalledPlugin[];
  diagnostics: string[];
} {
  const installations: InstalledPlugin[] = [];
  const diagnostics: string[] = [];
  const registryPath = join(homes.claude, 'plugins', 'installed_plugins.json');
  if (existsSync(registryPath)) {
    try {
      const registry = json(registryPath);
      const settingsPath = join(homes.claude, 'settings.json');
      const enabled = existsSync(settingsPath) ? object(json(settingsPath).enabledPlugins) : {};
      for (const [key, value] of Object.entries(object(registry.plugins)).slice(0, 200)) {
        const userEntries = (Array.isArray(value) ? value : [value])
          .map(object)
          .filter((entry) => entry.scope === 'user');
        for (const entry of userEntries) {
          try {
            if (typeof entry.installPath !== 'string') throw new Error('Missing installation path.');
            installations.push({
              host: 'claude',
              installation: key,
              root: installedRoot(homes.claude, entry.installPath),
              version: safeLabel(entry.version, 'unknown'),
              hostEnabled: typeof enabled[key] === 'boolean' ? enabled[key] : null,
              ambiguous: userEntries.length > 1,
            });
          } catch {
            diagnostics.push(
              `Claude installation ${safeLabel(key, 'unknown')} could not be resolved inside its user home.`,
            );
          }
        }
      }
    } catch {
      diagnostics.push('Claude user plugin registry or settings could not be read.');
    }
  }
  const configPath = join(homes.codex, 'config.toml');
  let codex: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      codex = parse(readBoundedFile(configPath));
    } catch {
      diagnostics.push('Codex user configuration could not be parsed.');
    }
  }
  const configured = object(codex.plugins);
  const metadataVersions = marketplaceVersions(codex);
  const found = new Set<string>();
  const cache = join(homes.codex, 'plugins', 'cache');
  for (const marketplace of directories(cache)) {
    for (const name of directories(join(cache, marketplace))) {
      const key = `${name}@${marketplace}`;
      const entry = object(configured[key]);
      found.add(key);
      // Registry/config pins win over old cache versions. With no pin, only a
      // single installed cache version is unambiguous; never sort by semver.
      let versions = directories(join(cache, marketplace, name));
      const pin = typeof entry.version === 'string' ? entry.version : metadataVersions.get(key);
      const installPath =
        typeof entry.installPath === 'string'
          ? entry.installPath
          : typeof entry.install_path === 'string'
            ? entry.install_path
            : undefined;
      if (installPath)
        versions = versions.filter((version) => resolve(cache, marketplace, name, version) === resolve(installPath));
      if (pin)
        versions = versions.filter((version) => {
          if (version === pin) return true;
          // Local installs can live under `local`, and cache build identifiers
          // need not equal the manifest's declared version. Read only that
          // installed package's metadata; multiple matches remain ambiguous.
          try {
            const root = installedRoot(homes.codex, join(cache, marketplace, name, version));
            const file = ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json'].find((path) =>
              existsSync(join(root, path)),
            );
            return !!file && json(packageFile(root, file)).version === pin;
          } catch {
            return false;
          }
        });
      // A missing metadata target cannot silently activate an older cache.
      if (!versions.length) {
        installations.push({
          host: 'codex',
          installation: key,
          root: resolve(cache, marketplace, name, pin ?? 'missing'),
          version: pin ?? 'missing',
          hostEnabled: typeof entry.enabled === 'boolean' ? entry.enabled : null,
          ambiguous: false,
        });
      }
      if (!versions.length) {
        diagnostics.push(`Codex installation ${safeLabel(key, 'unknown')} has no matching installed version.`);
      }
      for (const version of versions) {
        try {
          const root = installedRoot(homes.codex, join(cache, marketplace, name, version));
          installations.push({
            host: 'codex',
            installation: key,
            root,
            version,
            hostEnabled: typeof entry.enabled === 'boolean' ? entry.enabled : null,
            ambiguous: versions.length > 1 || (!Object.hasOwn(configured, key) && !pin && !installPath),
          });
        } catch {
          diagnostics.push(`Codex installation ${safeLabel(key, 'unknown')} could not be read.`);
        }
      }
    }
  }
  for (const [key, value] of Object.entries(configured)) {
    if (found.has(key)) continue;
    const entry = object(value);
    const installPath = typeof entry.installPath === 'string' ? entry.installPath : entry.install_path;
    if (typeof installPath !== 'string') {
      diagnostics.push(`Codex plugin ${safeLabel(key, 'unknown')} is configured but has no installed cache entry.`);
      continue;
    }
    try {
      installations.push({
        host: 'codex',
        installation: key,
        root: installedRoot(homes.codex, installPath),
        version: safeLabel(entry.version, 'unknown'),
        hostEnabled: typeof entry.enabled === 'boolean' ? entry.enabled : null,
        ambiguous: false,
      });
    } catch {
      diagnostics.push(`Codex installation ${safeLabel(key, 'unknown')} is not inside its configured user home.`);
    }
  }
  return { installations, diagnostics };
}

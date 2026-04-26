import { useState, useEffect, useCallback, type FC } from 'react';
import { RefreshCwIcon, DownloadIcon, TrashIcon, ShieldIcon, PackageIcon, LoaderIcon, AlertCircleIcon, ArrowUpCircleIcon, SearchIcon, CheckIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';

type MarketplaceEntry = {
  name: string;
  displayName: string;
  description: string;
  version: string;
  author?: string;
  tags?: string[];
  icon?: string;
  installed: boolean;
  installedVersion?: string;
  marketplaceUrl: string;
};

function isNewerVersion(catalogVersion: string, installedVersion: string): boolean {
  const toNum = (v: string) => v.split('.').map(Number);
  const [cMajor, cMinor, cPatch] = toNum(catalogVersion);
  const [iMajor, iMinor, iPatch] = toNum(installedVersion);
  if (cMajor !== iMajor) return cMajor > iMajor;
  if (cMinor !== iMinor) return cMinor > iMinor;
  return cPatch > iPatch;
}

type InstalledPlugin = {
  name: string;
  displayName: string;
  version: string;
  description: string;
  state: string;
  required: boolean;
  brandRequired: boolean;
  error?: string;
};

export const PluginMarketplace: FC = () => {
  const [catalog, setCatalog] = useState<MarketplaceEntry[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [installingPlugins, setInstallingPlugins] = useState<Set<string>>(new Set());
  const [uninstallingPlugins, setUninstallingPlugins] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [justRefreshed, setJustRefreshed] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [catalogData, pluginList] = await Promise.all([
        app.plugins.marketplaceCatalog(),
        app.plugins.list(),
      ]);
      setCatalog(catalogData);
      setInstalledPlugins(pluginList);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load marketplace data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setJustRefreshed(false);
    try {
      const refreshed = await app.plugins.marketplaceRefresh();
      setCatalog(refreshed);
      const pluginList = await app.plugins.list();
      setInstalledPlugins(pluginList);
      setError(null);
      setJustRefreshed(true);
      setTimeout(() => setJustRefreshed(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh marketplace');
    } finally {
      setRefreshing(false);
    }
  };

  const handleInstall = async (pluginName: string) => {
    setInstallingPlugins((prev) => new Set([...prev, pluginName]));
    try {
      await app.plugins.marketplaceInstall(pluginName);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to install ${pluginName}`);
    } finally {
      setInstallingPlugins((prev) => {
        const next = new Set(prev);
        next.delete(pluginName);
        return next;
      });
    }
  };

  const handleUninstall = async (pluginName: string) => {
    setUninstallingPlugins((prev) => new Set([...prev, pluginName]));
    try {
      await app.plugins.marketplaceUninstall(pluginName);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to uninstall ${pluginName}`);
    } finally {
      setUninstallingPlugins((prev) => {
        const next = new Set(prev);
        next.delete(pluginName);
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoaderIcon className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading marketplace...</span>
      </div>
    );
  }

  const installedNames = new Set(installedPlugins.map((p) => p.name));

  // Build a map of plugin name -> catalog entry for update checking
  const catalogMap = new Map(catalog.map((entry) => [entry.name, entry]));

  // Filter plugins based on search query
  const searchLower = searchQuery.toLowerCase();
  const filteredInstalledPlugins = installedPlugins.filter((plugin) =>
    plugin.displayName.toLowerCase().includes(searchLower) ||
    plugin.name.toLowerCase().includes(searchLower) ||
    plugin.description.toLowerCase().includes(searchLower)
  );

  const availableCatalog = catalog
    .filter((entry) => !entry.installed && !installedNames.has(entry.name))
    .filter((entry) =>
      entry.displayName.toLowerCase().includes(searchLower) ||
      entry.name.toLowerCase().includes(searchLower) ||
      entry.description.toLowerCase().includes(searchLower) ||
      entry.tags?.some((tag) => tag.toLowerCase().includes(searchLower))
    );

  const hasCatalog = catalog.length > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Plugin Marketplace</h3>
          <p className="text-xs text-muted-foreground">
            Browse, install, and manage plugins
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search plugins..."
              className="h-8 w-48 rounded-lg border border-border/70 bg-card pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing || justRefreshed}
            title="Refresh Plugins"
            className={`flex items-center justify-center rounded-lg border px-2.5 py-1.5 transition-colors disabled:opacity-50 ${
              justRefreshed
                ? 'border-green-500/30 bg-green-500/10 text-green-400'
                : 'border-border/70 bg-card text-foreground hover:bg-muted/80'
            }`}
          >
            {refreshing ? (
              <RefreshCwIcon className="h-3.5 w-3.5 animate-spin" />
            ) : justRefreshed ? (
              <CheckIcon className="h-3.5 w-3.5" />
            ) : (
              <RefreshCwIcon className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
          <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-red-400">{error}</p>
          </div>
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-auto shrink-0 text-xs text-red-400/70 hover:text-red-400"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Installed plugins */}
      {filteredInstalledPlugins.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Installed ({filteredInstalledPlugins.length})
          </h4>
          <div className="space-y-2">
            {filteredInstalledPlugins.map((plugin) => {
              const catalogEntry = catalogMap.get(plugin.name);
              const hasUpdate = catalogEntry && catalogEntry.version && isNewerVersion(catalogEntry.version, plugin.version);

              return (
                <div
                  key={plugin.name}
                  className="flex items-center gap-3 rounded-xl border border-border/70 bg-card/50 px-4 py-3"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <PackageIcon className="h-4 w-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold">{plugin.displayName}</span>
                      {plugin.state === 'active' && (
                        <span className="h-1.5 w-1.5 rounded-full bg-green-500" title="Active" />
                      )}
                      {plugin.state === 'error' && (
                        <span className="h-1.5 w-1.5 rounded-full bg-red-500" title="Error" />
                      )}
                      {plugin.state === 'disabled' && (
                        <span className="h-1.5 w-1.5 rounded-full bg-yellow-500" title="Disabled" />
                      )}
                      <span className="text-[10px] text-muted-foreground">v{plugin.version}</span>
                      {hasUpdate && (
                        <span className="flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-semibold text-blue-400">
                          <ArrowUpCircleIcon className="h-2.5 w-2.5" />
                          v{catalogEntry.version} available
                        </span>
                      )}
                      {plugin.brandRequired && (
                        <span className="flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
                          <ShieldIcon className="h-2.5 w-2.5" />
                          Required
                        </span>
                      )}
                    </div>
                    <p className="truncate text-[11px] text-muted-foreground">{plugin.description}</p>
                    {plugin.error && (
                      <p className="mt-1 text-[10px] text-red-400">{plugin.error}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {hasUpdate && (
                      <button
                        type="button"
                        onClick={() => handleInstall(plugin.name)}
                        disabled={installingPlugins.has(plugin.name)}
                        className="flex items-center gap-1.5 rounded-lg bg-blue-500/20 border border-blue-500/30 px-3 py-1.5 text-[11px] font-medium text-blue-400 transition-colors hover:bg-blue-500/30 disabled:opacity-50"
                      >
                        {installingPlugins.has(plugin.name) ? (
                          <LoaderIcon className="h-3 w-3 animate-spin" />
                        ) : (
                          <ArrowUpCircleIcon className="h-3 w-3" />
                        )}
                        {installingPlugins.has(plugin.name) ? 'Updating...' : 'Update'}
                      </button>
                    )}
                    {!plugin.brandRequired && !plugin.required && (
                      <button
                        type="button"
                        onClick={() => handleUninstall(plugin.name)}
                        disabled={uninstallingPlugins.has(plugin.name)}
                        className="flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
                      >
                        {uninstallingPlugins.has(plugin.name) ? (
                          <LoaderIcon className="h-3 w-3 animate-spin" />
                        ) : (
                          <TrashIcon className="h-3 w-3" />
                        )}
                        {uninstallingPlugins.has(plugin.name) ? 'Removing...' : 'Uninstall'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Available plugins from marketplace */}
      {hasCatalog && availableCatalog.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Available ({availableCatalog.length})
          </h4>
          <div className="space-y-2">
            {availableCatalog.map((entry) => (
              <div
                key={entry.name}
                className="flex items-center gap-3 rounded-xl border border-border/70 bg-card/50 px-4 py-3"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                  <PackageIcon className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold">{entry.displayName}</span>
                    <span className="text-[10px] text-muted-foreground">v{entry.version}</span>
                    {entry.author && (
                      <span className="text-[10px] text-muted-foreground">by {entry.author}</span>
                    )}
                  </div>
                  <p className="truncate text-[11px] text-muted-foreground">{entry.description}</p>
                  {entry.tags && entry.tags.length > 0 && (
                    <div className="mt-1 flex gap-1">
                      {entry.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-muted/50 px-2 py-0.5 text-[9px] text-muted-foreground"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleInstall(entry.name)}
                  disabled={installingPlugins.has(entry.name)}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {installingPlugins.has(entry.name) ? (
                    <LoaderIcon className="h-3 w-3 animate-spin" />
                  ) : (
                    <DownloadIcon className="h-3 w-3" />
                  )}
                  {installingPlugins.has(entry.name) ? 'Installing...' : 'Install'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No results state */}
      {searchQuery && filteredInstalledPlugins.length === 0 && availableCatalog.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-12 text-center">
          <SearchIcon className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            No plugins found matching "{searchQuery}"
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            Try a different search term
          </p>
        </div>
      )}

      {/* Empty state */}
      {!hasCatalog && filteredInstalledPlugins.length === 0 && !searchQuery && (
        <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-12 text-center">
          <PackageIcon className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            No marketplace configured
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            Plugin marketplace URLs can be configured in the branding config.
          </p>
        </div>
      )}
    </div>
  );
};

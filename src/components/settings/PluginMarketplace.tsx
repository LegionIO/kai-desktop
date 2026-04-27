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

// Parse author string like "Name <https://example.com>" into {name, url}
function parseAuthor(author?: string): { name: string; url?: string } | null {
  if (!author) return null;
  const match = author.match(/^(.+?)\s*<(.+?)>$/);
  if (match) {
    return { name: match[1].trim(), url: match[2].trim() };
  }
  return { name: author.trim() };
}

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
  const [showRefreshTooltip, setShowRefreshTooltip] = useState(false);

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
    const startTime = Date.now();
    try {
      const refreshed = await app.plugins.marketplaceRefresh();
      setCatalog(refreshed);
      const pluginList = await app.plugins.list();
      setInstalledPlugins(pluginList);
      setError(null);

      // Ensure spinner shows for at least 1 second (2 full rotations at 0.5s per rotation)
      const elapsed = Date.now() - startTime;
      const minSpinTime = 1000;
      if (elapsed < minSpinTime) {
        await new Promise((resolve) => setTimeout(resolve, minSpinTime - elapsed));
      }

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
    <div className="space-y-4 px-3 py-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <SearchIcon className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search plugins..."
            className="h-8 w-full rounded-lg border border-sidebar-border/60 bg-sidebar-accent/50 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={handleRefresh}
            onMouseEnter={() => setShowRefreshTooltip(true)}
            onMouseLeave={() => setShowRefreshTooltip(false)}
            disabled={refreshing || justRefreshed}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors disabled:opacity-50 ${
              justRefreshed
                ? 'border-green-500/30 bg-green-500/10 text-green-400'
                : 'border-sidebar-border/60 bg-sidebar-accent/50 text-muted-foreground hover:text-primary'
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
          {showRefreshTooltip && !refreshing && !justRefreshed && (
            <div className="pointer-events-none absolute right-0 top-full mt-2 z-10 animate-in fade-in duration-150">
              <div className="whitespace-nowrap rounded-md bg-popover px-2 py-1 text-[10px] text-popover-foreground shadow-md">
                Refresh Plugins
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5">
          <AlertCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
          <p className="min-w-0 text-[11px] text-red-400">{error}</p>
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-auto shrink-0 text-[10px] text-red-400/70 hover:text-red-400"
          >
            ✕
          </button>
        </div>
      )}

      {/* Installed plugins */}
      {filteredInstalledPlugins.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Installed ({filteredInstalledPlugins.length})
          </h4>
          <div className="space-y-1.5">
            {filteredInstalledPlugins.map((plugin) => {
              const catalogEntry = catalogMap.get(plugin.name);
              const hasUpdate = catalogEntry && catalogEntry.version && isNewerVersion(catalogEntry.version, plugin.version);

              return (
                <div
                  key={plugin.name}
                  className="rounded-xl border border-sidebar-border/60 bg-sidebar-accent/30 px-3 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10">
                      <PackageIcon className="h-3 w-3 text-primary" />
                    </div>
                    <span className="truncate text-xs font-semibold text-sidebar-foreground">{plugin.displayName}</span>
                    {plugin.state === 'active' && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" title="Active" />
                    )}
                    {plugin.state === 'error' && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" title="Error" />
                    )}
                    {plugin.state === 'disabled' && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-yellow-500" title="Disabled" />
                    )}
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">v{plugin.version}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground/70">{plugin.description}</p>
                  {plugin.error && (
                    <p className="mt-1 text-[10px] text-red-400">{plugin.error}</p>
                  )}
                  {(hasUpdate || (!plugin.brandRequired && !plugin.required)) && (
                    <div className="mt-2 flex gap-1.5">
                      {hasUpdate && (
                        <button
                          type="button"
                          onClick={() => handleInstall(plugin.name)}
                          disabled={installingPlugins.has(plugin.name)}
                          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-blue-500/20 border border-blue-500/30 px-2 py-1.5 text-[10px] font-medium text-blue-400 transition-colors hover:bg-blue-500/30 disabled:opacity-50"
                        >
                          {installingPlugins.has(plugin.name) ? (
                            <LoaderIcon className="h-3 w-3 animate-spin" />
                          ) : (
                            <ArrowUpCircleIcon className="h-3 w-3" />
                          )}
                          {installingPlugins.has(plugin.name) ? 'Updating...' : `Update to v${catalogEntry!.version}`}
                        </button>
                      )}
                      {!plugin.brandRequired && !plugin.required && (
                        <button
                          type="button"
                          onClick={() => handleUninstall(plugin.name)}
                          disabled={uninstallingPlugins.has(plugin.name)}
                          className={`flex items-center justify-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50 ${hasUpdate ? '' : 'flex-1'}`}
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
                  )}
                  {plugin.brandRequired && (
                    <div className="mt-1.5 flex items-center gap-1 text-[10px] text-primary">
                      <ShieldIcon className="h-2.5 w-2.5" />
                      Required
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Available plugins from marketplace */}
      {hasCatalog && availableCatalog.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Available ({availableCatalog.length})
          </h4>
          <div className="space-y-1.5">
            {availableCatalog.map((entry) => (
              <div
                key={entry.name}
                className="rounded-xl border border-sidebar-border/60 bg-sidebar-accent/30 px-3 py-2.5"
              >
                <div className="flex items-center gap-2">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted/50">
                    <PackageIcon className="h-3 w-3 text-muted-foreground" />
                  </div>
                  <span className="truncate text-xs font-semibold text-sidebar-foreground">{entry.displayName}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">v{entry.version}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground/70">{entry.description}</p>
                {(() => {
                  const parsedAuthor = parseAuthor(entry.author);
                  if (!parsedAuthor) return null;
                  return (
                    <p className="mt-0.5 text-[10px] text-muted-foreground/60">
                      by{' '}
                      {parsedAuthor.url ? (
                        <a href={parsedAuthor.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                          {parsedAuthor.name}
                        </a>
                      ) : (
                        parsedAuthor.name
                      )}
                    </p>
                  );
                })()}
                {entry.tags && entry.tags.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {entry.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => handleInstall(entry.name)}
                  disabled={installingPlugins.has(entry.name)}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-2 py-1.5 text-[10px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
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
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <SearchIcon className="h-6 w-6 text-muted-foreground/40" />
          <p className="text-xs text-muted-foreground">
            No plugins matching &ldquo;{searchQuery}&rdquo;
          </p>
        </div>
      )}

      {/* Empty state */}
      {!hasCatalog && filteredInstalledPlugins.length === 0 && !searchQuery && (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <PackageIcon className="h-6 w-6 text-muted-foreground/40" />
          <p className="text-xs text-muted-foreground">No marketplace configured</p>
          <p className="text-[10px] text-muted-foreground/60">
            Plugin marketplace URLs can be configured in the branding config.
          </p>
        </div>
      )}
    </div>
  );
};

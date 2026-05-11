import { useState, useEffect, useCallback, useRef, type FC } from 'react';
import { RefreshCwIcon, DownloadIcon, PackageIcon, LoaderIcon, AlertCircleIcon, SearchIcon, XIcon, CheckIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { Tooltip } from '@/components/ui/Tooltip';

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

export const PluginMarketplace: FC = () => {
  const [catalog, setCatalog] = useState<MarketplaceEntry[]>([]);
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { const t = setTimeout(() => searchRef.current?.focus(), 50); return () => clearTimeout(t); }, []);
  const [refreshing, setRefreshing] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const [installingPlugins, setInstallingPlugins] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const loadData = useCallback(async () => {
    try {
      const [catalogData, pluginList] = await Promise.all([
        app.plugins.marketplaceCatalog(),
        app.plugins.list(),
      ]);
      setCatalog(catalogData);
      setInstalledNames(new Set(pluginList.map((p: { name: string }) => p.name)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load marketplace data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setJustRefreshed(false);
    const startTime = Date.now();
    try {
      const refreshed = await app.plugins.marketplaceRefresh();
      setCatalog(refreshed);
      const pluginList = await app.plugins.list();
      setInstalledNames(new Set(pluginList.map((p: { name: string }) => p.name)));
      setError(null);
      const elapsed = Date.now() - startTime;
      if (elapsed < 1000) await new Promise((r) => setTimeout(r, 1000 - elapsed));
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
      setInstallingPlugins((prev) => { const next = new Set(prev); next.delete(pluginName); return next; });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LoaderIcon className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading marketplace...</span>
      </div>
    );
  }

  const searchLower = searchQuery.toLowerCase();
  const availablePlugins = catalog
    .filter((entry) => !entry.installed && !installedNames.has(entry.name))
    .filter((entry) =>
      !searchLower ||
      entry.displayName.toLowerCase().includes(searchLower) ||
      entry.name.toLowerCase().includes(searchLower) ||
      entry.description.toLowerCase().includes(searchLower) ||
      entry.tags?.some((tag) => tag.toLowerCase().includes(searchLower))
    );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 pt-6 pb-6">
          {/* Glass card wrapping everything */}
          <div className="rounded-2xl border border-border/40 bg-background/60 backdrop-blur-md overflow-hidden">

            {/* Search + refresh */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border/40">
              <div className="flex flex-1 items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
                <SearchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  ref={searchRef}
                  type="text"
                  placeholder="Search marketplace…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setSearchQuery(''); }}
                  className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="shrink-0 rounded p-0.5 hover:bg-muted transition-colors"
                  >
                    <XIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                )}
              </div>
              <Tooltip content={justRefreshed ? 'Up to date' : 'Refresh catalog'} side="bottom">
                <button
                  type="button"
                  onClick={handleRefresh}
                  disabled={refreshing || justRefreshed}
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-50 ${
                    justRefreshed
                      ? 'text-green-400'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }`}
                >
                  {refreshing ? (
                    <RefreshCwIcon className="h-4 w-4 animate-spin" />
                  ) : justRefreshed ? (
                    <CheckIcon className="h-4 w-4" />
                  ) : (
                    <RefreshCwIcon className="h-4 w-4" />
                  )}
                </button>
              </Tooltip>
            </div>

            {/* Content */}
            <div className="p-3 space-y-2">

              {/* Available label */}
              {availablePlugins.length > 0 && (
                <p className="px-1 pt-1 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                  Available ({availablePlugins.length})
                </p>
              )}

            {/* Error banner */}
            {error && (
              <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
                <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                <p className="text-xs font-medium text-red-400">{error}</p>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="ml-auto shrink-0 text-xs text-red-400/70 hover:text-red-400"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* No catalog configured */}
            {catalog.length === 0 && !error && (
              <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-16 text-center">
                <PackageIcon className="mx-auto h-10 w-10 text-muted-foreground/40" />
                <p className="mt-4 text-sm text-muted-foreground">No marketplace configured</p>
                <p className="mt-1 text-xs text-muted-foreground/70">
                  Plugin marketplace URLs can be configured in the branding config.
                </p>
              </div>
            )}

            {/* No search results */}
            {catalog.length > 0 && availablePlugins.length === 0 && (
              <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-12 text-center">
                <PackageIcon className="mx-auto h-8 w-8 text-muted-foreground/40" />
                <p className="mt-3 text-sm text-muted-foreground">
                  {searchQuery
                    ? `No plugins found matching "${searchQuery}"`
                    : 'All available plugins are already installed'}
                </p>
              </div>
            )}

            {/* Plugin cards */}
            {availablePlugins.map((entry) => {
              const parsedAuthor = parseAuthor(entry.author);
              return (
                <div
                  key={entry.name}
                  className="flex items-center gap-3 rounded-xl border border-border/70 bg-card px-4 py-3 min-h-[80px]"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                    <PackageIcon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold">{entry.displayName}</span>
                      <span className="text-[10px] text-muted-foreground">v{entry.version}</span>
                      {parsedAuthor && (
                        <span className="text-[10px] text-muted-foreground">
                          by{' '}
                          {parsedAuthor.url ? (
                            <a
                              href={parsedAuthor.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline"
                            >
                              {parsedAuthor.name}
                            </a>
                          ) : (
                            parsedAuthor.name
                          )}
                        </span>
                      )}
                      {entry.tags && entry.tags.length > 0 && entry.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-muted/50 px-2 py-0.5 text-[9px] text-muted-foreground"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                    <p className="line-clamp-2 text-[11px] text-muted-foreground">{entry.description}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleInstall(entry.name)}
                    disabled={installingPlugins.has(entry.name)}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                  >
                    {installingPlugins.has(entry.name) ? (
                      <LoaderIcon className="h-3 w-3 animate-spin" />
                    ) : (
                      <DownloadIcon className="h-3 w-3" />
                    )}
                    {installingPlugins.has(entry.name) ? 'Installing…' : 'Install'}
                  </button>
                </div>
              );
            })}

            </div>{/* end content */}
          </div>{/* end glass card */}
        </div>{/* end max-w-3xl */}
      </div>{/* end overflow-y-auto */}
    </div>
  );
};

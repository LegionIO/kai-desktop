import { useState, useEffect, useCallback, useRef, type FC } from 'react';
import {
  RefreshCwIcon,
  DownloadIcon,
  PackageIcon,
  LoaderIcon,
  AlertCircleIcon,
  SearchIcon,
  XIcon,
  CheckIcon,
  ArrowUpCircleIcon,
} from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';
import { PluginRestartBanner } from '@/components/plugins/PluginRestartBanner';
import { useFullWidthContent } from '@/hooks/useFullWidthContent';

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

type MarketplaceTab = 'available' | 'updates';

function isNewerVersion(catalogVersion: string, installedVersion: string): boolean {
  const toNum = (v: string) => v.split('.').map(Number);
  const [cMajor = 0, cMinor = 0, cPatch = 0] = toNum(catalogVersion);
  const [iMajor = 0, iMinor = 0, iPatch = 0] = toNum(installedVersion);
  if (cMajor !== iMajor) return cMajor > iMajor;
  if (cMinor !== iMinor) return cMinor > iMinor;
  return cPatch > iPatch;
}

// Parse author string like "Name <https://example.com>" into {name, url}.
// The URL is only returned if it uses an allowlisted scheme (https:// or
// mailto:) — anything else (javascript:, data:, file:, etc.) is dropped so
// the caller renders plain text instead of a link.
function parseAuthor(author?: string): { name: string; url?: string } | null {
  if (!author) return null;
  const match = author.match(/^(.+?)\s*<(.+?)>$/);
  if (match) {
    const rawUrl = match[2].trim();
    const url = /^(https:\/\/|mailto:)/i.test(rawUrl) ? rawUrl : undefined;
    return { name: match[1].trim(), url };
  }
  return { name: author.trim() };
}

export const PluginMarketplace: FC = () => {
  const fullWidth = useFullWidthContent();
  const [catalog, setCatalog] = useState<MarketplaceEntry[]>([]);
  const [installedVersions, setInstalledVersions] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<MarketplaceTab>('available');

  useEffect(() => {
    const t = setTimeout(() => searchRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);
  const [refreshing, setRefreshing] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const [installingPlugins, setInstallingPlugins] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const loadData = useCallback(async () => {
    try {
      const [catalogData, pluginList] = await Promise.all([app.plugins.marketplaceCatalog(), app.plugins.list()]);
      setCatalog(catalogData);
      setInstalledVersions(new Map(pluginList.map((p: { name: string; version: string }) => [p.name, p.version])));
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
      setInstalledVersions(new Map(pluginList.map((p: { name: string; version: string }) => [p.name, p.version])));
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
      const result = await app.plugins.marketplaceInstall(pluginName);
      if (result.needsConfirmation) {
        const accepted = window.confirm(
          `"${result.pluginName ?? pluginName}" has no published integrity hash. ` +
            'Installing it means trusting whatever the download server returns. Install anyway?',
        );
        if (!accepted) {
          return;
        }
        await app.plugins.marketplaceInstallUnverified(pluginName);
      }
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LoaderIcon className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading marketplace...</span>
      </div>
    );
  }

  const searchLower = searchQuery.toLowerCase();

  const matchesSearch = (entry: MarketplaceEntry) =>
    !searchLower ||
    entry.displayName.toLowerCase().includes(searchLower) ||
    entry.name.toLowerCase().includes(searchLower) ||
    entry.description.toLowerCase().includes(searchLower) ||
    entry.tags?.some((tag) => tag.toLowerCase().includes(searchLower));

  const availablePlugins = catalog
    .filter((entry) => !entry.installed && !installedVersions.has(entry.name))
    .filter(matchesSearch);

  const updatablePlugins = catalog
    .filter((entry) => {
      if (!entry.installed && !installedVersions.has(entry.name)) return false;
      const liveVersion = installedVersions.get(entry.name) ?? entry.installedVersion;
      return liveVersion != null && isNewerVersion(entry.version, liveVersion);
    })
    .filter(matchesSearch);

  const updateCount = updatablePlugins.length;

  return (
    <div className="relative z-20 flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className={cn('mx-auto w-full px-4 pt-6 pb-6', !fullWidth && 'max-w-3xl')}>
          {/* Glass card wrapping everything */}
          <div className="rounded-2xl border border-border/40 bg-background/85 backdrop-blur-xl overflow-hidden">
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
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setSearchQuery('');
                  }}
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
                    justRefreshed ? 'text-green-400' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
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

            {/* Tab bar */}
            <div className="flex items-center gap-1 px-4 py-2 border-b border-border/40">
              <button
                type="button"
                onClick={() => setActiveTab('available')}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                  activeTab === 'available'
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                )}
              >
                Available
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('updates')}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                  activeTab === 'updates'
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                )}
              >
                Updates
                {updateCount > 0 && (
                  <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-bold text-white">
                    {updateCount}
                  </span>
                )}
              </button>
            </div>

            {/* Content */}
            <div className="p-3 space-y-2">
              <PluginRestartBanner />

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

              {/* ── Available Tab ── */}
              {activeTab === 'available' && (
                <>
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

                  {/* No search results / all installed */}
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

                  {/* Available plugin cards */}
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
                            {entry.tags &&
                              entry.tags.length > 0 &&
                              entry.tags.map((tag) => (
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
                </>
              )}

              {/* ── Updates Tab ── */}
              {activeTab === 'updates' && (
                <>
                  {updatablePlugins.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-12 text-center">
                      <CheckIcon className="mx-auto h-8 w-8 text-green-400/60" />
                      <p className="mt-3 text-sm text-muted-foreground">
                        {searchQuery ? `No updates found matching "${searchQuery}"` : 'All plugins are up to date'}
                      </p>
                    </div>
                  )}

                  {updatablePlugins.map((entry) => {
                    const parsedAuthor = parseAuthor(entry.author);
                    const currentVersion = installedVersions.get(entry.name) ?? entry.installedVersion;
                    return (
                      <div
                        key={entry.name}
                        className="flex items-center gap-3 rounded-xl border border-blue-500/30 bg-blue-500/5 px-4 py-3 min-h-[80px]"
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10">
                          <ArrowUpCircleIcon className="h-4 w-4 text-blue-400" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold">{entry.displayName}</span>
                            <span className="flex items-center gap-1 text-[10px]">
                              <span className="text-muted-foreground">v{currentVersion}</span>
                              <span className="text-muted-foreground/60">→</span>
                              <span className="font-medium text-blue-400">v{entry.version}</span>
                            </span>
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
                          </div>
                          <p className="line-clamp-2 text-[11px] text-muted-foreground">{entry.description}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleInstall(entry.name)}
                          disabled={installingPlugins.has(entry.name)}
                          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-blue-500/30 bg-blue-500/20 px-3 py-1.5 text-[11px] font-medium text-blue-400 transition-colors hover:bg-blue-500/30 disabled:opacity-50"
                        >
                          {installingPlugins.has(entry.name) ? (
                            <LoaderIcon className="h-3 w-3 animate-spin" />
                          ) : (
                            <ArrowUpCircleIcon className="h-3 w-3" />
                          )}
                          {installingPlugins.has(entry.name) ? 'Updating…' : 'Update'}
                        </button>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
            {/* end content */}
          </div>
          {/* end glass card */}
        </div>
        {/* end max-w-3xl */}
      </div>
      {/* end overflow-y-auto */}
    </div>
  );
};

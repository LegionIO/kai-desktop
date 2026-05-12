import { useState, useEffect, useCallback, useRef, type FC } from 'react';
import { createPortal } from 'react-dom';
import {
  PackageIcon,
  LoaderIcon,
  AlertCircleIcon,
  ArrowUpCircleIcon,
  TrashIcon,
  ShieldIcon,
  StoreIcon,
  SearchIcon,
  XIcon,
  Settings2Icon,
} from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';
import { usePlugins } from '@/providers/PluginProvider';
import { useFullWidthContent } from '@/hooks/useFullWidthContent';
import type { PluginNavigationTarget } from '@/providers/PluginProvider';

/* ── Types ────────────────────────────────────────────── */

type InstalledPlugin = {
  name: string;
  displayName: string;
  version: string;
  description: string;
  state: string;
  brandRequired: boolean;
  error?: string;
};

type MarketplaceEntry = {
  name: string;
  version: string;
};

function isNewerVersion(catalogVersion: string, installedVersion: string): boolean {
  const toNum = (v: string) => v.split('.').map(Number);
  const [cMajor, cMinor, cPatch] = toNum(catalogVersion);
  const [iMajor, iMinor, iPatch] = toNum(installedVersion);
  if (cMajor !== iMajor) return cMajor > iMajor;
  if (cMinor !== iMinor) return cMinor > iMinor;
  return cPatch > iPatch;
}

/* ── Component ───────────────────────────────────────── */

interface InstalledPluginsViewProps {
  onOpenMarketplace: () => void;
  onNavigate: (pluginName: string, target: PluginNavigationTarget) => void;
  onOpenPluginError: (pluginName: string) => void;
  onOpenPluginSettings: (pluginName: string) => void;
}

export const InstalledPluginsView: FC<InstalledPluginsViewProps> = ({ onOpenMarketplace, onNavigate, onOpenPluginError, onOpenPluginSettings }) => {
  const { uiState } = usePlugins();
  const fullWidth = useFullWidthContent();
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [catalog, setCatalog] = useState<MarketplaceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { const t = setTimeout(() => searchRef.current?.focus(), 50); return () => clearTimeout(t); }, []);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [installingPlugins, setInstallingPlugins] = useState<Set<string>>(new Set());
  const [uninstallingPlugins, setUninstallingPlugins] = useState<Set<string>>(new Set());
  const [confirmUninstall, setConfirmUninstall] = useState<InstalledPlugin | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [pluginList, catalogData] = await Promise.all([
        app.plugins.list(),
        app.plugins.marketplaceCatalog().catch(() => [] as MarketplaceEntry[]),
      ]);
      setPlugins(pluginList);
      setCatalog(catalogData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load plugins');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const catalogMap = new Map(catalog.map((e) => [e.name, e]));
  const navigationItems = uiState?.navigationItems?.filter((i) => i.visible) ?? [];

  const handlePluginClick = useCallback((plugin: InstalledPlugin) => {
    if (plugin.state === 'error') {
      onOpenPluginError(plugin.name);
      return;
    }
    const navItem = navigationItems.find((n) => n.pluginName === plugin.name);
    if (navItem) {
      onNavigate(navItem.pluginName, navItem.target);
    } else {
      onNavigate(plugin.name, { type: 'panel', panelId: 'default' });
    }
  }, [navigationItems, onNavigate, onOpenPluginError]);

  const handleInstall = async (pluginName: string) => {
    setInstallingPlugins((prev) => new Set([...prev, pluginName]));
    try {
      await app.plugins.marketplaceInstall(pluginName);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to update ${pluginName}`);
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

  const filteredPlugins = searchQuery.trim()
    ? plugins.filter((p) => {
        const q = searchQuery.toLowerCase();
        return (
          (p.displayName || p.name).toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q)
        );
      })
    : plugins;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LoaderIcon className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading plugins...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Search + marketplace button — fixed above scroll */}
      <div className="shrink-0 pt-6 pb-2">
        <div className={cn('mx-auto w-full px-4 flex items-center gap-2', !fullWidth && 'max-w-3xl')}>
          <div className="flex flex-1 items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
            <SearchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search plugins…"
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
          <Tooltip content="Browse Marketplace" side="bottom">
            <button
              type="button"
              onClick={onOpenMarketplace}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <StoreIcon className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Scrollable content with fade at top */}
      <div className="relative flex-1 min-h-0">
        {/* Fade overlay */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-10 bg-gradient-to-b from-background to-transparent" />

        {/* "Installed (N)" label floats above the fade */}
        {plugins.length > 0 && (
          <div className={cn('absolute inset-x-0 top-0 z-20 mx-auto w-full px-4 h-10 flex items-center', !fullWidth && 'max-w-3xl')}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              Installed ({filteredPlugins.length}{filteredPlugins.length !== plugins.length ? ` of ${plugins.length}` : ''})
            </p>
          </div>
        )}

        <div className="h-full overflow-y-auto">
          <div className={cn('mx-auto w-full px-4 pt-10 pb-6 space-y-3', !fullWidth && 'max-w-3xl')}>
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

            {/* Empty state */}
            {plugins.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-16 text-center">
                <PackageIcon className="mx-auto h-10 w-10 text-muted-foreground/40" />
                <p className="mt-4 text-sm text-muted-foreground">No plugins installed yet</p>
                <p className="mt-1 text-xs text-muted-foreground/70">
                  Discover and install plugins from the marketplace
                </p>
                <button
                  type="button"
                  onClick={onOpenMarketplace}
                  className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <StoreIcon className="h-3.5 w-3.5" />
                  Browse Marketplace
                </button>
              </div>
            ) : filteredPlugins.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-12 text-center">
                <PackageIcon className="mx-auto h-8 w-8 text-muted-foreground/40" />
                <p className="mt-3 text-sm text-muted-foreground">No plugins match your search</p>
              </div>
            ) : (
              <>
                {filteredPlugins.map((plugin) => {
                  const catalogEntry = catalogMap.get(plugin.name);
                  const hasUpdate =
                    catalogEntry &&
                    catalogEntry.version &&
                    isNewerVersion(catalogEntry.version, plugin.version);

                  return (
                    <div
                      key={plugin.name}
                      role="button"
                      tabIndex={0}
                      onClick={() => handlePluginClick(plugin)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handlePluginClick(plugin); }}
                      className="flex items-center gap-3 rounded-xl border border-border/70 bg-card/50 px-4 py-3 min-h-[80px] cursor-pointer transition-colors hover:bg-card/80 hover:border-border"
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                        <PackageIcon className="h-4 w-4 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
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
                        <p className="line-clamp-2 text-[11px] text-muted-foreground">{plugin.description}</p>
                        {plugin.error && (
                          <p className="mt-1 text-[10px] text-red-400">{plugin.error}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {hasUpdate && (
                          <Tooltip content={`Update to v${catalogEntry.version}`} side="bottom">
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); void handleInstall(plugin.name); }}
                              disabled={installingPlugins.has(plugin.name)}
                              className="flex items-center gap-1.5 rounded-lg border border-blue-500/30 bg-blue-500/20 px-3 py-1.5 text-[11px] font-medium text-blue-400 transition-colors hover:bg-blue-500/30 disabled:opacity-50"
                            >
                              {installingPlugins.has(plugin.name) ? (
                                <LoaderIcon className="h-3 w-3 animate-spin" />
                              ) : (
                                <ArrowUpCircleIcon className="h-3 w-3" />
                              )}
                              {installingPlugins.has(plugin.name) ? 'Updating…' : 'Update'}
                            </button>
                          </Tooltip>
                        )}
                        {uiState?.settingsSections?.some((s) => s.pluginName === plugin.name) && (
                          <Tooltip content="Settings" side="bottom">
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); onOpenPluginSettings(plugin.name); }}
                              className="flex items-center justify-center rounded-lg border border-border/60 bg-muted/30 p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                            >
                              <Settings2Icon className="h-3.5 w-3.5" />
                            </button>
                          </Tooltip>
                        )}
                        {!plugin.brandRequired && (
                          <Tooltip content="Uninstall" side="bottom">
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setConfirmUninstall(plugin); }}
                              disabled={uninstallingPlugins.has(plugin.name)}
                              className="flex items-center justify-center rounded-lg border border-red-500/30 bg-red-500/10 p-1.5 text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
                            >
                              {uninstallingPlugins.has(plugin.name) ? (
                                <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <TrashIcon className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </Tooltip>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            )}

          </div>{/* end space-y-3 */}
        </div>{/* end overflow-y-auto */}
      </div>{/* end relative flex-1 */}

      {/* Uninstall confirmation modal */}
      {confirmUninstall && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={() => setConfirmUninstall(null)}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-sm rounded-2xl border border-border/50 bg-popover/95 p-6 shadow-2xl backdrop-blur-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-foreground">Uninstall plugin</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              This will uninstall{' '}
              <span className="font-medium text-foreground">{confirmUninstall.displayName}</span>.
              This cannot be undone.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmUninstall(null)}
                disabled={uninstallingPlugins.has(confirmUninstall.name)}
                className="rounded-xl border border-border/70 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const name = confirmUninstall.name;
                  setConfirmUninstall(null);
                  void handleUninstall(name);
                }}
                disabled={uninstallingPlugins.has(confirmUninstall.name)}
                className="flex items-center gap-1.5 rounded-xl bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50"
              >
                <TrashIcon className="h-3.5 w-3.5" />
                Uninstall
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

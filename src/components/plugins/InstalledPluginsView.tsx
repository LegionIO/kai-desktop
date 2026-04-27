import { useState, useEffect, useCallback, type FC } from 'react';
import {
  PackageIcon,
  LoaderIcon,
  AlertCircleIcon,
  ArrowUpCircleIcon,
  TrashIcon,
  ShieldIcon,
  StoreIcon,
} from 'lucide-react';
import { app } from '@/lib/ipc-client';

/* ── Types ────────────────────────────────────────────── */

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
}

export const InstalledPluginsView: FC<InstalledPluginsViewProps> = ({ onOpenMarketplace }) => {
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [catalog, setCatalog] = useState<MarketplaceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installingPlugins, setInstallingPlugins] = useState<Set<string>>(new Set());
  const [uninstallingPlugins, setUninstallingPlugins] = useState<Set<string>>(new Set());

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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LoaderIcon className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading plugins...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-sm font-semibold">Installed Plugins</h3>
        <p className="text-xs text-muted-foreground">
          Manage your currently installed plugins
        </p>
      </div>

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
          <p className="mt-4 text-sm text-muted-foreground">
            No plugins installed yet
          </p>
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
      ) : (
        <div className="space-y-2">
          {plugins.map((plugin) => {
            const catalogEntry = catalogMap.get(plugin.name);
            const hasUpdate =
              catalogEntry &&
              catalogEntry.version &&
              isNewerVersion(catalogEntry.version, plugin.version);

            return (
              <div
                key={plugin.name}
                className="flex items-start gap-3 rounded-xl border border-border/70 bg-card/50 px-4 py-3"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <PackageIcon className="h-4 w-4 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold">
                      {plugin.displayName}
                    </span>
                    {plugin.state === 'active' && (
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-green-500"
                        title="Active"
                      />
                    )}
                    {plugin.state === 'error' && (
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-red-500"
                        title="Error"
                      />
                    )}
                    {plugin.state === 'disabled' && (
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-yellow-500"
                        title="Disabled"
                      />
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      v{plugin.version}
                    </span>
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
                  <p className="line-clamp-2 text-[11px] text-muted-foreground">
                    {plugin.description}
                  </p>
                  {plugin.error && (
                    <p className="mt-1 text-[10px] text-red-400">
                      {plugin.error}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  {hasUpdate && (
                    <button
                      type="button"
                      onClick={() => handleInstall(plugin.name)}
                      disabled={installingPlugins.has(plugin.name)}
                      className="flex items-center gap-1.5 rounded-lg border border-blue-500/30 bg-blue-500/20 px-3 py-1.5 text-[11px] font-medium text-blue-400 transition-colors hover:bg-blue-500/30 disabled:opacity-50"
                    >
                      {installingPlugins.has(plugin.name) ? (
                        <LoaderIcon className="h-3 w-3 animate-spin" />
                      ) : (
                        <ArrowUpCircleIcon className="h-3 w-3" />
                      )}
                      {installingPlugins.has(plugin.name)
                        ? 'Updating...'
                        : 'Update'}
                    </button>
                  )}
                  {!plugin.brandRequired && (
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
                      {uninstallingPlugins.has(plugin.name)
                        ? 'Removing...'
                        : 'Uninstall'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {/* Link to marketplace at bottom */}
          <div className="pt-2 text-center">
            <button
              type="button"
              onClick={onOpenMarketplace}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              <StoreIcon className="h-3.5 w-3.5" />
              Browse Marketplace for more plugins
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

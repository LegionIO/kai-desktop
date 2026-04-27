import { useState, useEffect, useCallback, type FC } from 'react';
import {
  AlertTriangleIcon,
  DownloadIcon,
  LoaderIcon,
  TrashIcon,
} from 'lucide-react';
import { app } from '@/lib/ipc-client';

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
  displayName: string;
  version: string;
};

/* ── Component ───────────────────────────────────────── */

interface BrokenPluginViewProps {
  pluginName: string;
  onUninstalled: () => void;
}

export const BrokenPluginView: FC<BrokenPluginViewProps> = ({
  pluginName,
  onUninstalled,
}) => {
  const [plugin, setPlugin] = useState<InstalledPlugin | null>(null);
  const [catalogEntry, setCatalogEntry] = useState<MarketplaceEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [reinstalling, setReinstalling] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [plugins, catalog] = await Promise.all([
        app.plugins.list(),
        app.plugins.marketplaceCatalog().catch(() => [] as MarketplaceEntry[]),
      ]);
      const found = plugins.find((p) => p.name === pluginName) ?? null;
      setPlugin(found);
      setCatalogEntry(catalog.find((e) => e.name === pluginName) ?? null);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [pluginName]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleReinstall = async () => {
    setReinstalling(true);
    setActionError(null);
    try {
      await app.plugins.marketplaceInstall(pluginName);
      await loadData();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Reinstall failed');
    } finally {
      setReinstalling(false);
    }
  };

  const handleUninstall = async () => {
    setUninstalling(true);
    setActionError(null);
    try {
      await app.plugins.marketplaceUninstall(pluginName);
      onUninstalled();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Uninstall failed');
      setUninstalling(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LoaderIcon className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!plugin) {
    return (
      <div className="rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-12 text-center text-sm text-muted-foreground">
        Plugin "{pluginName}" not found.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Error card */}
      <div className="rounded-2xl border border-red-500/20 bg-red-500/5 px-6 py-8">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-500/15">
            <AlertTriangleIcon className="h-5 w-5 text-red-400" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-foreground">
              {plugin.displayName} <span className="font-normal text-muted-foreground">v{plugin.version}</span>
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {plugin.description}
            </p>
            <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3">
              <p className="text-xs font-medium text-red-400">
                This plugin failed to load
              </p>
              {plugin.error && (
                <p className="mt-1 break-all font-mono text-[11px] text-red-400/80">
                  {plugin.error}
                </p>
              )}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Try reinstalling from the marketplace. If the problem persists, the plugin may need to be updated by its author.
            </p>
          </div>
        </div>
      </div>

      {/* Action error */}
      {actionError && (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
          <p className="text-xs font-medium text-red-400">{actionError}</p>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="ml-auto shrink-0 text-xs text-red-400/70 hover:text-red-400"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        {catalogEntry && (
          <button
            type="button"
            onClick={handleReinstall}
            disabled={reinstalling}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {reinstalling ? (
              <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <DownloadIcon className="h-3.5 w-3.5" />
            )}
            {reinstalling ? 'Reinstalling...' : 'Reinstall'}
          </button>
        )}
        {!plugin.brandRequired && (
          <button
            type="button"
            onClick={handleUninstall}
            disabled={uninstalling}
            className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
          >
            {uninstalling ? (
              <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <TrashIcon className="h-3.5 w-3.5" />
            )}
            {uninstalling ? 'Uninstalling...' : 'Uninstall'}
          </button>
        )}
      </div>
    </div>
  );
};

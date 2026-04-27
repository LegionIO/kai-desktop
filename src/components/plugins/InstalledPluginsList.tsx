import { useState, useEffect, type FC } from 'react';
import { PlusIcon, SearchIcon, PuzzleIcon, XIcon } from 'lucide-react';
import { usePlugins } from '@/providers/PluginProvider';
import { getPluginNavigationIcon } from '@/components/plugins/plugin-icons';
import type { PluginNavigationTarget } from '@/providers/PluginProvider';
import { app } from '@/lib/ipc-client';
import { cn } from '@/lib/utils';

/* ── Types ────────────────────────────────────────────── */

type PluginListEntry = {
  name: string;
  displayName: string;
  version: string;
  description: string;
  state: string;
  required: boolean;
  brandRequired: boolean;
  error?: string;
};

interface InstalledPluginsListProps {
  activeView: string;
  onNavigate: (
    pluginName: string,
    target: PluginNavigationTarget,
  ) => void;
  onOpenMarketplace: () => void;
  onOpenPlugins: () => void;
}

/* ── Status dot color map ────────────────────────────── */

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-emerald-400',
  loading: 'bg-yellow-400',
  error: 'bg-red-400',
  disabled: 'bg-muted-foreground/40',
};

/* ── Component ───────────────────────────────────────── */

export const InstalledPluginsList: FC<InstalledPluginsListProps> = ({
  activeView,
  onNavigate,
  onOpenMarketplace,
  onOpenPlugins,
}) => {
  const { uiState, getPluginStatus } = usePlugins();
  const [plugins, setPlugins] = useState<PluginListEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    app.plugins.list().then((list) => {
      if (!cancelled) setPlugins(list);
    });
    return () => { cancelled = true; };
  }, [uiState]);

  const navigationItems = uiState?.navigationItems?.filter((i) => i.visible) ?? [];

  const isSearchActive = searchQuery.trim().length > 0;
  const filteredPlugins = isSearchActive
    ? plugins.filter((p) => {
        const q = searchQuery.toLowerCase();
        return (
          (p.displayName || p.name).toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q)
        );
      })
    : plugins;

  return (
    <div className="flex flex-col h-full">
      {/* + New Plugin button */}
      <div className="border-b border-sidebar-border/70 px-4 py-3">
        <button
          type="button"
          onClick={onOpenMarketplace}
          className={cn(
            'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent/80',
            activeView === 'marketplace' && 'bg-primary/10 text-primary',
          )}
        >
          <PlusIcon className="h-4 w-4 text-primary" />
          Install Plugin
        </button>
      </div>

      {/* PLUGINS header */}
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <button
          type="button"
          onClick={onOpenPlugins}
          className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground hover:text-primary transition-colors"
        >
          Plugins
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pb-3">
        <div className="flex items-center gap-2 rounded-xl border border-sidebar-border/60 bg-sidebar-accent/50 px-3 py-2">
          <SearchIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-transparent text-xs text-sidebar-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="shrink-0 p-0.5 rounded hover:bg-sidebar-accent transition-colors"
            >
              <XIcon className="h-3 w-3 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>

      {/* Plugin list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {filteredPlugins.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-xs text-muted-foreground">
            <PuzzleIcon className="h-6 w-6 opacity-40" />
            <span>{isSearchActive ? 'No plugins match your search' : 'No plugins installed'}</span>
            {!isSearchActive && (
              <button
                type="button"
                onClick={onOpenMarketplace}
                className="mt-1 text-primary hover:underline text-xs"
              >
                Browse Marketplace
              </button>
            )}
          </div>
        ) : (
          filteredPlugins.map((plugin) => {
            const status = getPluginStatus(plugin.name);
            const navItem = navigationItems.find((n) => n.pluginName === plugin.name);
            const isClickable = !!navItem;

            const isActive =
              navItem?.target.type === 'panel' &&
              activeView === `plugin-panel:${plugin.name}:${navItem.target.panelId}`;

            return (
              <button
                key={plugin.name}
                type="button"
                disabled={!isClickable}
                onClick={() => {
                  if (navItem) onNavigate(navItem.pluginName, navItem.target);
                }}
                className={cn(
                  'group flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors',
                  isClickable && 'hover:bg-sidebar-accent/60 cursor-pointer',
                  !isClickable && 'cursor-default',
                  isActive && 'bg-primary/10',
                )}
              >
                {/* Icon */}
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
                  {navItem ? getPluginNavigationIcon(navItem.icon) : <PuzzleIcon className="h-[18px] w-[18px]" />}
                </span>

                {/* Text content */}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5">
                    <span className={cn(
                      'truncate text-xs font-medium',
                      isActive ? 'text-primary' : 'text-sidebar-foreground',
                    )}>
                      {plugin.displayName || plugin.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/70">
                      {plugin.version}
                    </span>
                    {/* Status dot */}
                    <span
                      className={cn(
                        'ml-auto h-1.5 w-1.5 shrink-0 rounded-full',
                        STATUS_COLORS[status] ?? STATUS_COLORS.disabled,
                      )}
                      title={status}
                    />
                    {/* Badge */}
                    {navItem?.badge != null && (
                      <span className="flex h-3.5 min-w-[14px] shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[8px] font-bold text-primary-foreground">
                        {navItem.badge}
                      </span>
                    )}
                  </span>
                  {plugin.description && (
                    <span className="line-clamp-1 text-[11px] text-muted-foreground/70">
                      {plugin.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};

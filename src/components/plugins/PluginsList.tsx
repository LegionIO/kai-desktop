import { useState, useEffect, type FC } from 'react';
import { PuzzleIcon } from 'lucide-react';
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

interface PluginsListProps {
  activeView: string;
  onNavigate: (
    pluginName: string,
    target: PluginNavigationTarget,
  ) => void;
}

/* ── Status dot color map ────────────────────────────── */

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-emerald-400',
  loading: 'bg-yellow-400',
  error: 'bg-red-400',
  disabled: 'bg-muted-foreground/40',
};

/* ── Component ───────────────────────────────────────── */

export const PluginsList: FC<PluginsListProps> = ({ activeView, onNavigate }) => {
  const { uiState, getPluginStatus } = usePlugins();
  const [plugins, setPlugins] = useState<PluginListEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    app.plugins.list().then((list) => {
      if (!cancelled) setPlugins(list);
    });
    return () => { cancelled = true; };
  }, [uiState]);

  const navigationItems = uiState?.navigationItems?.filter((i) => i.visible) ?? [];

  if (plugins.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-xs text-muted-foreground">
        <PuzzleIcon className="h-6 w-6 opacity-40" />
        <span>No plugins installed</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col py-1">
      {plugins.map((plugin) => {
        const status = getPluginStatus(plugin.name);
        const navItem = navigationItems.find((n) => n.pluginName === plugin.name);
        const isClickable = !!navItem;

        /* Build a view key so we can highlight the active plugin panel */
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
      })}
    </div>
  );
};

import { useState, useEffect, useCallback, type FC } from 'react';
import { createPortal } from 'react-dom';
import { SearchIcon, PuzzleIcon, XIcon, CompassIcon, PinIcon, EllipsisVerticalIcon, Trash2Icon, LoaderIcon, Settings2Icon } from 'lucide-react';
import { usePlugins } from '@/providers/PluginProvider';
import { getPluginNavigationIcon } from '@/components/plugins/plugin-icons';
import type { PluginNavigationTarget } from '@/providers/PluginProvider';
import { app } from '@/lib/ipc-client';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';

/* ── Types ────────────────────────────────────────────── */

type PluginListEntry = {
  name: string;
  displayName: string;
  version: string;
  description: string;
  state: string;
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
  onOpenPluginError: (pluginName: string) => void;
}

const PINNED_PLUGINS_KEY = __BRAND_APP_SLUG + ':pinned-plugins';

/* ── Component ───────────────────────────────────────── */

export const InstalledPluginsList: FC<InstalledPluginsListProps> = ({
  activeView,
  onNavigate,
  onOpenMarketplace,
  onOpenPlugins,
  onOpenPluginError,
}) => {
  const { uiState } = usePlugins();
  const [plugins, setPlugins] = useState<PluginListEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [pinnedNames, setPinnedNames] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(PINNED_PLUGINS_KEY) || '[]')); } catch { return new Set(); }
  });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; pluginName: string } | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  const [isUninstalling, setIsUninstalling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    app.plugins.list().then((list) => {
      if (!cancelled) setPlugins(list);
    });
    return () => { cancelled = true; };
  }, [uiState]);

  // Sync pin state from other components (e.g. title bar dropdown)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as string;
      try { setPinnedNames(new Set(JSON.parse(detail))); } catch { /* ignore */ }
    };
    window.addEventListener('pinned-plugins-changed', handler);
    return () => window.removeEventListener('pinned-plugins-changed', handler);
  }, []);

  const togglePin = useCallback((name: string) => {
    setPinnedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      const serialized = JSON.stringify([...next]);
      localStorage.setItem(PINNED_PLUGINS_KEY, serialized);
      window.dispatchEvent(new CustomEvent('pinned-plugins-changed', { detail: serialized }));
      return next;
    });
  }, []);

  const handleUninstall = useCallback(async (pluginName: string) => {
    setIsUninstalling(true);
    try {
      await app.plugins.marketplaceUninstall(pluginName);
      // Navigate away from the plugin view if we were looking at it
      onOpenMarketplace();
    } catch (err) {
      console.error('[InstalledPluginsList] Uninstall failed:', err);
    } finally {
      setIsUninstalling(false);
      setConfirmUninstall(null);
    }
  }, [onOpenMarketplace]);

  const handleContextMenu = useCallback((e: React.MouseEvent, pluginName: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, pluginName });
  }, []);

  const handleMoreClick = useCallback((e: React.MouseEvent<HTMLButtonElement>, pluginName: string) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu({ x: rect.left, y: rect.bottom + 4, pluginName });
  }, []);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close); };
  }, [contextMenu]);

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

  const pinned = filteredPlugins.filter((p) => pinnedNames.has(p.name));
  const unpinned = filteredPlugins.filter((p) => !pinnedNames.has(p.name));

  const renderPluginItem = (plugin: PluginListEntry) => {
    const navItem = navigationItems.find((n) => n.pluginName === plugin.name);
    const isErrored = plugin.state === 'error';
    const isPinned = pinnedNames.has(plugin.name);

    const isActive = navItem?.target.type === 'panel'
      ? activeView === `plugin-panel:${plugin.name}:${navItem.target.panelId}`
      : isErrored && activeView === `plugin-error:${plugin.name}`
        ? true
        : !navItem && !isErrored && activeView === `plugin-panel:${plugin.name}:default`;

    return (
      <div key={plugin.name} className="mb-1.5">
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            if (navItem) {
              onNavigate(navItem.pluginName, navItem.target);
            } else if (isErrored) {
              onOpenPluginError(plugin.name);
            } else {
              // Plugin has no nav item and isn't errored — open a default placeholder panel
              onNavigate(plugin.name, { type: 'panel', panelId: 'default' });
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (navItem) onNavigate(navItem.pluginName, navItem.target);
              else if (isErrored) onOpenPluginError(plugin.name);
              else onNavigate(plugin.name, { type: 'panel', panelId: 'default' });
            }
          }}
          onContextMenu={(e) => handleContextMenu(e, plugin.name)}
          className={cn(
            'group flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left transition-all cursor-pointer relative',
            isActive
              ? 'shadow-[inset_0_0_0_1px_var(--app-active-item-ring)]'
              : 'hover:bg-sidebar-accent/65',
          )}
          style={isActive ? { backgroundColor: 'var(--app-active-item)' } : undefined}
        >
          {/* Icon */}
          <span className={cn(
            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center',
            isActive ? 'text-primary' : 'text-muted-foreground',
          )}>
            {navItem ? getPluginNavigationIcon(navItem.icon) : <PuzzleIcon className="h-4 w-4" />}
          </span>

          {/* Text content */}
          <div className="flex-1 min-w-0">
            <span className={cn(
              'line-clamp-2 text-sm font-medium',
              isActive ? 'text-primary' : 'text-sidebar-foreground/95',
            )}>
              {plugin.displayName || plugin.name}
            </span>
            <span className="mt-1 flex items-center text-[12px] text-muted-foreground">
              {plugin.version}
            </span>
          </div>

          {/* Right side indicators */}
          <div className="ml-1 flex shrink-0 self-stretch items-center gap-1">
            {/* Badge */}
            {navItem?.badge != null && (
              <span className="flex h-3.5 min-w-[14px] shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[8px] font-bold text-primary-foreground">
                {navItem.badge}
              </span>
            )}
            {isPinned && <PinIcon className="h-3 w-3 text-muted-foreground" />}
            <button
              type="button"
              onClick={(e) => handleMoreClick(e, plugin.name)}
              className="shrink-0 rounded p-0.5 opacity-0 transition-all group-hover:opacity-100 hover:bg-sidebar-accent"
              title="More options"
              aria-label="More options"
            >
              <EllipsisVerticalIcon className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Browse Plugins button */}
      <div className="border-b border-sidebar-border/70 px-4 py-3">
        <button
          type="button"
          onClick={onOpenMarketplace}
          className={cn(
            'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent/80',
            activeView === 'marketplace' && 'bg-primary/10 text-primary',
          )}
        >
          <CompassIcon className="h-4 w-4 text-primary" />
          Browse Plugins
        </button>
      </div>

      {/* PLUGINS header */}
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Plugins
        </span>
        <div className="flex items-center gap-1 text-muted-foreground">
          <Tooltip content="Manage plugins" side="bottom" sideOffset={6}>
            <button
              type="button"
              onClick={onOpenPlugins}
              className="rounded-md p-1.5 transition-colors hover:bg-sidebar-accent/80 hover:text-primary"
            >
              <Settings2Icon className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
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
      <div className="flex-1 overflow-y-auto px-3">
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
          <>
            {pinned.length > 0 && (
              <div>
                <div className="flex items-center gap-2 px-1 pb-1 pt-2">
                  <PinIcon className="h-2.5 w-2.5 text-primary/60" />
                  <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">Pinned</span>
                </div>
                {pinned.map(renderPluginItem)}
              </div>
            )}
            {unpinned.map(renderPluginItem)}
          </>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (() => {
        const ctxPlugin = plugins.find((p) => p.name === contextMenu.pluginName);
        return createPortal(
          <div
            className="fixed z-[9999] min-w-[180px] rounded-2xl border border-border bg-popover p-1.5 shadow-2xl"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-popover-foreground hover:bg-muted/70 transition-colors"
              onClick={() => { togglePin(contextMenu.pluginName); setContextMenu(null); }}
            >
              <PinIcon className="h-4 w-4 text-muted-foreground" /> {pinnedNames.has(contextMenu.pluginName) ? 'Unpin' : 'Pin'}
            </button>
            {ctxPlugin && !ctxPlugin.brandRequired && (
              <>
                <div className="my-1 h-px bg-border/60" />
                <button
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
                  onClick={() => { setConfirmUninstall(contextMenu.pluginName); setContextMenu(null); }}
                >
                  <Trash2Icon className="h-4 w-4" /> Uninstall
                </button>
              </>
            )}
          </div>,
          document.body,
        );
      })()}

      {/* Uninstall confirmation modal */}
      {confirmUninstall && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setConfirmUninstall(null)}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-sm rounded-xl border border-border/50 bg-popover/95 p-6 shadow-2xl backdrop-blur-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-foreground">Uninstall plugin</h2>
            <p className="mt-2 text-xs text-muted-foreground">
              This will uninstall{' '}
              <span className="font-medium text-foreground">
                {plugins.find((p) => p.name === confirmUninstall)?.displayName || confirmUninstall}
              </span>
              . This cannot be undone.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmUninstall(null)}
                disabled={isUninstalling}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/80"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { void handleUninstall(confirmUninstall); }}
                disabled={isUninstalling}
                className="flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50"
              >
                {isUninstalling ? (
                  <>
                    <LoaderIcon className="h-3 w-3 animate-spin" />
                    Uninstalling...
                  </>
                ) : (
                  <>
                    <Trash2Icon className="h-3 w-3" />
                    Uninstall
                  </>
                )}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

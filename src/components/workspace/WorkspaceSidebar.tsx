import { useMemo, type FC } from 'react';
import {
  LayoutGridIcon,
  MessageSquareIcon,
  PuzzleIcon,
  FolderOpenIcon,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import type { WorkspaceEngine, PluginSidebarItem } from '../../../shared/workspace-types';

/* ── Engine navigation entries ─────────────────────────── */

interface EngineNavItem {
  engine: WorkspaceEngine;
  label: string;
  Icon: LucideIcon;
}

const ENGINE_NAV: EngineNavItem[] = [
  { engine: 'kanban', label: 'Kanban', Icon: LayoutGridIcon },
  { engine: 'prompt', label: 'Prompt', Icon: MessageSquareIcon },
  { engine: 'plugins', label: 'Plugins', Icon: PuzzleIcon },
];

/* ── Component ─────────────────────────────────────────── */

export const WorkspaceSidebar: FC = () => {
  const { project, setProject, activeEngine, setActiveEngine, plugins } = useWorkspace();

  const pluginSidebarItems = useMemo(() => {
    const items: Array<PluginSidebarItem & { pluginId: string }> = [];
    for (const plugin of plugins) {
      if (!plugin.enabled || !plugin.sidebarItems) continue;
      for (const item of plugin.sidebarItems) {
        items.push({ ...item, pluginId: plugin.id });
      }
    }
    return items;
  }, [plugins]);

  return (
    <div className="flex flex-col">
      {/* Project header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-sidebar-border/80">
        {project ? (
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-sidebar-foreground">{project.name}</p>
            <p className="truncate text-[10px] text-muted-foreground/60">{project.path}</p>
          </div>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <FolderOpenIcon className="h-3.5 w-3.5" />
            No Project
          </span>
        )}
      </div>

      {/* Engine navigation */}
      <nav className="flex flex-col gap-0.5 p-2">
        {ENGINE_NAV.map(({ engine, label, Icon }) => (
          <button
            key={engine}
            type="button"
            onClick={() => setActiveEngine(engine)}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors',
              activeEngine === engine
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
            )}
          >
            <Icon className="h-[16px] w-[16px]" />
            {label}
          </button>
        ))}
      </nav>

      {/* Plugin sidebar items */}
      {pluginSidebarItems.length > 0 && (
        <>
          <div className="mx-3 h-px bg-sidebar-border/80" />
          <div className="p-2">
            <p className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
              Plugins
            </p>
            <nav className="flex flex-col gap-0.5">
              {pluginSidebarItems.map((item) => (
                <button
                  key={`${item.pluginId}-${item.id}`}
                  type="button"
                  onClick={() => setActiveEngine(`plugin:${item.pluginId}:${item.id}`)}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors',
                    activeEngine === `plugin:${item.pluginId}:${item.id}`
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                  )}
                >
                  <PuzzleIcon className="h-[16px] w-[16px]" />
                  {item.label}
                </button>
              ))}
            </nav>
          </div>
        </>
      )}

      {/* Close project link */}
      {project && (
        <div className="mt-auto border-t border-sidebar-border/80 px-3 py-2">
          <button
            type="button"
            onClick={() => setProject(null)}
            className="text-[10px] text-muted-foreground/50 transition-colors hover:text-muted-foreground"
          >
            Close project
          </button>
        </div>
      )}
    </div>
  );
};

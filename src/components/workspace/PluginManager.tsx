import { useState, useMemo, type FC } from 'react';
import {
  ToggleLeftIcon,
  ToggleRightIcon,
  Trash2Icon,
  SettingsIcon,
  PackageIcon,
  GitBranchIcon,
  FlagIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import type { InstalledPlugin, WorkspacePlugin } from '../../../shared/workspace-types';

/* ── Sample plugin catalog ─────────────────────────────── */

const SAMPLE_PLUGINS: WorkspacePlugin[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Sync issues, PRs, and reviews with your kanban board.',
    version: '1.0.0',
    icon: 'github',
    capabilities: [
      { id: 'list-issues', name: 'List Issues', description: 'Fetch open issues from a GitHub repository.' },
      { id: 'create-issue', name: 'Create Issue', description: 'Create a new issue in a GitHub repository.' },
      { id: 'list-prs', name: 'List Pull Requests', description: 'Fetch open pull requests.' },
    ],
    settings: [
      { id: 'token', label: 'Personal Access Token', type: 'password', required: true, placeholder: 'ghp_...' },
      { id: 'repo', label: 'Repository (owner/name)', type: 'string', required: true, placeholder: 'owner/repo' },
    ],
    sidebarItems: [{ id: 'github-issues', label: 'Issues', icon: 'github' }],
  },
  {
    id: 'rally',
    name: 'Rally',
    description: 'Import Rally stories and defects into your workspace tasks.',
    version: '1.0.0',
    icon: 'flag',
    capabilities: [
      { id: 'import-stories', name: 'Import Stories', description: 'Pull user stories from a Rally project.' },
      { id: 'sync-status', name: 'Sync Status', description: 'Push task status changes back to Rally.' },
    ],
    settings: [
      { id: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Rally API key' },
      { id: 'project', label: 'Project Name', type: 'string', required: true, placeholder: 'My Project' },
    ],
  },
];

const ICON_MAP: Record<string, FC<{ className?: string }>> = {
  github: GitBranchIcon,
  flag: FlagIcon,
};

function getPluginIcon(iconKey: string): FC<{ className?: string }> {
  return ICON_MAP[iconKey] ?? PackageIcon;
}

/* ── Component ─────────────────────────────────────────── */

export const PluginManager: FC = () => {
  const { plugins, installPlugin, removePlugin, togglePlugin } = useWorkspace();
  const [activeTab, setActiveTab] = useState<'installed' | 'browse'>('installed');

  const availablePlugins = useMemo(
    () => SAMPLE_PLUGINS.filter((sp) => !plugins.some((ip) => ip.id === sp.id)),
    [plugins],
  );

  const handleInstall = (plugin: WorkspacePlugin) => {
    const installed: InstalledPlugin = { ...plugin, enabled: true, config: {} };
    installPlugin(installed);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 border-b border-border/70 px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">Plugins</h2>
        <div className="flex gap-1 rounded-lg bg-muted/20 p-0.5">
          {(['installed', 'browse'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={cn(
                'rounded-md px-3 py-1 text-[11px] font-medium capitalize transition-colors',
                activeTab === tab
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {activeTab === 'installed' ? (
          <InstalledList plugins={plugins} onToggle={togglePlugin} onRemove={removePlugin} />
        ) : (
          <BrowseList plugins={availablePlugins} onInstall={handleInstall} />
        )}
      </div>
    </div>
  );
};

/* ── Installed plugins list ────────────────────────────── */

const InstalledList: FC<{
  plugins: InstalledPlugin[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}> = ({ plugins, onToggle, onRemove }) => {
  if (plugins.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <PackageIcon className="h-8 w-8 text-muted-foreground/30" />
        <p className="text-xs text-muted-foreground">No plugins installed yet.</p>
        <p className="text-[11px] text-muted-foreground/60">Browse the catalog to add integrations.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {plugins.map((plugin) => {
        const Icon = getPluginIcon(plugin.icon);
        return (
          <div
            key={plugin.id}
            className="group flex items-start gap-3 rounded-lg border border-border/50 bg-card/50 p-3 transition-colors hover:border-border"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/30">
              <Icon className="h-[18px] w-[18px] text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">{plugin.name}</span>
                <span className="text-[10px] text-muted-foreground/60">v{plugin.version}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">{plugin.description}</p>
              <p className="mt-1 text-[10px] text-muted-foreground/50">
                {plugin.capabilities.length} {plugin.capabilities.length === 1 ? 'capability' : 'capabilities'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => onToggle(plugin.id)}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/40"
                title={plugin.enabled ? 'Disable' : 'Enable'}
              >
                {plugin.enabled ? (
                  <ToggleRightIcon className="h-[18px] w-[18px] text-primary" />
                ) : (
                  <ToggleLeftIcon className="h-[18px] w-[18px]" />
                )}
              </button>
              <button
                type="button"
                className="rounded-md p-1 text-muted-foreground/40 transition-colors hover:bg-muted/40 hover:text-muted-foreground"
                title="Plugin settings"
              >
                <SettingsIcon className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onRemove(plugin.id)}
                className="rounded-md p-1 text-muted-foreground/40 opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                title="Remove plugin"
              >
                <Trash2Icon className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};

/* ── Browse catalog ────────────────────────────────────── */

const BrowseList: FC<{
  plugins: WorkspacePlugin[];
  onInstall: (plugin: WorkspacePlugin) => void;
}> = ({ plugins, onInstall }) => {
  if (plugins.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <PackageIcon className="h-8 w-8 text-muted-foreground/30" />
        <p className="text-xs text-muted-foreground">All available plugins are installed.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {plugins.map((plugin) => {
        const Icon = getPluginIcon(plugin.icon);
        return (
          <div
            key={plugin.id}
            className="flex flex-col rounded-lg border border-border/50 bg-card/50 p-4 transition-colors hover:border-border"
          >
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/30">
                <Icon className="h-[18px] w-[18px] text-muted-foreground" />
              </div>
              <div>
                <div className="text-sm font-medium text-foreground">{plugin.name}</div>
                <div className="text-[10px] text-muted-foreground/60">v{plugin.version}</div>
              </div>
            </div>
            <p className="mt-2 flex-1 text-xs text-muted-foreground leading-relaxed">
              {plugin.description}
            </p>
            <div className="mt-2 text-[10px] text-muted-foreground/50">
              {plugin.capabilities.length} {plugin.capabilities.length === 1 ? 'capability' : 'capabilities'}
              {plugin.settings.length > 0 && ` / ${plugin.settings.length} settings`}
            </div>
            <button
              type="button"
              onClick={() => onInstall(plugin)}
              className="mt-3 w-full rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
            >
              Install
            </button>
          </div>
        );
      })}
    </div>
  );
};

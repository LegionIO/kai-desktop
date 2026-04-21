import { useState, useMemo, type FC } from 'react';
import {
  GitBranchIcon,
  GitCompareIcon,
  SparklesIcon,
  FileTextIcon,
  BookOpenIcon,
  PuzzleIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import { TaskQuickInput } from './TaskQuickInput';
import { RepositorySelector } from './RepositorySelector';
import type { WorkspaceEngine, PluginSidebarItem, TaskStatus } from '../../../shared/workspace-types';

/* ── Status section config ───────────────────────────────── */

interface StatusSection {
  key: string;
  label: string;
  statuses: TaskStatus[];
  color: string;
  defaultOpen?: boolean;
}

const TASK_SECTIONS: StatusSection[] = [
  { key: 'defining', label: 'Defining', statuses: ['defining'], color: 'text-slate-400' },
  { key: 'planning', label: 'Planning', statuses: ['planning', 'queued'], color: 'text-indigo-400' },
  { key: 'executing', label: 'Executing', statuses: ['executing', 'needs_input', 'in_progress'], color: 'text-blue-400', defaultOpen: true },
  { key: 'review', label: 'Review', statuses: ['review', 'ai_review', 'human_review'], color: 'text-purple-400' },
  { key: 'done', label: 'Done', statuses: ['done', 'rejected'], color: 'text-emerald-400' },
];

interface WorkspaceNavItem {
  engine: WorkspaceEngine;
  label: string;
  Icon: LucideIcon;
}

const WORKSPACE_NAV: WorkspaceNavItem[] = [
  { engine: 'git', label: 'Git', Icon: GitCompareIcon },
  { engine: 'analysis', label: 'Analysis', Icon: SparklesIcon },
  { engine: 'changelog', label: 'Changelog', Icon: FileTextIcon },
  { engine: 'context', label: 'Context', Icon: BookOpenIcon },
  { engine: 'worktrees', label: 'Worktrees', Icon: GitBranchIcon },
];

/* ── Component ─────────────────────────────────────────── */

export const WorkspaceSidebar: FC = () => {
  const {
    project, setProject, activeEngine, setActiveEngine,
    selectedTaskId, setSelectedTaskId,
    tasks, taskExecutions, plugins, engineStreams,
    addTask,
  } = useWorkspace();

  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(TASK_SECTIONS.filter((s) => s.defaultOpen).map((s) => s.key)),
  );

  // Group tasks by section
  const sectionTasks = useMemo(() => {
    const map: Record<string, typeof tasks> = {};
    for (const section of TASK_SECTIONS) {
      map[section.key] = [];
    }
    for (const task of tasks) {
      // Skip archived tasks
      if (task.archivedAt) continue;
      const section = TASK_SECTIONS.find((s) => s.statuses.includes(task.status));
      if (section) (map[section.key] ??= []).push(task);
    }
    return map;
  }, [tasks]);

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleTaskClick = (taskId: string) => {
    setSelectedTaskId(taskId);
    setActiveEngine('task-thread');
  };

  // Plugin sidebar items
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

  if (!project) {
    return (
      <div className="relative flex h-full flex-col overflow-hidden">
        <div className="shrink-0">
          <RepositorySelector />
        </div>
        <div className="flex flex-1 items-center justify-center px-4 text-center">
          <p className="text-xs text-muted-foreground/50">Select a repository to get started</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Repository selector */}
      <div className="shrink-0">
        <RepositorySelector />
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* TASKS section */}
        <div className="px-2 pt-3">
          <button
            type="button"
            onClick={() => { setSelectedTaskId(null); setActiveEngine('tasks'); }}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-2 py-1 mb-1 text-[9px] font-semibold uppercase tracking-wider transition-colors',
              activeEngine === 'tasks' && !selectedTaskId
                ? 'text-primary bg-primary/5'
                : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/10',
            )}
          >
            Task Board
          </button>

          {/* Quick task creation */}
          <div className="mb-2">
            <TaskQuickInput onSubmit={async (text) => {
              // Auto-generate labels from common keywords
              const lower = text.toLowerCase();
              const labels: string[] = [];
              if (lower.includes('fix') || lower.includes('bug')) labels.push('bug-fix');
              if (lower.includes('test')) labels.push('testing');
              if (lower.includes('doc') || lower.includes('readme')) labels.push('documentation');
              if (lower.includes('refactor')) labels.push('refactor');
              if (lower.includes('feature') || lower.includes('add')) labels.push('feature');
              if (lower.includes('style') || lower.includes('css') || lower.includes('ui')) labels.push('ui');
              if (lower.includes('perf') || lower.includes('optim')) labels.push('performance');
              if (lower.includes('security') || lower.includes('auth')) labels.push('security');
              addTask(text, text, 'medium', labels.length > 0 ? labels.slice(0, 3) : undefined);
            }} />
          </div>

          {/* Task status sections */}
          {TASK_SECTIONS.map((section) => {
            const sectionTaskList = sectionTasks[section.key] ?? [];
            const count = sectionTaskList.length;
            const isExpanded = expandedSections.has(section.key);

            // Auto-expand sections with tasks
            const shouldShow = count > 0 || section.defaultOpen;
            if (!shouldShow && !isExpanded) {
              // Still show the header but collapsed
            }

            return (
              <div key={section.key}>
                <button
                  type="button"
                  onClick={() => toggleSection(section.key)}
                  className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-muted/20"
                >
                  {isExpanded ? (
                    <ChevronDownIcon className="h-3 w-3 text-muted-foreground/40" />
                  ) : (
                    <ChevronRightIcon className="h-3 w-3 text-muted-foreground/40" />
                  )}
                  <span className={cn('font-medium', count > 0 ? section.color : 'text-muted-foreground/40')}>
                    {section.label}
                  </span>
                  {count > 0 && (
                    <span className="ml-auto rounded-full bg-muted/30 px-1.5 py-0.5 text-[9px] font-bold text-muted-foreground/60">
                      {count}
                    </span>
                  )}
                </button>

                {/* Task list */}
                {isExpanded && count > 0 && (
                  <div className="ml-3 space-y-0.5 pb-1">
                    {sectionTaskList.map((task) => {
                      const isSelected = selectedTaskId === task.id && activeEngine === 'task-thread';
                      const isRunning = taskExecutions.has(task.id) && taskExecutions.get(task.id)?.status === 'running';
                      const isDefining = task.status === 'defining';

                      return (
                        <button
                          key={task.id}
                          type="button"
                          onClick={() => { if (!isDefining) handleTaskClick(task.id); }}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] transition-colors',
                            isDefining ? 'cursor-default text-muted-foreground/60' :
                            isSelected
                              ? 'bg-primary/10 text-primary'
                              : 'text-muted-foreground hover:bg-muted/20 hover:text-foreground',
                          )}
                        >
                          {isRunning && (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400 animate-pulse" />
                          )}
                          <span className="flex-1 truncate">{task.title}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* WORKSPACE section */}
        <div className="px-2 pt-4">
          <div className="px-1 pb-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50">Workspace</div>
          {WORKSPACE_NAV.map(({ engine, label, Icon }) => {
            const stream = engineStreams.get(engine);
            const isActive = stream?.status === 'streaming';

            return (
              <button
                key={engine}
                type="button"
                onClick={() => {
                  setSelectedTaskId(null);
                  setActiveEngine(engine);
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
                  activeEngine === engine
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="flex-1 text-left">{label}</span>
                {isActive && (
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
                )}
              </button>
            );
          })}
        </div>

        {/* PLUGINS section */}
        {pluginSidebarItems.length > 0 && (
          <div className="px-2 pt-4">
            <div className="px-1 pb-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50">Plugins</div>
            {pluginSidebarItems.map((item) => (
              <button
                key={`${item.pluginId}:${item.id}`}
                type="button"
                onClick={() => {
                  setSelectedTaskId(null);
                  setActiveEngine(`plugin:${item.pluginId}:${item.id}`);
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
                  activeEngine === `plugin:${item.pluginId}:${item.id}`
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                )}
              >
                <PuzzleIcon className="h-4 w-4" />
                <span className="flex-1 text-left">{item.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Footer: Close project */}
      <div className="shrink-0 border-t border-border/50 px-3 py-2">
        <button
          type="button"
          onClick={() => setProject(null)}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground/50 transition-colors hover:bg-muted/20 hover:text-muted-foreground"
        >
          <XIcon className="h-3.5 w-3.5" />
          Close project
        </button>
      </div>
    </div>
  );
};

import { useState, useMemo, useCallback, type FC } from 'react';
import { PlusIcon, ListTodoIcon, Trash2Icon, PlayIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import type { WorkspaceTask, TaskStatus, TaskPriority } from '../../../shared/workspace-types';
import { TaskCreationDialog } from './TaskCreationDialog';

/* ── Column definitions ──────────────────────────────────────── */

interface ColumnDef {
  key: string;
  label: string;
  statuses: TaskStatus[];
  headerColor: string;
  borderColor: string;
  badgeClass: string;
}

const COLUMNS: ColumnDef[] = [
  {
    key: 'defining',
    label: 'Defining',
    statuses: ['defining'],
    headerColor: 'text-slate-300',
    borderColor: 'border-t-slate-400/50',
    badgeClass: 'bg-slate-500/15 text-slate-400',
  },
  {
    key: 'planning',
    label: 'Planning',
    statuses: ['planning', 'queued'],
    headerColor: 'text-indigo-400',
    borderColor: 'border-t-indigo-500/50',
    badgeClass: 'bg-indigo-500/15 text-indigo-400',
  },
  {
    key: 'executing',
    label: 'Executing',
    statuses: ['executing', 'needs_input', 'in_progress'],
    headerColor: 'text-blue-400',
    borderColor: 'border-t-blue-500/50',
    badgeClass: 'bg-blue-500/15 text-blue-400',
  },
  {
    key: 'review',
    label: 'Review',
    statuses: ['review', 'ai_review', 'human_review'],
    headerColor: 'text-purple-400',
    borderColor: 'border-t-purple-500/50',
    badgeClass: 'bg-purple-500/15 text-purple-400',
  },
  {
    key: 'done',
    label: 'Done',
    statuses: ['done', 'rejected'],
    headerColor: 'text-emerald-400',
    borderColor: 'border-t-emerald-500/50',
    badgeClass: 'bg-emerald-500/15 text-emerald-400',
  },
];

/* ── Priority dot colors ──────────────────────────────────────── */

const PRIORITY_DOT: Record<TaskPriority, string> = {
  critical: 'bg-red-400',
  high: 'bg-amber-400',
  medium: 'bg-blue-400',
  low: 'bg-slate-400',
};

/* ── Time-ago helper ──────────────────────────────────────────── */

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/* ── Component ────────────────────────────────────────────────── */

export const TaskBoard: FC = () => {
  const { tasks, removeTask, taskExecutions, setSelectedTaskId, setActiveEngine, generatePlan, executeTask } = useWorkspace();
  const [dialogOpen, setDialogOpen] = useState(false);

  // Group tasks by column
  const grouped = useMemo(() => {
    const map: Record<string, WorkspaceTask[]> = {};
    for (const col of COLUMNS) map[col.key] = [];
    for (const task of tasks) {
      if (task.archivedAt) continue;
      const col = COLUMNS.find((c) => c.statuses.includes(task.status));
      const key = col?.key ?? 'defining';
      (map[key] ??= []).push(task);
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return map;
  }, [tasks]);

  const handleTaskClick = useCallback(
    (taskId: string) => {
      setSelectedTaskId(taskId);
      setActiveEngine('task-thread');
    },
    [setSelectedTaskId, setActiveEngine],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">Task Board</h2>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          New Task
        </button>
      </div>

      {/* Kanban columns */}
      <div className="min-h-0 flex-1 overflow-x-auto">
        <div className="flex h-full gap-3 p-3">
          {COLUMNS.map((col) => {
            const colTasks = grouped[col.key] ?? [];
            return (
              <div
                key={col.key}
                className={cn(
                  'flex w-64 shrink-0 flex-col rounded-lg border border-border/30 border-t-2 bg-muted/5',
                  col.borderColor,
                )}
              >
                {/* Column header */}
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <span className={cn('text-xs font-semibold', col.headerColor)}>
                    {col.label}
                  </span>
                  <span className={cn('inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold', col.badgeClass)}>
                    {colTasks.length}
                  </span>
                </div>

                {/* Task cards */}
                <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1.5">
                  {colTasks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground/30">
                      <ListTodoIcon className="h-5 w-5 mb-1" />
                      <span className="text-[10px]">No tasks</span>
                    </div>
                  ) : (
                    colTasks.map((task) => {
                      const isRunning = taskExecutions.get(task.id)?.status === 'running';
                      return (
                        <div
                          key={task.id}
                          className="group rounded-lg border border-border/30 bg-background/60 transition-colors hover:border-border/60"
                        >
                          <button
                            type="button"
                            onClick={() => handleTaskClick(task.id)}
                            className="w-full px-3 py-2.5 text-left"
                          >
                            {/* Title row */}
                            <div className="flex items-start gap-2">
                              <span className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', PRIORITY_DOT[task.priority])} />
                              <span className="min-w-0 flex-1 text-xs font-medium text-foreground leading-snug line-clamp-2">
                                {task.title}
                              </span>
                              {isRunning && (
                                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400 animate-pulse" />
                              )}
                            </div>

                            {/* Meta row */}
                            <div className="mt-1.5 flex items-center gap-2">
                              {task.labels.slice(0, 2).map((label) => (
                                <span key={label} className="rounded-full border border-border/30 px-1.5 py-0.5 text-[8px] text-muted-foreground/50">
                                  {label}
                                </span>
                              ))}
                              <span className="ml-auto text-[9px] text-muted-foreground/40">
                                {timeAgo(task.updatedAt)}
                              </span>
                            </div>
                          </button>

                          {/* Action row — visible on hover */}
                          <div className="flex items-center gap-1 border-t border-border/20 px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            {task.status === 'defining' && !task.plan && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); generatePlan(task.id); }}
                                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium text-indigo-400 hover:bg-indigo-500/10"
                              >
                                <PlayIcon className="h-2.5 w-2.5" />
                                Plan
                              </button>
                            )}
                            {(task.status === 'defining' || task.status === 'planning') && task.plan && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); executeTask(task.id); }}
                                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium text-primary hover:bg-primary/10"
                              >
                                <PlayIcon className="h-2.5 w-2.5" />
                                Execute
                              </button>
                            )}
                            <div className="flex-1" />
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); removeTask(task.id); }}
                              className="flex items-center rounded p-0.5 text-muted-foreground/30 hover:text-red-400 hover:bg-red-500/10"
                            >
                              <Trash2Icon className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <TaskCreationDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
};

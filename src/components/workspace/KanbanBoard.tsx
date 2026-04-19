import { useState, useMemo, type FC, type ReactNode } from 'react';
import { PlusIcon, FileTextIcon, LoaderIcon, BotIcon, EyeIcon, CheckCircle2Icon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import type { TaskStatus } from '../../../shared/workspace-types';
import { TaskCard } from './TaskCard';
import { TaskCreationDialog } from './TaskCreationDialog';

interface ColumnDef {
  status: TaskStatus;
  label: string;
  accentColor: string;
  headerTextClass: string;
  borderClass: string;
  emptyIcon: ReactNode;
  emptyTitle: string;
  emptySubtitle: string;
}

const COLUMNS: ColumnDef[] = [
  {
    status: 'planning',
    label: 'Planning',
    accentColor: 'rgb(148 163 184)', // slate-400
    headerTextClass: 'text-slate-300',
    borderClass: 'border-t-slate-400/50',
    emptyIcon: <FileTextIcon className="h-5 w-5 text-slate-500/40" />,
    emptyTitle: 'No tasks planned',
    emptySubtitle: 'Create a task to get started',
  },
  {
    status: 'in_progress',
    label: 'In Progress',
    accentColor: 'rgb(96 165 250)', // blue-400
    headerTextClass: 'text-blue-400',
    borderClass: 'border-t-blue-500/50',
    emptyIcon: <LoaderIcon className="h-5 w-5 text-blue-500/30 animate-spin" style={{ animationDuration: '3s' }} />,
    emptyTitle: 'Nothing running',
    emptySubtitle: 'Start a task from Planning',
  },
  {
    status: 'ai_review',
    label: 'AI Review',
    accentColor: 'rgb(168 85 247)', // purple-400
    headerTextClass: 'text-purple-400',
    borderClass: 'border-t-purple-500/50',
    emptyIcon: <BotIcon className="h-5 w-5 text-purple-500/30" />,
    emptyTitle: 'No tasks in review',
    emptySubtitle: 'AI will review completed tasks',
  },
  {
    status: 'human_review',
    label: 'Human Review',
    accentColor: 'rgb(251 191 36)', // amber-400
    headerTextClass: 'text-amber-400',
    borderClass: 'border-t-amber-500/50',
    emptyIcon: <EyeIcon className="h-5 w-5 text-amber-500/30" />,
    emptyTitle: 'No tasks to review',
    emptySubtitle: 'Tasks pass through AI review first',
  },
  {
    status: 'done',
    label: 'Done',
    accentColor: 'rgb(52 211 153)', // emerald-400
    headerTextClass: 'text-emerald-400',
    borderClass: 'border-t-emerald-500/50',
    emptyIcon: <CheckCircle2Icon className="h-5 w-5 text-emerald-500/30" />,
    emptyTitle: 'No completed tasks',
    emptySubtitle: 'Completed tasks appear here',
  },
];

export const KanbanBoard: FC = () => {
  const { tasks, updateTaskStatus, removeTask } = useWorkspace();
  const [dialogOpen, setDialogOpen] = useState(false);

  const grouped = useMemo(() => {
    const map: Record<TaskStatus, typeof tasks> = {
      planning: [],
      in_progress: [],
      ai_review: [],
      human_review: [],
      done: [],
    };
    for (const task of tasks) {
      (map[task.status] ?? map.planning).push(task);
    }
    return map;
  }, [tasks]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">Kanban Board</h2>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          New Task
        </button>
      </div>

      {/* Columns */}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        {COLUMNS.map((col) => {
          const columnTasks = grouped[col.status];
          return (
            <div
              key={col.status}
              className={cn(
                'flex min-w-[220px] flex-1 flex-col rounded-xl border border-border/40 border-t-2 bg-muted/5',
                col.borderClass,
              )}
            >
              {/* Column header */}
              <div className="flex items-center justify-between px-3 py-2.5">
                <span className={cn('text-xs font-semibold', col.headerTextClass)}>
                  {col.label}
                </span>
                <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-muted/30 px-1.5 text-[10px] font-medium text-muted-foreground">
                  {columnTasks.length}
                </span>
              </div>

              {/* Cards */}
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                {columnTasks.length === 0 ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12">
                    {col.emptyIcon}
                    <p className="text-[11px] font-medium text-muted-foreground/40">{col.emptyTitle}</p>
                    <p className="text-[10px] text-muted-foreground/25">{col.emptySubtitle}</p>
                  </div>
                ) : (
                  columnTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onStatusChange={(status) => updateTaskStatus(task.id, status)}
                      onRemove={() => removeTask(task.id)}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      <TaskCreationDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
};

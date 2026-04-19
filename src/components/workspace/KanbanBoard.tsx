import { useState, useMemo, type FC } from 'react';
import { PlusIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import type { TaskStatus } from '../../../shared/workspace-types';
import { TaskCard } from './TaskCard';
import { TaskCreationDialog } from './TaskCreationDialog';

interface ColumnDef {
  status: TaskStatus;
  label: string;
  accentClass: string;
  headerTextClass: string;
}

const COLUMNS: ColumnDef[] = [
  { status: 'backlog', label: 'Backlog', accentClass: 'border-t-muted-foreground/30', headerTextClass: 'text-muted-foreground' },
  { status: 'in_progress', label: 'In Progress', accentClass: 'border-t-blue-500/50', headerTextClass: 'text-blue-400' },
  { status: 'review', label: 'Review', accentClass: 'border-t-amber-500/50', headerTextClass: 'text-amber-400' },
  { status: 'done', label: 'Done', accentClass: 'border-t-emerald-500/50', headerTextClass: 'text-emerald-400' },
];

export const KanbanBoard: FC = () => {
  const { tasks, updateTaskStatus, removeTask } = useWorkspace();
  const [dialogOpen, setDialogOpen] = useState(false);

  const grouped = useMemo(() => {
    const map: Record<TaskStatus, typeof tasks> = {
      backlog: [],
      in_progress: [],
      review: [],
      done: [],
    };
    for (const task of tasks) {
      (map[task.status] ?? map.backlog).push(task);
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
      <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto p-4">
        {COLUMNS.map((col) => {
          const columnTasks = grouped[col.status];
          return (
            <div
              key={col.status}
              className={cn(
                'flex w-64 shrink-0 flex-col rounded-lg border border-border/50 border-t-2 bg-muted/5',
                col.accentClass,
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
                  <div className="flex flex-1 items-center justify-center py-8">
                    <p className="text-[11px] text-muted-foreground/40">No tasks</p>
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

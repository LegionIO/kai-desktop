import { useState, useMemo, useCallback, type FC, type ReactNode, type DragEvent } from 'react';
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
    status: 'defining',
    label: 'Defining',
    accentColor: 'rgb(148 163 184)',
    headerTextClass: 'text-slate-300',
    borderClass: 'border-t-slate-400/50',
    emptyIcon: <FileTextIcon className="h-5 w-5 text-slate-500/40" />,
    emptyTitle: 'No tasks defined',
    emptySubtitle: 'Create a task to get started',
  },
  {
    status: 'planning',
    label: 'Planning',
    accentColor: 'rgb(129 140 248)',
    headerTextClass: 'text-indigo-400',
    borderClass: 'border-t-indigo-500/50',
    emptyIcon: <FileTextIcon className="h-5 w-5 text-indigo-500/40" />,
    emptyTitle: 'No tasks planned',
    emptySubtitle: 'Tasks move here after defining',
  },
  {
    status: 'executing',
    label: 'Executing',
    accentColor: 'rgb(96 165 250)',
    headerTextClass: 'text-blue-400',
    borderClass: 'border-t-blue-500/50',
    emptyIcon: <LoaderIcon className="h-5 w-5 text-blue-500/30 animate-spin" style={{ animationDuration: '3s' }} />,
    emptyTitle: 'Nothing running',
    emptySubtitle: 'Start a task from Planning',
  },
  {
    status: 'review',
    label: 'Review',
    accentColor: 'rgb(168 85 247)',
    headerTextClass: 'text-purple-400',
    borderClass: 'border-t-purple-500/50',
    emptyIcon: <EyeIcon className="h-5 w-5 text-purple-500/30" />,
    emptyTitle: 'No tasks in review',
    emptySubtitle: 'Completed tasks come here for review',
  },
  {
    status: 'done',
    label: 'Done',
    accentColor: 'rgb(52 211 153)',
    headerTextClass: 'text-emerald-400',
    borderClass: 'border-t-emerald-500/50',
    emptyIcon: <CheckCircle2Icon className="h-5 w-5 text-emerald-500/30" />,
    emptyTitle: 'No completed tasks',
    emptySubtitle: 'Completed tasks appear here',
  },
];

export const KanbanBoard: FC = () => {
  const { tasks, updateTaskStatus, removeTask, executeTask, reviewTask, taskExecutions, setActiveEngine } = useWorkspace();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dragOverColumn, setDragOverColumn] = useState<TaskStatus | null>(null);

  const grouped = useMemo(() => {
    const map: Record<string, typeof tasks> = {
      defining: [],
      planning: [],
      executing: [],
      review: [],
      done: [],
    };
    for (const task of tasks) {
      // Map legacy + new statuses to column keys
      const key = task.status === 'in_progress' ? 'executing'
        : task.status === 'ai_review' || task.status === 'human_review' ? 'review'
        : task.status === 'queued' ? 'planning'
        : task.status === 'needs_input' ? 'executing'
        : task.status === 'rejected' ? 'done'
        : task.status;
      (map[key] ?? map.defining).push(task);
    }
    return map;
  }, [tasks]);

  const handleDragStart = useCallback((e: DragEvent, taskId: string) => {
    e.dataTransfer.setData('text/plain', taskId);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: DragEvent, status: TaskStatus) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverColumn(status);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverColumn(null);
  }, []);

  const handleDrop = useCallback((e: DragEvent, status: TaskStatus) => {
    e.preventDefault();
    setDragOverColumn(null);
    const taskId = e.dataTransfer.getData('text/plain');
    if (taskId) {
      updateTaskStatus(taskId, status);
    }
  }, [updateTaskStatus]);

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
          const isDropTarget = dragOverColumn === col.status;
          return (
            <div
              key={col.status}
              className={cn(
                'flex min-w-[220px] flex-1 flex-col rounded-xl border border-t-2 bg-muted/5 transition-colors',
                col.borderClass,
                isDropTarget ? 'border-primary/50 bg-primary/5' : 'border-border/40',
              )}
              onDragOver={(e) => handleDragOver(e, col.status)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, col.status)}
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
                  <div className={cn(
                    'flex flex-1 flex-col items-center justify-center gap-2 rounded-lg py-12 transition-colors',
                    isDropTarget && 'bg-primary/5 border border-dashed border-primary/30',
                  )}>
                    {col.emptyIcon}
                    <p className="text-[11px] font-medium text-muted-foreground/40">{col.emptyTitle}</p>
                    <p className="text-[10px] text-muted-foreground/25">{col.emptySubtitle}</p>
                  </div>
                ) : (
                  columnTasks.map((task) => (
                    <div
                      key={task.id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, task.id)}
                      className="cursor-grab active:cursor-grabbing"
                    >
                      <TaskCard
                        task={task}
                        onStatusChange={(status) => updateTaskStatus(task.id, status)}
                        onRemove={() => removeTask(task.id)}
                        onExecute={() => executeTask(task.id)}
                        onReview={(approved) => reviewTask(task.id, approved)}
                        onViewChanges={() => setActiveEngine('changes')}
                        executionState={taskExecutions.get(task.id)}
                      />
                    </div>
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

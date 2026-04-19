import type { FC } from 'react';
import { cn } from '@/lib/utils';
import type { WorkspaceTask, TaskStatus, TaskPriority } from '../../../shared/workspace-types';
import { ChevronRightIcon, Trash2Icon } from 'lucide-react';

const PRIORITY_STYLES: Record<TaskPriority, string> = {
  critical: 'border-red-500/40 bg-red-500/10 text-red-400',
  high: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  medium: 'border-blue-500/40 bg-blue-500/10 text-blue-400',
  low: 'border-muted-foreground/30 bg-muted/20 text-muted-foreground',
};

const NEXT_STATUS: Record<TaskStatus, TaskStatus | null> = {
  backlog: 'in_progress',
  in_progress: 'review',
  review: 'done',
  done: null,
};

const NEXT_STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Start',
  in_progress: 'Review',
  review: 'Done',
  done: '',
};

interface TaskCardProps {
  task: WorkspaceTask;
  onStatusChange: (status: TaskStatus) => void;
  onRemove: () => void;
}

export const TaskCard: FC<TaskCardProps> = ({ task, onStatusChange, onRemove }) => {
  const next = NEXT_STATUS[task.status];

  return (
    <div className="group rounded-lg border border-border/70 bg-card/80 p-3 transition-colors hover:border-border">
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-medium text-foreground leading-snug">
          {task.title}
        </h4>
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded-md p-1 text-muted-foreground/40 opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
          title="Remove task"
        >
          <Trash2Icon className="h-3.5 w-3.5" />
        </button>
      </div>

      {task.description && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground leading-relaxed">
          {task.description}
        </p>
      )}

      <div className="mt-2.5 flex items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase leading-none',
            PRIORITY_STYLES[task.priority],
          )}
        >
          {task.priority}
        </span>

        {task.labels.map((label) => (
          <span
            key={label}
            className="inline-flex items-center rounded-full border border-border/50 bg-muted/30 px-1.5 py-0.5 text-[10px] text-muted-foreground leading-none"
          >
            {label}
          </span>
        ))}

        <div className="flex-1" />

        {next && (
          <button
            type="button"
            onClick={() => onStatusChange(next)}
            className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/10"
          >
            {NEXT_STATUS_LABEL[task.status]}
            <ChevronRightIcon className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
};

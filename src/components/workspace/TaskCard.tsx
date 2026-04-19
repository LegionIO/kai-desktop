import type { FC } from 'react';
import { cn } from '@/lib/utils';
import type { WorkspaceTask, TaskStatus, TaskPriority } from '../../../shared/workspace-types';
import { ChevronRightIcon, Trash2Icon, PlayIcon, ClockIcon } from 'lucide-react';

/* ── Status config ───────────────────────────────────────── */

const STATUS_BADGE: Record<TaskStatus, { label: string; className: string }> = {
  planning:     { label: 'Pending',     className: 'border-slate-500/40 bg-slate-500/10 text-slate-400' },
  in_progress:  { label: 'Running',     className: 'border-blue-500/40 bg-blue-500/10 text-blue-400' },
  ai_review:    { label: 'AI Review',   className: 'border-purple-500/40 bg-purple-500/10 text-purple-400' },
  human_review: { label: 'Needs Review', className: 'border-amber-500/40 bg-amber-500/10 text-amber-400' },
  done:         { label: 'Complete',    className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' },
};

const PRIORITY_DOT: Record<TaskPriority, string> = {
  critical: 'bg-red-400',
  high: 'bg-amber-400',
  medium: 'bg-blue-400',
  low: 'bg-muted-foreground/40',
};

const NEXT_STATUS: Record<TaskStatus, TaskStatus | null> = {
  planning: 'in_progress',
  in_progress: 'ai_review',
  ai_review: 'human_review',
  human_review: 'done',
  done: null,
};

const NEXT_ACTION: Record<TaskStatus, { label: string; icon: FC<{ className?: string }> } | null> = {
  planning:     { label: 'Start', icon: PlayIcon },
  in_progress:  { label: 'Review', icon: ChevronRightIcon },
  ai_review:    { label: 'Approve', icon: ChevronRightIcon },
  human_review: { label: 'Complete', icon: ChevronRightIcon },
  done: null,
};

/* ── Progress simulation ─────────────────────────────────── */

function getProgress(task: WorkspaceTask): number {
  switch (task.status) {
    case 'planning': return 0;
    case 'in_progress': return 45 + Math.floor((Date.now() - task.updatedAt) / 10000) % 50;
    case 'ai_review': return 85;
    case 'human_review': return 95;
    case 'done': return 100;
    default: return 0;
  }
}

const PROGRESS_COLOR: Record<TaskStatus, string> = {
  planning: 'bg-slate-500',
  in_progress: 'bg-blue-500',
  ai_review: 'bg-purple-500',
  human_review: 'bg-amber-500',
  done: 'bg-emerald-500',
};

/* ── Time ago ────────────────────────────────────────────── */

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/* ── Component ───────────────────────────────────────────── */

interface TaskCardProps {
  task: WorkspaceTask;
  onStatusChange: (status: TaskStatus) => void;
  onRemove: () => void;
}

export const TaskCard: FC<TaskCardProps> = ({ task, onStatusChange, onRemove }) => {
  const next = NEXT_STATUS[task.status];
  const nextAction = NEXT_ACTION[task.status];
  const badge = STATUS_BADGE[task.status];
  const progress = getProgress(task);

  return (
    <div className="group rounded-xl border border-border/60 bg-card/80 p-3 transition-colors hover:border-border">
      {/* Title + status badge row */}
      <div className="flex items-start justify-between gap-2">
        <h4 className="flex-1 truncate text-sm font-medium text-foreground leading-snug">
          {task.title}
        </h4>
        <span
          className={cn(
            'inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none',
            badge.className,
          )}
        >
          {badge.label}
        </span>
      </div>

      {/* Description */}
      {task.description && (
        <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground/70 leading-relaxed">
          {task.description}
        </p>
      )}

      {/* Progress bar */}
      {task.status !== 'planning' && (
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-muted-foreground/50">Progress</span>
            <span className="text-[10px] font-medium text-muted-foreground/70">{progress}%</span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted/30">
            <div
              className={cn('h-full rounded-full transition-all duration-500', PROGRESS_COLOR[task.status])}
              style={{ width: `${Math.min(progress, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Footer: priority dot, labels, time, action */}
      <div className="mt-3 flex items-center gap-2">
        {/* Priority dot */}
        <span
          className={cn('h-2 w-2 shrink-0 rounded-full', PRIORITY_DOT[task.priority])}
          title={`${task.priority} priority`}
        />

        {/* Labels */}
        {task.labels.slice(0, 2).map((label) => (
          <span
            key={label}
            className="inline-flex items-center rounded-full border border-border/40 bg-muted/20 px-1.5 py-0.5 text-[9px] text-muted-foreground/60 leading-none"
          >
            {label}
          </span>
        ))}

        <div className="flex-1" />

        {/* Time ago */}
        <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/40">
          <ClockIcon className="h-2.5 w-2.5" />
          {timeAgo(task.updatedAt)}
        </span>
      </div>

      {/* Action row */}
      <div className="mt-2 flex items-center justify-between">
        {nextAction && next ? (
          <button
            type="button"
            onClick={() => onStatusChange(next)}
            className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-[10px] font-medium text-primary transition-colors hover:bg-primary/15"
          >
            <nextAction.icon className="h-3 w-3" />
            {nextAction.label}
          </button>
        ) : (
          <div />
        )}

        <button
          type="button"
          onClick={onRemove}
          className="rounded-md p-1 text-muted-foreground/30 opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
          title="Remove task"
        >
          <Trash2Icon className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
};

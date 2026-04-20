import type { FC } from 'react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { WorkspaceTask, TaskStatus, TaskPriority } from '../../../shared/workspace-types';
import { ChevronRightIcon, Trash2Icon, PlayIcon, ClockIcon, XIcon, CheckIcon, MessageSquareIcon, BotIcon, ChevronDownIcon, ChevronUpIcon, WrenchIcon, SquareIcon, GitCompareIcon } from 'lucide-react';
import type { TaskExecutionState } from '@/providers/WorkspaceProvider';

/* ── Status config ───────────────────────────────────────── */

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  defining:     { label: 'Defining',    className: 'border-slate-500/40 bg-slate-500/10 text-slate-400' },
  planning:     { label: 'Planning',    className: 'border-indigo-500/40 bg-indigo-500/10 text-indigo-400' },
  queued:       { label: 'Queued',      className: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-400' },
  executing:    { label: 'Executing',   className: 'border-blue-500/40 bg-blue-500/10 text-blue-400' },
  needs_input:  { label: 'Needs Input', className: 'border-amber-500/40 bg-amber-500/10 text-amber-400' },
  review:       { label: 'Review',      className: 'border-purple-500/40 bg-purple-500/10 text-purple-400' },
  done:         { label: 'Complete',    className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' },
  rejected:     { label: 'Rejected',    className: 'border-red-500/40 bg-red-500/10 text-red-400' },
  // Legacy
  in_progress:  { label: 'Running',     className: 'border-blue-500/40 bg-blue-500/10 text-blue-400' },
  ai_review:    { label: 'AI Review',   className: 'border-purple-500/40 bg-purple-500/10 text-purple-400' },
  human_review: { label: 'Needs Review', className: 'border-amber-500/40 bg-amber-500/10 text-amber-400' },
};

const PRIORITY_DOT: Record<TaskPriority, string> = {
  critical: 'bg-red-400',
  high: 'bg-amber-400',
  medium: 'bg-blue-400',
  low: 'bg-muted-foreground/40',
};

/* ── Progress (discrete steps per status) ────────────────── */

function getProgress(task: WorkspaceTask): number {
  switch (task.status) {
    case 'defining': return 0;
    case 'planning': return 15;
    case 'queued': return 25;
    case 'executing': case 'in_progress': return 50;
    case 'needs_input': return 60;
    case 'review': case 'ai_review': case 'human_review': return 80;
    case 'done': return 100;
    case 'rejected': return 0;
    default: return 0;
  }
}

const PROGRESS_COLOR: Record<string, string> = {
  defining: 'bg-slate-500',
  planning: 'bg-indigo-500',
  queued: 'bg-cyan-500',
  executing: 'bg-blue-500',
  needs_input: 'bg-amber-500',
  review: 'bg-purple-500',
  done: 'bg-emerald-500',
  rejected: 'bg-red-500',
  // Legacy
  in_progress: 'bg-blue-500',
  ai_review: 'bg-purple-500',
  human_review: 'bg-amber-500',
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
  onExecute?: () => void;
  onReview?: (approved: boolean) => void;
  onViewChanges?: () => void;
  executionState?: TaskExecutionState;
}

export const TaskCard: FC<TaskCardProps> = ({ task, onStatusChange, onRemove, onExecute, onReview, onViewChanges, executionState }) => {
  const badge = STATUS_BADGE[task.status];
  const progress = getProgress(task);
  const [showOutput, setShowOutput] = useState(false);
  const hasOutput = executionState && executionState.output.length > 0;

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

      {/* Live execution output */}
      {(task.status === 'executing' || task.status === 'in_progress' || task.status === 'review' || task.status === 'ai_review') && hasOutput && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowOutput(!showOutput)}
            className="flex w-full items-center gap-1 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider hover:text-muted-foreground transition-colors"
          >
            <WrenchIcon className="h-2.5 w-2.5" />
            Agent Output ({executionState.output.length} lines)
            {showOutput ? <ChevronUpIcon className="h-2.5 w-2.5 ml-auto" /> : <ChevronDownIcon className="h-2.5 w-2.5 ml-auto" />}
          </button>
          {showOutput && (
            <div className="mt-1.5 max-h-32 overflow-y-auto rounded-md bg-black/40 p-2 font-mono text-[9px] leading-relaxed">
              {executionState.output.slice(-20).map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    'whitespace-pre-wrap break-all',
                    line.startsWith('$ ') ? 'text-primary' :
                    line.startsWith('✓') || line.includes('success') ? 'text-emerald-400' :
                    line.startsWith('✗') || line.includes('error') || line.includes('Error') ? 'text-red-400' :
                    line.startsWith('[tool:') ? 'text-amber-400' :
                    'text-muted-foreground/70',
                  )}
                >
                  {line}
                </div>
              ))}
              {executionState.status === 'running' && (
                <span className="inline-block h-2.5 w-1 bg-primary animate-pulse" />
              )}
            </div>
          )}
          {executionState.activeToolName && executionState.status === 'running' && (
            <div className="mt-1 flex items-center gap-1 text-[9px] text-muted-foreground/40">
              <WrenchIcon className="h-2.5 w-2.5 animate-spin" style={{ animationDuration: '2s' }} />
              Using: {executionState.activeToolName}
            </div>
          )}
        </div>
      )}

      {/* Review comments (Feature #13) */}
      {task.reviewComments && task.reviewComments.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">
            <MessageSquareIcon className="h-2.5 w-2.5" />
            Review Comments
          </div>
          {task.reviewComments.map((comment, i) => (
            <div
              key={i}
              className="rounded-md border border-border/30 bg-muted/10 px-2.5 py-1.5"
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <BotIcon className="h-2.5 w-2.5 text-purple-400" />
                <span className="text-[9px] font-medium text-purple-400">{comment.author}</span>
                <span className="text-[9px] text-muted-foreground/40">{timeAgo(comment.timestamp)}</span>
              </div>
              <p className="text-[10px] text-muted-foreground/80 leading-relaxed">
                {comment.content}
              </p>
            </div>
          ))}
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

      {/* Action row — varies by status */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {/* Defining/Planning: Start (execute) button */}
          {(task.status === 'defining' || task.status === 'planning') && onExecute && (
            <button
              type="button"
              onClick={onExecute}
              className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-[10px] font-medium text-primary transition-colors hover:bg-primary/15"
            >
              <PlayIcon className="h-3 w-3" />
              Start
            </button>
          )}

          {/* Executing: running indicator + cancel */}
          {(task.status === 'executing' || task.status === 'in_progress') && (
            <>
              <span className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-blue-400">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
                Executing...
              </span>
              {executionState?.cancel && (
                <button
                  type="button"
                  onClick={() => executionState.cancel?.()}
                  className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-500/15"
                >
                  <SquareIcon className="h-3 w-3" />
                  Stop
                </button>
              )}
            </>
          )}

          {/* Review: Approve & Reject buttons + View Changes */}
          {(task.status === 'review' || task.status === 'ai_review' || task.status === 'human_review') && (
            <>
              {onReview && (
                <button
                  type="button"
                  onClick={() => onReview(true)}
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 text-[10px] font-medium text-emerald-400 transition-colors hover:bg-emerald-500/15"
                >
                  <CheckIcon className="h-3 w-3" />
                  Approve
                </button>
              )}
              {onReview && (
                <button
                  type="button"
                  onClick={() => onReview(false)}
                  className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-500/15"
                >
                  <XIcon className="h-3 w-3" />
                  Reject
                </button>
              )}
              {onViewChanges && (
                <button
                  type="button"
                  onClick={onViewChanges}
                  className="inline-flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/5 px-2 py-1 text-[10px] font-medium text-cyan-400 transition-colors hover:bg-cyan-500/15"
                >
                  <GitCompareIcon className="h-3 w-3" />
                  Diff
                </button>
              )}
            </>
          )}
        </div>

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

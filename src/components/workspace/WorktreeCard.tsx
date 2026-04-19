import type { FC } from 'react';
import { GitBranchIcon, Trash2Icon, LinkIcon, ClockIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Worktree, WorktreeStatus } from '../../../shared/workspace-types';

/* ── Status config ──────────────────────────────────────── */

const STATUS_BADGE: Record<WorktreeStatus, { label: string; className: string }> = {
  active:  { label: 'Active',  className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' },
  stale:   { label: 'Stale',   className: 'border-amber-500/40 bg-amber-500/10 text-amber-400' },
  merging: { label: 'Merging', className: 'border-purple-500/40 bg-purple-500/10 text-purple-400' },
};

/* ── Time ago ───────────────────────────────────────────── */

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

/* ── Component ──────────────────────────────────────────── */

interface WorktreeCardProps {
  worktree: Worktree;
  onRemove: () => void;
}

export const WorktreeCard: FC<WorktreeCardProps> = ({ worktree, onRemove }) => {
  const badge = STATUS_BADGE[worktree.status];

  return (
    <div className="group flex items-start gap-3 rounded-xl border border-border/60 bg-card/80 p-3 transition-colors hover:border-border">
      {/* Icon */}
      <GitBranchIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary/70" />

      {/* Content */}
      <div className="min-w-0 flex-1">
        {/* Branch name + status */}
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{worktree.branch}</span>
          <span
            className={cn(
              'inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none',
              badge.className,
            )}
          >
            {badge.label}
          </span>
        </div>

        {/* Path */}
        <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground/50">
          {worktree.path}
        </p>

        {/* Task association */}
        {worktree.taskTitle && (
          <div className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground/60">
            <LinkIcon className="h-3 w-3 shrink-0" />
            <span className="truncate">{worktree.taskTitle}</span>
          </div>
        )}

        {/* Time */}
        <div className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground/40">
          <ClockIcon className="h-3 w-3" />
          {timeAgo(worktree.createdAt)}
        </div>
      </div>

      {/* Remove button */}
      <button
        type="button"
        onClick={onRemove}
        className="rounded-md p-1 text-muted-foreground/30 opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
        title="Remove worktree"
      >
        <Trash2Icon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};

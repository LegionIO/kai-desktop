/**
 * TaskCard — a compact card rendered inside kanban columns.
 *
 * Shows task title, status badge, relative timestamp, and agent runtime icon.
 */

import { memo, type FC } from 'react';
import { TerminalIcon, ClockIcon, MessageSquareIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TaskFile } from '@/types/task';
import { KAI_TASK_STATUS_LABELS, KAI_TASK_STATUS_COLORS } from '@/types/task';

interface TaskCardProps {
  task: TaskFile;
  onClick: () => void;
  isSelected?: boolean;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export const TaskCard: FC<TaskCardProps> = memo(
  ({ task, onClick, isSelected }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full rounded-lg border border-border/60 bg-card p-3 text-left transition-all',
        'hover:border-border hover:shadow-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isSelected && 'border-primary/50 ring-1 ring-primary/30',
      )}
    >
      {/* Title */}
      <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
        {task.title}
      </p>

      {/* Bottom row: status badge + metadata */}
      <div className="mt-2 flex items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
            KAI_TASK_STATUS_COLORS[task.status],
          )}
        >
          {KAI_TASK_STATUS_LABELS[task.status]}
        </span>

        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <ClockIcon className="h-3 w-3" />
          {relativeTime(task.updatedAt)}
        </span>

        {task.agentRuntime && (
          <TerminalIcon className="h-3 w-3 text-muted-foreground" />
        )}

        {task.sourceConversationId && (
          <MessageSquareIcon className="h-3 w-3 text-muted-foreground" />
        )}
      </div>
    </button>
  );
},
  (prev, next) =>
    prev.task.id === next.task.id &&
    prev.task.title === next.task.title &&
    prev.task.status === next.task.status &&
    prev.task.updatedAt === next.task.updatedAt &&
    prev.task.agentRuntime === next.task.agentRuntime &&
    prev.task.sourceConversationId === next.task.sourceConversationId &&
    prev.task.terminalSessionId === next.task.terminalSessionId &&
    prev.isSelected === next.isSelected,
);

TaskCard.displayName = 'TaskCard';

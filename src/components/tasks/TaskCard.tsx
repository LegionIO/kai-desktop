/**
 * TaskCard — a compact card rendered inside task queue rows.
 *
 * Shows task title, status badge, relative timestamp, and agent runtime icon.
 */

import { memo, type FC } from 'react';
import { TerminalIcon, ClockIcon, MessageSquareIcon, BotIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TaskFile, KaiTaskStatus } from '@/types/task';
import { useAgents } from '@/providers/AgentProvider';

/** Subtle status-tinted background for task cards. */
const CARD_BG_COLORS: Record<KaiTaskStatus, string> = {
  todo: 'bg-sky-500/5',
  awaiting_approval: 'bg-orange-500/5',
  in_progress: 'bg-amber-500/5',
  ai_review: 'bg-rose-500/5',
  human_review: 'bg-purple-400/5',
  done: 'bg-emerald-500/5',
};

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
  const { state: agentState } = useAgents();
  const assignedAgent = task.assignedAgentId
    ? agentState.agents.find((a) => a.id === task.assignedAgentId) ?? null
    : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-[72px] w-[180px] shrink-0 flex-col justify-between rounded-lg border border-border/60 px-3.5 py-2.5 text-left transition-all',
        CARD_BG_COLORS[task.status],
        'hover:border-border hover:shadow-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isSelected && 'border-primary/50 ring-1 ring-primary/30',
      )}
    >
      {/* Title */}
      <p className="truncate text-sm font-medium leading-snug text-foreground">
        {task.title}
      </p>

      {/* Bottom row: metadata */}
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <ClockIcon className="h-3 w-3" />
          {relativeTime(task.updatedAt)}
        </span>

        {assignedAgent && (
          <span className="flex items-center gap-1 rounded-full bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            <BotIcon className="h-2.5 w-2.5" />
            {assignedAgent.name}
          </span>
        )}

        {task.agentRuntime && !assignedAgent && (
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
    prev.task.assignedAgentId === next.task.assignedAgentId &&
    prev.task.sourceConversationId === next.task.sourceConversationId &&
    prev.task.terminalSessionId === next.task.terminalSessionId &&
    prev.isSelected === next.isSelected,
);

TaskCard.displayName = 'TaskCard';

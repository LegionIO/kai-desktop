/**
 * TaskCard — a compact card rendered inside task queue rows.
 *
 * Shows task title, status badge, relative timestamp, and agent runtime icon.
 * Right-click for context menu actions (assign agent, change status, delete).
 */

import { memo, type FC, useMemo } from 'react';
import {
  TerminalIcon,
  ClockIcon,
  MessageSquareIcon,
  BotIcon,
  UserPlusIcon,
  UserMinusIcon,
  ArrowRightIcon,
  Trash2Icon,
  ChevronRightIcon,
} from 'lucide-react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { cn } from '@/lib/utils';
import type { TaskFile, KaiTaskStatus } from '@/types/task';
import { KAI_TASK_STATUS_LABELS, KAI_TASK_STATUS_COLORS } from '@/types/task';
import { useAgents } from '@/providers/AgentProvider';
import { useTasks } from '@/providers/TaskProvider';

/** Subtle status-tinted background for task cards. */
const CARD_BG_COLORS: Record<KaiTaskStatus, string> = {
  todo: 'bg-sky-500/5',
  in_progress: 'bg-amber-500/5',
  ai_review: 'bg-rose-500/5',
  human_review: 'bg-purple-400/5',
  done: 'bg-emerald-500/5',
};

const STATUS_OPTIONS: KaiTaskStatus[] = ['todo', 'in_progress', 'ai_review', 'human_review', 'done'];

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

const itemClassName =
  'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50';

export const TaskCard: FC<TaskCardProps> = memo(
  ({ task, onClick, isSelected }) => {
    const { state: agentState, assignTask, unassignTask } = useAgents();
    const { updateTask, deleteTask } = useTasks();

    const assignedAgent = task.assignedAgentId
      ? (agentState.agents.find((a) => a.id === task.assignedAgentId) ?? null)
      : null;

    const idleAgents = useMemo(() => agentState.agents.filter((a) => a.status === 'idle'), [agentState.agents]);

    return (
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
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
            <p className="truncate text-sm font-medium leading-snug text-foreground">{task.title}</p>

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

              {task.agentRuntime && !assignedAgent && <TerminalIcon className="h-3 w-3 text-muted-foreground" />}

              {task.sourceConversationId && <MessageSquareIcon className="h-3 w-3 text-muted-foreground" />}
            </div>
          </button>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="z-50 min-w-[200px] rounded-xl border border-border/70 bg-popover/95 p-1.5 text-popover-foreground shadow-xl backdrop-blur-md">
            {/* Assign Agent submenu */}
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className={cn(itemClassName, 'data-[state=open]:bg-muted')}>
                <UserPlusIcon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="flex-1">Assign Agent</span>
                <ChevronRightIcon className="h-3.5 w-3.5 text-muted-foreground" />
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent
                  sideOffset={4}
                  className="z-50 min-w-[200px] rounded-xl border border-border/70 bg-popover/95 p-1.5 text-popover-foreground shadow-xl backdrop-blur-md"
                >
                  {idleAgents.length === 0 ? (
                    <div className="px-3 py-2 text-center text-xs text-muted-foreground">No idle agents</div>
                  ) : (
                    idleAgents.map((agent) => (
                      <ContextMenu.Item
                        key={agent.id}
                        className={itemClassName}
                        onSelect={() => void assignTask(agent.id, task.id)}
                      >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-sm">
                          {agent.icon ?? <BotIcon className="h-3.5 w-3.5 text-muted-foreground" />}
                        </span>
                        <span className="flex-1 truncate">{agent.name}</span>
                      </ContextMenu.Item>
                    ))
                  )}
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>

            {assignedAgent && (
              <ContextMenu.Item className={itemClassName} onSelect={() => void unassignTask(assignedAgent.id)}>
                <UserMinusIcon className="h-3.5 w-3.5 text-muted-foreground" />
                <span>Unassign</span>
              </ContextMenu.Item>
            )}

            <ContextMenu.Separator className="my-1 h-px bg-border/60" />

            {/* Move to status submenu */}
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className={cn(itemClassName, 'data-[state=open]:bg-muted')}>
                <ArrowRightIcon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="flex-1">Move to</span>
                <ChevronRightIcon className="h-3.5 w-3.5 text-muted-foreground" />
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent
                  sideOffset={4}
                  className="z-50 min-w-[180px] rounded-xl border border-border/70 bg-popover/95 p-1.5 text-popover-foreground shadow-xl backdrop-blur-md"
                >
                  {STATUS_OPTIONS.filter((s) => s !== task.status).map((status) => (
                    <ContextMenu.Item
                      key={status}
                      className={itemClassName}
                      onSelect={() => void updateTask(task.id, { status })}
                    >
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-px text-[11px] font-medium',
                          KAI_TASK_STATUS_COLORS[status],
                        )}
                      >
                        {KAI_TASK_STATUS_LABELS[status]}
                      </span>
                    </ContextMenu.Item>
                  ))}
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>

            <ContextMenu.Separator className="my-1 h-px bg-border/60" />

            <ContextMenu.Item
              className={cn(itemClassName, 'text-destructive data-[highlighted]:bg-destructive/10')}
              onSelect={() => void deleteTask(task.id)}
            >
              <Trash2Icon className="h-3.5 w-3.5" />
              <span>Delete</span>
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
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

/**
 * AutopilotStatus — activity log of recent dispatch decisions.
 *
 * Each row shows the task → agent assignment, match score, outcome, and
 * a relative timestamp. Resolves task/agent IDs to display names via the
 * task and agent providers. Includes a "Clear" button to wipe the log.
 */

import { type FC, useMemo } from 'react';
import {
  ActivityIcon,
  ArrowRightIcon,
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  PlayIcon,
  Trash2Icon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOrchestrator, type DispatchDecision } from '@/hooks/useOrchestrator';
import { useTasks } from '@/providers/TaskProvider';
import { useAgents } from '@/providers/AgentProvider';

interface AutopilotStatusProps {
  maxItems?: number;
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 0 || Number.isNaN(diffMs)) return 'just now';
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

function outcomeBadge(decision: DispatchDecision) {
  if (decision.error) {
    return { Icon: AlertCircleIcon, color: 'text-red-500', label: 'Error' };
  }
  if (decision.started) {
    return { Icon: PlayIcon, color: 'text-emerald-500', label: 'Started' };
  }
  if (decision.assigned) {
    return { Icon: CheckCircle2Icon, color: 'text-[var(--brand-accent)]', label: 'Assigned' };
  }
  return { Icon: CircleDashedIcon, color: 'text-muted-foreground/70', label: 'Skipped' };
}

export const AutopilotStatus: FC<AutopilotStatusProps> = ({ maxItems = 20 }) => {
  const { state, available, clearLog } = useOrchestrator();
  const { state: taskState } = useTasks();
  const { state: agentState } = useAgents();

  const taskNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of taskState.tasks) map.set(t.id, t.title);
    return map;
  }, [taskState.tasks]);

  const agentNameById = useMemo(() => {
    const map = new Map<string, { name: string; icon?: string }>();
    for (const a of agentState.agents) map.set(a.id, { name: a.name, icon: a.icon });
    return map;
  }, [agentState.agents]);

  if (!available) {
    return (
      <div className="rounded-xl border border-border/60 bg-card/50 p-4 text-center text-xs text-muted-foreground">
        Autopilot is not available in this build.
      </div>
    );
  }

  const items = state.decisions.slice(0, maxItems);
  const hasItems = items.length > 0;

  return (
    <div className="rounded-xl border border-border/60 bg-card/50">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
        <div className="flex items-center gap-2">
          <ActivityIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground">Activity</span>
          {hasItems && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {state.decisions.length}
            </span>
          )}
        </div>
        {hasItems && (
          <button
            type="button"
            onClick={() => void clearLog()}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
          >
            <Trash2Icon className="h-3 w-3" />
            Clear
          </button>
        )}
      </div>

      {/* List */}
      {!hasItems ? (
        <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
          <CircleDashedIcon className="h-5 w-5 text-muted-foreground/50" />
          <p className="text-xs text-muted-foreground">No dispatch activity yet</p>
          {state.config.enabled ? (
            <p className="text-[10px] text-muted-foreground/70">
              Autopilot is watching — decisions will appear here.
            </p>
          ) : (
            <p className="text-[10px] text-muted-foreground/70">
              Enable autopilot to start dispatching tasks.
            </p>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-border/30">
          {items.map((d, idx) => {
            const taskName = taskNameById.get(d.taskId) ?? d.taskTitle ?? 'Unknown task';
            const agent = d.agentId ? agentNameById.get(d.agentId) : null;
            const agentLabel = agent ? `${agent.icon ?? '🤖'} ${agent.name}` : d.agentName ?? '—';
            const { Icon, color, label } = outcomeBadge(d);
            const scorePct = Math.round((d.score ?? 0) * 100);
            return (
              <li key={`${d.at}-${d.taskId}-${idx}`} className="flex items-start gap-2 px-3 py-2">
                <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', color)} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="truncate font-medium text-foreground">{taskName}</span>
                    <ArrowRightIcon className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                    <span className="truncate text-foreground/80">
                      {agentLabel}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className={cn('font-medium', color)}>{label}</span>
                    {d.agentId && (
                      <>
                        <span className="text-muted-foreground/40">·</span>
                        <span>score {scorePct}%</span>
                      </>
                    )}
                    <span className="text-muted-foreground/40">·</span>
                    <span>{relativeTime(d.at)}</span>
                  </div>
                  {d.error && (
                    <p className="mt-0.5 truncate text-[10px] text-red-500/80" title={d.error}>
                      {d.error}
                    </p>
                  )}
                  {d.reason && !d.error && (
                    <p className="mt-0.5 truncate text-[10px] text-muted-foreground/70" title={d.reason}>
                      {d.reason}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

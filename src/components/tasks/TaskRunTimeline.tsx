/**
 * TaskRunTimeline — collapsible audit trail of all execution and review runs.
 *
 * Shows each run with: number, type icon, agent name, duration, outcome badge.
 * Clicking a run expands to show terminal output (lazy-loaded from disk).
 * Most recent at top, oldest at bottom. Collapsed by default.
 */

import { type FC, useState, useCallback } from 'react';
import {
  ChevronDownIcon,
  PlayIcon,
  EyeIcon,
  CheckCircle2Icon,
  XCircleIcon,
  AlertTriangleIcon,
  ClockIcon,
  SquareIcon,
  HistoryIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { app } from '@/lib/ipc-client';
import type { TaskFile, TaskRun } from '@/types/task';

interface TaskRunTimelineProps {
  task: TaskFile;
  /** Filter runs by type. When omitted, all runs are shown. */
  filterType?: 'execution' | 'review';
}

function formatDuration(startedAt: string, completedAt?: string): string {
  if (!completedAt) return 'running...';
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return '<1s';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

function getOutcomeInfo(outcome?: TaskRun['outcome']): {
  icon: typeof CheckCircle2Icon;
  color: string;
  label: string;
} {
  switch (outcome) {
    case 'promoted':
      return { icon: CheckCircle2Icon, color: 'text-emerald-500', label: 'Promoted' };
    case 'approved':
      return { icon: CheckCircle2Icon, color: 'text-emerald-500', label: 'Approved' };
    case 'rejected':
      return { icon: XCircleIcon, color: 'text-red-500', label: 'Rejected' };
    case 'blocked':
      return { icon: AlertTriangleIcon, color: 'text-amber-500', label: 'Blocked' };
    case 'timeout':
      return { icon: ClockIcon, color: 'text-amber-500', label: 'Timeout' };
    case 'crashed':
      return { icon: AlertTriangleIcon, color: 'text-red-500', label: 'Crashed' };
    case 'stopped':
      return { icon: SquareIcon, color: 'text-muted-foreground', label: 'Stopped' };
    default:
      return { icon: PlayIcon, color: 'text-blue-400', label: 'Running' };
  }
}

export const TaskRunTimeline: FC<TaskRunTimelineProps> = ({ task, filterType }) => {
  const allRuns = task.runs ?? [];
  const runs = filterType ? allRuns.filter((r) => r.type === filterType) : allRuns;
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [terminalOutput, setTerminalOutput] = useState<Record<string, string>>({});

  const loadTerminalOutput = useCallback(
    async (sessionId: string) => {
      if (terminalOutput[sessionId]) return; // already loaded
      try {
        const buffer = await app.tasks.terminalGetBuffer(sessionId);
        setTerminalOutput((prev) => ({ ...prev, [sessionId]: buffer.join('') }));
      } catch {
        setTerminalOutput((prev) => ({ ...prev, [sessionId]: '(output not available)' }));
      }
    },
    [terminalOutput],
  );

  if (runs.length === 0) return null;

  const handleToggleRun = (runId: string, sessionId: string) => {
    if (expandedRunId === runId) {
      setExpandedRunId(null);
    } else {
      setExpandedRunId(runId);
      void loadTerminalOutput(sessionId);
    }
  };

  return (
    <div className="rounded-xl border border-border/50 bg-muted/10 overflow-hidden">
      {/* Header — click to expand/collapse */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/30"
      >
        <HistoryIcon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="flex-1 text-xs font-medium text-foreground/80">Execution History</span>
        <span className="text-[10px] text-muted-foreground">
          {runs.length} run{runs.length !== 1 ? 's' : ''}
        </span>
        <ChevronDownIcon
          className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', isExpanded && 'rotate-180')}
        />
      </button>

      {/* Timeline entries */}
      {isExpanded && (
        <div className="border-t border-border/30 divide-y divide-border/20">
          {[...runs].reverse().map((run) => {
            const outcomeInfo = getOutcomeInfo(run.outcome);
            const OutcomeIcon = outcomeInfo.icon;
            const isRunExpanded = expandedRunId === run.id;

            return (
              <div key={run.id} className="bg-background/30">
                {/* Run header */}
                <button
                  type="button"
                  onClick={() => handleToggleRun(run.id, run.terminalSessionId)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/20"
                >
                  {/* Type icon */}
                  {run.type === 'execution' ? (
                    <PlayIcon className="h-3 w-3 shrink-0 text-blue-400" />
                  ) : (
                    <EyeIcon className="h-3 w-3 shrink-0 text-purple-400" />
                  )}

                  {/* Run info */}
                  <span className="text-[11px] font-medium text-foreground/70">#{run.number}</span>
                  <span className="truncate text-[11px] text-muted-foreground">{run.agentName}</span>

                  {/* Duration */}
                  <span className="text-[10px] text-muted-foreground/60">
                    {formatDuration(run.startedAt, run.completedAt)}
                  </span>

                  {/* Outcome badge */}
                  <span className={cn('ml-auto flex items-center gap-1 text-[10px] font-medium', outcomeInfo.color)}>
                    <OutcomeIcon className="h-3 w-3" />
                    {outcomeInfo.label}
                  </span>

                  <ChevronDownIcon
                    className={cn(
                      'h-3 w-3 shrink-0 text-muted-foreground/40 transition-transform',
                      isRunExpanded && 'rotate-180',
                    )}
                  />
                </button>

                {/* Expanded: summary + terminal output */}
                {isRunExpanded && (
                  <div className="border-t border-border/20 px-3 py-2">
                    {run.summary && <p className="mb-2 text-xs text-foreground/70 leading-relaxed">{run.summary}</p>}
                    {run.exitCode !== undefined && (
                      <p className="mb-2 text-[10px] text-muted-foreground">Exit code: {run.exitCode}</p>
                    )}
                    <div className="max-h-[200px] overflow-y-auto rounded-md bg-[#1a1a2e] p-2">
                      <pre className="text-[11px] text-white/70 font-mono whitespace-pre-wrap break-all">
                        {terminalOutput[run.terminalSessionId] ?? 'Loading...'}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

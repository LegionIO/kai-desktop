import { useState, useMemo, useCallback, useRef, useEffect, type FC } from 'react';
import {
  PlusIcon,
  ListTodoIcon,
  Trash2Icon,
  PlayIcon,
  LoaderIcon,
  ZapIcon,
  CheckCircle2Icon,
  RotateCcwIcon,
  CircleDotIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import type { WorkspaceTask, TaskStatus, TaskPriority } from '../../../shared/workspace-types';
import type { TaskExecutionState } from '@/providers/WorkspaceProvider';
import { TaskCreationDialog } from './TaskCreationDialog';

/* ── Column definitions ──────────────────────────────────────── */

interface ColumnDef {
  key: string;
  label: string;
  statuses: TaskStatus[];
  borderColor: string;
  headerColor: string;
  badgeClass: string;
  emptyLabel: string;
}

const COLUMNS: ColumnDef[] = [
  {
    key: 'defining',
    label: 'Defining',
    statuses: ['defining'],
    borderColor: 'border-t-slate-400/60',
    headerColor: 'text-slate-300',
    badgeClass: 'bg-slate-500/15 text-slate-400',
    emptyLabel: 'No tasks defined',
  },
  {
    key: 'planning',
    label: 'Planning',
    statuses: ['planning', 'queued'],
    borderColor: 'border-t-indigo-500/60',
    headerColor: 'text-indigo-400',
    badgeClass: 'bg-indigo-500/15 text-indigo-400',
    emptyLabel: 'No tasks planning',
  },
  {
    key: 'executing',
    label: 'Executing',
    statuses: ['executing', 'needs_input', 'in_progress'],
    borderColor: 'border-t-blue-500/60',
    headerColor: 'text-blue-400',
    badgeClass: 'bg-blue-500/15 text-blue-400',
    emptyLabel: 'No tasks running',
  },
  {
    key: 'review',
    label: 'Review',
    statuses: ['review', 'ai_review', 'human_review'],
    borderColor: 'border-t-amber-500/60',
    headerColor: 'text-amber-400',
    badgeClass: 'bg-amber-500/15 text-amber-400',
    emptyLabel: 'Nothing to review',
  },
  {
    key: 'done',
    label: 'Done',
    statuses: ['done', 'rejected'],
    borderColor: 'border-t-emerald-500/60',
    headerColor: 'text-emerald-400',
    badgeClass: 'bg-emerald-500/15 text-emerald-400',
    emptyLabel: 'No completed tasks',
  },
];

/* ── Priority dot colors ──────────────────────────────────────── */

const PRIORITY_DOT: Record<TaskPriority, string> = {
  critical: 'bg-red-400',
  high: 'bg-amber-400',
  medium: 'bg-blue-400',
  low: 'bg-slate-400',
};

/* ── Time-ago helper ──────────────────────────────────────────── */

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/* ── Mini terminal (live output preview) ─────────────────────── */

const MiniTerminal: FC<{ execution: TaskExecutionState | undefined }> = ({ execution }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = execution?.output?.slice(-4) ?? [];
  const isRunning = execution?.status === 'running';

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  if (lines.length === 0 && !isRunning) return null;

  return (
    <div
      ref={scrollRef}
      className="mt-1.5 max-h-20 overflow-y-auto rounded border border-border/20 bg-zinc-950/80 px-2 py-1"
    >
      <div className="font-mono text-[9px] leading-relaxed text-zinc-400 space-y-px">
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              'truncate',
              line.startsWith('[') && 'text-amber-400/70',
              line.startsWith('[Error') && 'text-red-400/70',
            )}
          >
            {line}
          </div>
        ))}
      </div>
      {isRunning && (
        <span className="inline-block h-2.5 w-[3px] translate-y-px bg-indigo-400/70 animate-pulse" />
      )}
    </div>
  );
};

/* ── Card: Defining column ───────────────────────────────────── */

const DefiningCard: FC<{
  task: WorkspaceTask;
  isPlanningStreaming: boolean;
  onPlan: () => void;
  onExecute: () => void;
  onDelete: () => void;
}> = ({ task, isPlanningStreaming, onPlan, onExecute, onDelete }) => (
  <div className="group rounded-lg border border-border/30 bg-background/60 transition-colors hover:border-border/60">
    <div className="px-3 py-2.5">
      {/* Title */}
      <div className="flex items-start gap-2">
        <span className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', PRIORITY_DOT[task.priority])} />
        <span className="min-w-0 flex-1 text-xs font-medium text-foreground leading-snug line-clamp-2">
          {task.title}
        </span>
      </div>

      {/* Description */}
      {task.description && task.description !== task.title && (
        <p className="mt-1 pl-4 text-[10px] text-muted-foreground/50 line-clamp-2 leading-relaxed">
          {task.description}
        </p>
      )}

      {/* Labels + timestamp */}
      <div className="mt-1.5 flex items-center gap-1.5">
        {task.labels.slice(0, 2).map((label) => (
          <span
            key={label}
            className="rounded-full border border-border/30 px-1.5 py-0.5 text-[8px] text-muted-foreground/50"
          >
            {label}
          </span>
        ))}
        <span className="ml-auto text-[9px] text-muted-foreground/40">
          {timeAgo(task.updatedAt)}
        </span>
      </div>
    </div>

    {/* Actions -- always visible */}
    <div className="flex items-center gap-1 border-t border-border/20 px-2 py-1">
      <button
        type="button"
        onClick={onPlan}
        disabled={isPlanningStreaming}
        className={cn(
          'flex items-center gap-1 rounded px-2 py-0.5 text-[9px] font-medium transition-colors',
          isPlanningStreaming
            ? 'text-indigo-400/50 cursor-not-allowed'
            : 'text-indigo-400 hover:bg-indigo-500/10',
        )}
      >
        {isPlanningStreaming ? (
          <LoaderIcon className="h-2.5 w-2.5 animate-spin" />
        ) : (
          <PlayIcon className="h-2.5 w-2.5" />
        )}
        Plan
      </button>
      <button
        type="button"
        onClick={onExecute}
        className="flex items-center gap-1 rounded px-2 py-0.5 text-[9px] font-medium text-muted-foreground/60 transition-colors hover:bg-muted/30 hover:text-muted-foreground"
      >
        <ZapIcon className="h-2.5 w-2.5" />
        Execute
      </button>
      <div className="flex-1" />
      <button
        type="button"
        onClick={onDelete}
        className="flex items-center rounded p-0.5 text-muted-foreground/30 transition-colors hover:bg-red-500/10 hover:text-red-400"
      >
        <Trash2Icon className="h-3 w-3" />
      </button>
    </div>
  </div>
);

/* ── Card: Planning column ───────────────────────────────────── */

const PlanningCard: FC<{
  task: WorkspaceTask;
  execution: TaskExecutionState | undefined;
  onExecutePlan: () => void;
  onClick: () => void;
  onDelete: () => void;
}> = ({ task, execution, onExecutePlan, onClick, onDelete }) => {
  const isRunning = execution?.status === 'running';
  const planReady = !!task.plan && !isRunning;

  return (
    <div
      className="group cursor-pointer rounded-lg border border-border/30 bg-background/60 transition-colors hover:border-indigo-500/30"
      onClick={onClick}
    >
      <div className="px-3 py-2.5">
        {/* Title */}
        <div className="flex items-start gap-2">
          <span className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', PRIORITY_DOT[task.priority])} />
          <span className="min-w-0 flex-1 text-xs font-medium text-foreground leading-snug line-clamp-2">
            {task.title}
          </span>
          {isRunning && (
            <LoaderIcon className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-indigo-400" />
          )}
        </div>

        {/* Labels + timestamp */}
        <div className="mt-1.5 flex items-center gap-1.5">
          {task.labels.slice(0, 2).map((label) => (
            <span
              key={label}
              className="rounded-full border border-border/30 px-1.5 py-0.5 text-[8px] text-muted-foreground/50"
            >
              {label}
            </span>
          ))}
          <span className="ml-auto text-[9px] text-muted-foreground/40">
            {timeAgo(task.updatedAt)}
          </span>
        </div>

        {/* Live mini-terminal */}
        <MiniTerminal execution={execution} />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 border-t border-border/20 px-2 py-1">
        <button
          type="button"
          disabled={!planReady}
          onClick={(e) => {
            e.stopPropagation();
            onExecutePlan();
          }}
          className={cn(
            'flex items-center gap-1 rounded px-2 py-0.5 text-[9px] font-medium transition-colors',
            planReady
              ? 'text-emerald-400 hover:bg-emerald-500/10'
              : 'text-muted-foreground/30 cursor-not-allowed',
          )}
        >
          {isRunning ? (
            <LoaderIcon className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <PlayIcon className="h-2.5 w-2.5" />
          )}
          Execute Plan
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="flex items-center rounded p-0.5 text-muted-foreground/30 transition-colors hover:bg-red-500/10 hover:text-red-400"
        >
          <Trash2Icon className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
};

/* ── Card: Executing column ──────────────────────────────────── */

const ExecutingCard: FC<{
  task: WorkspaceTask;
  execution: TaskExecutionState | undefined;
  onClick: () => void;
  onDelete: () => void;
}> = ({ task, execution, onClick, onDelete }) => {
  const isRunning = execution?.status === 'running';

  return (
    <div
      className="group cursor-pointer rounded-lg border border-border/30 bg-background/60 transition-colors hover:border-blue-500/30"
      onClick={onClick}
    >
      <div className="px-3 py-2.5">
        {/* Title */}
        <div className="flex items-start gap-2">
          <span className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', PRIORITY_DOT[task.priority])} />
          <span className="min-w-0 flex-1 text-xs font-medium text-foreground leading-snug line-clamp-2">
            {task.title}
          </span>
        </div>

        {/* Labels + timestamp */}
        <div className="mt-1.5 flex items-center gap-1.5">
          {task.labels.slice(0, 2).map((label) => (
            <span
              key={label}
              className="rounded-full border border-border/30 px-1.5 py-0.5 text-[8px] text-muted-foreground/50"
            >
              {label}
            </span>
          ))}
          <span className="ml-auto text-[9px] text-muted-foreground/40">
            {timeAgo(task.updatedAt)}
          </span>
        </div>

        {/* Live mini-terminal */}
        <MiniTerminal execution={execution} />

        {/* Running indicator */}
        {isRunning && (
          <div className="mt-1.5 flex items-center gap-1.5">
            <CircleDotIcon className="h-2.5 w-2.5 animate-pulse text-blue-400" />
            <span className="text-[9px] font-medium text-blue-400/80">
              {execution?.activeToolName
                ? `Running: ${execution.activeToolName}`
                : 'Processing...'}
            </span>
          </div>
        )}
      </div>

      {/* Delete -- stops execution */}
      <div className="flex items-center justify-end border-t border-border/20 px-2 py-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="flex items-center rounded p-0.5 text-muted-foreground/30 transition-colors hover:bg-red-500/10 hover:text-red-400"
        >
          <Trash2Icon className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
};

/* ── Card: Review column ─────────────────────────────────────── */

const ReviewCard: FC<{
  task: WorkspaceTask;
  onApprove: () => void;
  onReplan: () => void;
  onClick: () => void;
  onDelete: () => void;
}> = ({ task, onApprove, onReplan, onClick, onDelete }) => (
  <div
    className="group cursor-pointer rounded-lg border border-border/30 bg-background/60 transition-colors hover:border-amber-500/30"
    onClick={onClick}
  >
    <div className="px-3 py-2.5">
      {/* Title */}
      <span className="text-xs font-medium text-foreground leading-snug line-clamp-2">
        {task.title}
      </span>

      {/* Review summary */}
      {task.reviewSummary && (
        <p className="mt-1 text-[10px] text-muted-foreground/50 line-clamp-2 leading-relaxed">
          {task.reviewSummary}
        </p>
      )}

      {/* Timestamp */}
      <div className="mt-1.5 flex items-center">
        <span className="text-[9px] text-muted-foreground/40">
          {timeAgo(task.updatedAt)}
        </span>
      </div>
    </div>

    {/* Actions */}
    <div className="flex items-center gap-1 border-t border-border/20 px-2 py-1">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onApprove();
        }}
        className="flex items-center gap-1 rounded px-2 py-0.5 text-[9px] font-medium text-emerald-400 transition-colors hover:bg-emerald-500/10"
      >
        <CheckCircle2Icon className="h-2.5 w-2.5" />
        Approve
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onReplan();
        }}
        className="flex items-center gap-1 rounded px-2 py-0.5 text-[9px] font-medium text-amber-400 transition-colors hover:bg-amber-500/10"
      >
        <RotateCcwIcon className="h-2.5 w-2.5" />
        Replan
      </button>
      <div className="flex-1" />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="flex items-center rounded p-0.5 text-muted-foreground/30 transition-colors hover:bg-red-500/10 hover:text-red-400"
      >
        <Trash2Icon className="h-3 w-3" />
      </button>
    </div>
  </div>
);

/* ── Card: Done column ───────────────────────────────────────── */

const DoneCard: FC<{
  task: WorkspaceTask;
  onClick: () => void;
  onDelete: () => void;
}> = ({ task, onClick, onDelete }) => (
  <div
    className="group cursor-pointer rounded-lg border border-border/30 bg-background/60 transition-colors hover:border-emerald-500/30"
    onClick={onClick}
  >
    <div className="px-3 py-2.5">
      {/* Title + completed badge */}
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-xs font-medium text-foreground/70 leading-snug line-clamp-2">
          {task.title}
        </span>
        <span className="mt-0.5 shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[8px] font-medium text-emerald-400">
          completed
        </span>
      </div>

      {/* Timestamp */}
      <div className="mt-1.5 flex items-center">
        <span className="text-[9px] text-muted-foreground/40">
          {timeAgo(task.updatedAt)}
        </span>
      </div>
    </div>

    {/* Delete -- hover only */}
    <div className="flex items-center justify-end border-t border-border/20 px-2 py-1 opacity-0 transition-opacity group-hover:opacity-100">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="flex items-center rounded p-0.5 text-muted-foreground/30 transition-colors hover:bg-red-500/10 hover:text-red-400"
      >
        <Trash2Icon className="h-3 w-3" />
      </button>
    </div>
  </div>
);

/* ── Main component ──────────────────────────────────────────── */

export const TaskBoard: FC = () => {
  const {
    tasks,
    removeTask,
    taskExecutions,
    engineStreams,
    selectedTaskId: _selectedTaskId,
    setSelectedTaskId,
    setActiveEngine,
    generatePlan,
    approvePlan,
    replanTask,
    executeTask,
    reviewTask,
  } = useWorkspace();

  const [dialogOpen, setDialogOpen] = useState(false);

  /* Group tasks into columns */
  const grouped = useMemo(() => {
    const map: Record<string, WorkspaceTask[]> = {};
    for (const col of COLUMNS) map[col.key] = [];
    for (const task of tasks) {
      if (task.archivedAt) continue;
      const col = COLUMNS.find((c) => c.statuses.includes(task.status));
      const key = col?.key ?? 'defining';
      (map[key] ??= []).push(task);
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return map;
  }, [tasks]);

  const isPlanningStreaming = engineStreams.get('planning')?.status === 'streaming';

  const navigateToThread = useCallback(
    (taskId: string) => {
      setSelectedTaskId(taskId);
      setActiveEngine('task-thread');
    },
    [setSelectedTaskId, setActiveEngine],
  );

  /* ── Render a single card by column key ─────────────────── */

  const renderCard = useCallback(
    (task: WorkspaceTask, columnKey: string) => {
      const execution = taskExecutions.get(task.id);

      switch (columnKey) {
        case 'defining':
          return (
            <DefiningCard
              key={task.id}
              task={task}
              isPlanningStreaming={isPlanningStreaming}
              onPlan={() => generatePlan(task.id)}
              onExecute={() => executeTask(task.id)}
              onDelete={() => removeTask(task.id)}
            />
          );
        case 'planning':
          return (
            <PlanningCard
              key={task.id}
              task={task}
              execution={execution}
              onExecutePlan={() => approvePlan(task.id)}
              onClick={() => navigateToThread(task.id)}
              onDelete={() => removeTask(task.id)}
            />
          );
        case 'executing':
          return (
            <ExecutingCard
              key={task.id}
              task={task}
              execution={execution}
              onClick={() => navigateToThread(task.id)}
              onDelete={() => removeTask(task.id)}
            />
          );
        case 'review':
          return (
            <ReviewCard
              key={task.id}
              task={task}
              onApprove={() => reviewTask(task.id, true)}
              onReplan={() => replanTask(task.id)}
              onClick={() => navigateToThread(task.id)}
              onDelete={() => removeTask(task.id)}
            />
          );
        case 'done':
          return (
            <DoneCard
              key={task.id}
              task={task}
              onClick={() => navigateToThread(task.id)}
              onDelete={() => removeTask(task.id)}
            />
          );
        default:
          return null;
      }
    },
    [taskExecutions, isPlanningStreaming, generatePlan, executeTask, approvePlan, replanTask, reviewTask, removeTask, navigateToThread],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">Task Board</h2>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          New Task
        </button>
      </div>

      {/* Kanban columns */}
      <div className="min-h-0 flex-1 overflow-x-auto">
        <div className="flex h-full gap-3 p-3">
          {COLUMNS.map((col) => {
            const colTasks = grouped[col.key] ?? [];
            return (
              <div
                key={col.key}
                className={cn(
                  'flex w-64 shrink-0 flex-col rounded-lg border border-border/30 border-t-2 bg-muted/5',
                  col.borderColor,
                )}
              >
                {/* Column header */}
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <span className={cn('text-xs font-semibold', col.headerColor)}>
                    {col.label}
                  </span>
                  <span
                    className={cn(
                      'inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold',
                      col.badgeClass,
                    )}
                  >
                    {colTasks.length}
                  </span>
                </div>

                {/* Task cards */}
                <div className="flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
                  {colTasks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground/30">
                      <ListTodoIcon className="mb-1 h-5 w-5" />
                      <span className="text-[10px]">{col.emptyLabel}</span>
                    </div>
                  ) : (
                    colTasks.map((task) => renderCard(task, col.key))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <TaskCreationDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
};

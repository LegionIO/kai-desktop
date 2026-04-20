import type { FC } from 'react';
import { useState, useRef, useEffect, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import { app } from '@/lib/ipc-client';
import { DiffView } from './DiffView';
import type {
  WorkspaceTask,
  TaskPlanStep,
  ExecutionEntry,
  ExecutionEntryType,
  TaskStatus,
  TaskPriority,
} from '../../../shared/workspace-types';
import {
  ArrowLeftIcon,
  PlayIcon,
  Trash2Icon,
  CheckIcon,
  XIcon,
  CircleIcon,
  LoaderIcon,
  WrenchIcon,
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  ShieldAlertIcon,
  BotIcon,
  UserIcon,
  GitCompareIcon,
  SquareIcon,
  ClockIcon,
} from 'lucide-react';

/* ── Status badge config (mirrors TaskCard) ─────────────── */

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  defining:     { label: 'Defining',     className: 'border-slate-500/40 bg-slate-500/10 text-slate-400' },
  planning:     { label: 'Planning',     className: 'border-indigo-500/40 bg-indigo-500/10 text-indigo-400' },
  queued:       { label: 'Queued',       className: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-400' },
  executing:    { label: 'Executing',    className: 'border-blue-500/40 bg-blue-500/10 text-blue-400' },
  needs_input:  { label: 'Needs Input',  className: 'border-amber-500/40 bg-amber-500/10 text-amber-400' },
  review:       { label: 'Review',       className: 'border-purple-500/40 bg-purple-500/10 text-purple-400' },
  done:         { label: 'Complete',     className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' },
  rejected:     { label: 'Rejected',     className: 'border-red-500/40 bg-red-500/10 text-red-400' },
  in_progress:  { label: 'Running',      className: 'border-blue-500/40 bg-blue-500/10 text-blue-400' },
  ai_review:    { label: 'AI Review',    className: 'border-purple-500/40 bg-purple-500/10 text-purple-400' },
  human_review: { label: 'Needs Review', className: 'border-amber-500/40 bg-amber-500/10 text-amber-400' },
};

const PRIORITY_DOT: Record<TaskPriority, string> = {
  critical: 'bg-red-400',
  high:     'bg-amber-400',
  medium:   'bg-blue-400',
  low:      'bg-muted-foreground/40',
};

/* ── Step status icons ─────────────────────────────────── */

const StepStatusIcon: FC<{ status: TaskPlanStep['status'] }> = ({ status }) => {
  switch (status) {
    case 'pending':
      return <CircleIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />;
    case 'in_progress':
      return <LoaderIcon className="h-3.5 w-3.5 shrink-0 text-blue-400 animate-spin" />;
    case 'done':
      return <CheckIcon className="h-3.5 w-3.5 shrink-0 text-emerald-400" />;
    case 'skipped':
      return <XIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/30" />;
  }
};

/* ── Execution entry styling ───────────────────────────── */

const ENTRY_STYLES: Record<ExecutionEntryType, { border: string; icon: FC<{ className?: string }> }> = {
  plan:           { border: 'border-l-indigo-500/60', icon: ({ className }) => <BotIcon className={className} /> },
  step_start:     { border: 'border-l-blue-500/60',   icon: ({ className }) => <PlayIcon className={className} /> },
  step_complete:  { border: 'border-l-emerald-500/60', icon: ({ className }) => <CheckIcon className={className} /> },
  tool_call:      { border: 'border-l-amber-500/60',  icon: ({ className }) => <WrenchIcon className={className} /> },
  tool_result:    { border: 'border-l-zinc-500/40',   icon: ({ className }) => <ChevronRightIcon className={className} /> },
  text:           { border: 'border-l-zinc-500/20',   icon: ({ className }) => <CircleIcon className={className} /> },
  error:          { border: 'border-l-red-500/60',    icon: ({ className }) => <AlertTriangleIcon className={className} /> },
  user_input:     { border: 'border-l-primary/60',    icon: ({ className }) => <UserIcon className={className} /> },
  review_comment: { border: 'border-l-purple-500/60', icon: ({ className }) => <BotIcon className={className} /> },
};

/* ── Time formatting ──────────────────────────────────── */

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

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

/* ── Execution Entry Row ──────────────────────────────── */

const ExecutionEntryRow: FC<{ entry: ExecutionEntry }> = ({ entry }) => {
  const [expanded, setExpanded] = useState(false);
  const style = ENTRY_STYLES[entry.type];
  const IconComponent = style.icon;
  const isCollapsible = entry.type === 'tool_result';
  const isUserInput = entry.type === 'user_input';
  const isError = entry.type === 'error';
  const isStepStart = entry.type === 'step_start';
  const isToolCall = entry.type === 'tool_call';

  // Extract tool name from metadata for tool_call entries
  const toolName = isToolCall ? (entry.metadata?.toolName as string | undefined) : undefined;

  if (isUserInput) {
    return (
      <div className="flex justify-end py-1.5">
        <div className="max-w-[80%] rounded-xl rounded-br-sm border border-primary/20 bg-primary/10 px-3 py-2">
          <p className="text-xs text-foreground leading-relaxed">{entry.content}</p>
          <span className="mt-1 block text-right text-[9px] text-muted-foreground/40">
            {formatTimestamp(entry.timestamp)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex gap-2.5 py-1.5')}>
      {/* Timeline dot and line */}
      <div className="flex flex-col items-center pt-0.5">
        <div className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
          isError ? 'bg-red-500/15' :
          isStepStart ? 'bg-blue-500/15' :
          entry.type === 'step_complete' ? 'bg-emerald-500/15' :
          isToolCall ? 'bg-amber-500/15' :
          entry.type === 'review_comment' ? 'bg-purple-500/15' :
          'bg-muted/30',
        )}>
          <IconComponent className={cn(
            'h-2.5 w-2.5',
            isError ? 'text-red-400' :
            isStepStart ? 'text-blue-400' :
            entry.type === 'step_complete' ? 'text-emerald-400' :
            isToolCall ? 'text-amber-400' :
            entry.type === 'review_comment' ? 'text-purple-400' :
            'text-muted-foreground/50',
          )} />
        </div>
        <div className="mt-1 w-px flex-1 bg-border/30" />
      </div>

      {/* Content area */}
      <div className={cn('min-w-0 flex-1 rounded-lg border-l-2 px-3 py-2', style.border)}>
        {/* Header */}
        <div className="flex items-center gap-2">
          {isCollapsible && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="shrink-0 rounded p-0.5 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
            >
              <ChevronDownIcon className={cn(
                'h-3 w-3 transition-transform',
                !expanded && '-rotate-90',
              )} />
            </button>
          )}

          {isStepStart && (
            <span className="text-xs font-semibold text-blue-400">{entry.content}</span>
          )}

          {isToolCall && (
            <span className="text-xs">
              <span className="font-semibold text-amber-400">{toolName ?? 'Tool call'}</span>
              {entry.content && (
                <span className="ml-1.5 text-muted-foreground/60">{entry.content}</span>
              )}
            </span>
          )}

          {isError && (
            <span className="text-xs font-medium text-red-400">{entry.content}</span>
          )}

          {entry.type === 'review_comment' && (
            <span className="text-xs text-purple-400">{entry.content}</span>
          )}

          {!isStepStart && !isToolCall && !isError && !isCollapsible && entry.type !== 'review_comment' && (
            <span className={cn(
              'text-xs text-muted-foreground/80 leading-relaxed',
              entry.type === 'text' && 'font-mono text-[11px]',
            )}>
              {entry.content}
            </span>
          )}

          {isCollapsible && !expanded && (
            <span className="truncate text-[10px] text-muted-foreground/40">
              {entry.content.slice(0, 80)}{entry.content.length > 80 ? '...' : ''}
            </span>
          )}

          <span className="ml-auto shrink-0 text-[9px] text-muted-foreground/30">
            {formatTimestamp(entry.timestamp)}
          </span>
        </div>

        {/* Expanded content for collapsible entries */}
        {isCollapsible && expanded && (
          <div className="mt-2 max-h-48 overflow-y-auto rounded-md bg-black/30 p-2.5 font-mono text-[10px] leading-relaxed text-muted-foreground/70 whitespace-pre-wrap break-all">
            {entry.content}
          </div>
        )}
      </div>
    </div>
  );
};

/* ── Main Component ───────────────────────────────────── */

export const TaskThreadView: FC = () => {
  const {
    selectedTaskId,
    setSelectedTaskId,
    tasks,
    taskExecutions,
    generatePlan,
    approvePlan,
    removeTask,
    reviewTask,
    setActiveEngine,
    engineStreams,
  } = useWorkspace();

  const [planExpanded, setPlanExpanded] = useState(true);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Resolve the selected task
  const task: WorkspaceTask | undefined = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId),
    [tasks, selectedTaskId],
  );

  const executionState = selectedTaskId ? taskExecutions.get(selectedTaskId) : undefined;

  // Auto-scroll to bottom when execution thread grows or live output updates
  const prevEntryCount = useRef(0);
  const prevOutputCount = useRef(0);

  useEffect(() => {
    const entryCount = task?.executionThread?.length ?? 0;
    const outputCount = executionState?.output?.length ?? 0;

    if (entryCount > prevEntryCount.current || outputCount > prevOutputCount.current) {
      threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }

    prevEntryCount.current = entryCount;
    prevOutputCount.current = outputCount;
  }, [task?.executionThread?.length, executionState?.output?.length]);

  // Handle back navigation
  const handleBack = () => {
    setSelectedTaskId(null);
    setActiveEngine('tasks');
  };

  // Handle plan approval
  const handleApprovePlan = () => {
    if (!task) return;
    approvePlan(task.id);
  };

  // ── No task selected or not found ───────────────────────
  if (!task) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-muted-foreground/60">No task selected</p>
          <button
            type="button"
            onClick={handleBack}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            <ArrowLeftIcon className="h-3.5 w-3.5" />
            Back to tasks
          </button>
        </div>
      </div>
    );
  }

  const badge = STATUS_BADGE[task.status] ?? STATUS_BADGE['defining'];
  const hasOutput = !!executionState && executionState.output.length > 0;
  const hasPlan = !!task.plan;
  const hasReview = task.status === 'review' || task.status === 'ai_review' || task.status === 'human_review';
  const isExecuting = task.status === 'executing' || task.status === 'in_progress';
  const canPlan = task.status === 'defining' && !task.plan;
  const canStart = (task.status === 'defining' || task.status === 'planning') && !!task.plan;
  const isPlanning = engineStreams.get('planning')?.status === 'streaming';
  const showEmpty = !hasPlan && !hasOutput && !hasReview;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Sticky header ─────────────────────────────────── */}
      <div className="shrink-0 border-b border-border/40 bg-background/80 backdrop-blur-sm px-4 py-3">
        <div className="flex items-center gap-3">
          {/* Back button */}
          <button
            type="button"
            onClick={handleBack}
            className="shrink-0 rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:bg-muted/30 hover:text-foreground"
            title="Back to tasks"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </button>

          {/* Priority dot */}
          <span
            className={cn('h-2.5 w-2.5 shrink-0 rounded-full', PRIORITY_DOT[task.priority])}
            title={`${task.priority} priority`}
          />

          {/* Title */}
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {task.title}
          </h2>

          {/* Status badge */}
          <span className={cn(
            'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide',
            badge.className,
          )}>
            {badge.label}
          </span>

          {/* Plan button — when no plan exists */}
          {canPlan && !isPlanning && (
            <button
              type="button"
              onClick={() => generatePlan(task.id)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-3 py-1.5 text-xs font-medium text-indigo-400 transition-colors hover:bg-indigo-500/20"
            >
              <PlayIcon className="h-3.5 w-3.5" />
              Generate Plan
            </button>
          )}

          {/* Planning in progress indicator */}
          {isPlanning && (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-3 py-1.5 text-xs font-medium text-indigo-400">
              <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
              Planning...
            </span>
          )}

          {/* Start button — when plan exists and approved */}
          {canStart && (
            <button
              type="button"
              onClick={() => approvePlan(task.id)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
            >
              <PlayIcon className="h-3.5 w-3.5" />
              Approve &amp; Execute
            </button>
          )}

          {/* Stop button when executing */}
          {isExecuting && executionState?.cancel && (
            <button
              type="button"
              onClick={() => executionState.cancel?.()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20"
            >
              <SquareIcon className="h-3.5 w-3.5" />
              Stop
            </button>
          )}

          {/* Delete button — always available */}
          <div className="ml-auto">
            <button
              type="button"
              onClick={() => { removeTask(task.id); handleBack(); }}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/30 px-2 py-1.5 text-[10px] font-medium text-muted-foreground/50 transition-colors hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400"
            >
              <Trash2Icon className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* Executing indicator */}
        {isExecuting && (
          <div className="mt-2 flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
            <span className="text-[10px] font-medium text-blue-400">
              Executing{executionState?.activeToolName ? ` — ${executionState.activeToolName}` : '...'}
            </span>
          </div>
        )}
      </div>

      {/* ── Scrollable content ────────────────────────────── */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-6">

        {/* ── Description + Labels ────────────────────────── */}
        <section>
          {task.description && (
            <p className="text-xs text-muted-foreground/80 leading-relaxed">
              {task.description}
            </p>
          )}
          {task.labels.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {task.labels.map((label) => (
                <span
                  key={label}
                  className="inline-flex items-center rounded-full border border-border/40 bg-muted/20 px-2 py-0.5 text-[10px] text-muted-foreground/60 leading-none"
                >
                  {label}
                </span>
              ))}
            </div>
          )}
          {/* Metadata row */}
          <div className="mt-2.5 flex items-center gap-3 text-[10px] text-muted-foreground/40">
            <span className="inline-flex items-center gap-1">
              <ClockIcon className="h-2.5 w-2.5" />
              Created {timeAgo(task.createdAt)}
            </span>
            {task.worktreeBranch && (
              <span className="inline-flex items-center gap-1">
                <GitCompareIcon className="h-2.5 w-2.5" />
                {task.worktreeBranch}
              </span>
            )}
          </div>
        </section>

        {/* ── Plan section ────────────────────────────────── */}
        {hasPlan && task.plan && (
          <section className="rounded-xl border border-border/40 bg-card/50">
            {/* Collapsible header */}
            <button
              type="button"
              onClick={() => setPlanExpanded(!planExpanded)}
              className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/10"
            >
              <ChevronDownIcon className={cn(
                'h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform',
                !planExpanded && '-rotate-90',
              )} />
              <span className="text-xs font-semibold text-foreground uppercase tracking-wider">Plan</span>
              <span className="text-[10px] text-muted-foreground/40">
                {task.plan.steps.filter((s) => s.status === 'done').length}/{task.plan.steps.length} steps
              </span>
              <div className="flex-1" />
              {!task.planApprovedAt && task.status === 'planning' && (
                <span className="text-[10px] text-amber-400 font-medium">Awaiting approval</span>
              )}
              {task.planApprovedAt && (
                <span className="text-[10px] text-emerald-400/60">Approved</span>
              )}
            </button>

            {planExpanded && (
              <div className="border-t border-border/20 px-4 py-3 space-y-4">
                {/* Approach */}
                <div>
                  <h4 className="mb-1.5 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">Approach</h4>
                  <p className="text-xs text-muted-foreground/80 leading-relaxed">{task.plan.approach}</p>
                </div>

                {/* Steps checklist */}
                <div>
                  <h4 className="mb-2 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">Steps</h4>
                  <ol className="space-y-1.5">
                    {task.plan.steps.map((step, i) => (
                      <li key={step.id} className="flex items-start gap-2.5">
                        <span className="mt-0.5 shrink-0 text-[10px] font-mono text-muted-foreground/30 w-4 text-right">
                          {i + 1}.
                        </span>
                        <StepStatusIcon status={step.status} />
                        <span className={cn(
                          'text-xs leading-relaxed',
                          step.status === 'done' ? 'text-muted-foreground/50 line-through' :
                          step.status === 'in_progress' ? 'text-foreground font-medium' :
                          step.status === 'skipped' ? 'text-muted-foreground/30 line-through' :
                          'text-muted-foreground/70',
                        )}>
                          {step.description}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>

                {/* Files to modify */}
                {task.plan.filesToModify.length > 0 && (
                  <div>
                    <h4 className="mb-1.5 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">Files to modify</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {task.plan.filesToModify.map((file) => (
                        <span
                          key={file}
                          className="inline-flex items-center gap-1 rounded-md border border-border/30 bg-muted/15 px-2 py-1 font-mono text-[10px] text-muted-foreground/60"
                        >
                          <FileIcon className="h-2.5 w-2.5" />
                          {file}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Tests to run */}
                {task.plan.testsToRun.length > 0 && (
                  <div>
                    <h4 className="mb-1.5 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">Tests to run</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {task.plan.testsToRun.map((test) => (
                        <span
                          key={test}
                          className="inline-flex items-center rounded-md border border-border/30 bg-muted/15 px-2 py-1 font-mono text-[10px] text-muted-foreground/60"
                        >
                          {test}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Risks */}
                {task.plan.risks.length > 0 && (
                  <div>
                    <h4 className="mb-1.5 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">Risks</h4>
                    <ul className="space-y-1">
                      {task.plan.risks.map((risk, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs text-amber-400/70 leading-relaxed">
                          <ShieldAlertIcon className="mt-0.5 h-3 w-3 shrink-0" />
                          {risk}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Approve plan button */}
                {!task.planApprovedAt && task.status === 'planning' && (
                  <div className="pt-2 border-t border-border/20">
                    <button
                      type="button"
                      onClick={handleApprovePlan}
                      className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20"
                    >
                      <CheckIcon className="h-3.5 w-3.5" />
                      Approve Plan
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* ── Live execution output ───────────────────────── */}
        {executionState && executionState.output.length > 0 && (
          <section>
            <h3 className="mb-2 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">
              {executionState.status === 'running' ? 'Live Output' : 'Execution Output'}
            </h3>
            <div className="rounded-lg border border-border/30 bg-black/30 p-3 max-h-80 overflow-y-auto">
              <div className="font-mono text-[10px] leading-relaxed space-y-0.5">
                {executionState.output.map((line, i) => (
                  <div
                    key={i}
                    className={cn(
                      'whitespace-pre-wrap break-all',
                      line.startsWith('$ ') ? 'text-primary' :
                      line.startsWith('[Error]') || line.includes('error') || line.includes('Error') ? 'text-red-400' :
                      line.startsWith('[') ? 'text-amber-400' :
                      line.includes('success') || line.includes('Success') ? 'text-emerald-400' :
                      'text-muted-foreground/70',
                    )}
                  >
                    {line}
                  </div>
                ))}
              </div>
              {executionState.status === 'running' && (
                <span className="mt-1 inline-block h-3 w-1 bg-primary animate-pulse" />
              )}
            </div>
          </section>
        )}

        {/* ── Review section ──────────────────────────────── */}
        {hasReview && (
          <ReviewSection task={task} />
        )}

        {/* ── Empty state ─────────────────────────────────── */}
        {showEmpty && (
          <section className="flex flex-col items-center justify-center py-16 text-center">
            <div className="rounded-full border border-border/30 bg-muted/10 p-4 mb-4">
              <PlayIcon className="h-6 w-6 text-muted-foreground/30" />
            </div>
            <p className="text-sm text-muted-foreground/50 max-w-xs leading-relaxed">
              This task is in the {task.status} stage. Click <span className="font-medium text-indigo-400">Generate Plan</span> to have AI analyze your codebase and propose an implementation approach.
            </p>
          </section>
        )}

        {/* Scroll anchor */}
        <div ref={threadEndRef} />
      </div>

      {/* ── Chat input placeholder (future) ───────────────── */}
      {/* TODO: Add task-level chat input here. */}
    </div>
  );
};

/* ── ReviewSection (inline diff + merge workflow) ─────── */

const ReviewSection: FC<{ task: WorkspaceTask }> = ({ task }) => {
  const { project, reviewTask, mergeTask, setActiveEngine } = useWorkspace();
  const [diffFiles, setDiffFiles] = useState<Array<{ status: string; path: string }>>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState('');

  // Load changed files when review section mounts
  useEffect(() => {
    if (!project?.path || !task.worktreeBranch) return;
    let cancelled = false;
    (async () => {
      try {
        const current = await app.git.currentBranch(project.path);
        const base = current.branch || 'main';
        const result = await app.git.diffBranchStat(project.path, base, task.worktreeBranch!);
        if (!cancelled) setDiffFiles(result.files ?? []);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [project?.path, task.worktreeBranch]);

  // Load file diff when selected
  useEffect(() => {
    if (!project?.path || !task.worktreeBranch || !selectedFile) {
      setFileDiff('');
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    (async () => {
      try {
        const current = await app.git.currentBranch(project.path);
        const base = current.branch || 'main';
        const result = await app.git.diffBranchFile(project.path, base, task.worktreeBranch!, selectedFile);
        if (!cancelled) setFileDiff(result.diff ?? '');
      } catch {
        if (!cancelled) setFileDiff('');
      }
      if (!cancelled) setDiffLoading(false);
    })();
    return () => { cancelled = true; };
  }, [project?.path, task.worktreeBranch, selectedFile]);

  const handleMerge = async () => {
    setMerging(true);
    setMergeError('');
    const result = await mergeTask(task.id);
    if (!result.success) {
      setMergeError(result.error ?? 'Merge failed');
    }
    setMerging(false);
  };

  const isApproved = task.reviewResult === 'approved';

  return (
    <section className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-4 space-y-4">
      <h3 className="text-[10px] font-semibold text-purple-400 uppercase tracking-wider">
        Review {task.worktreeBranch && <span className="text-muted-foreground/40 font-mono normal-case">({task.worktreeBranch})</span>}
      </h3>

      {/* Review comments */}
      {task.reviewComments && task.reviewComments.length > 0 && (
        <div className="space-y-2">
          {task.reviewComments.map((comment, i) => (
            <div key={i} className="rounded-lg border border-border/30 bg-background/40 px-3 py-2.5">
              <div className="flex items-center gap-1.5 mb-1">
                <BotIcon className="h-3 w-3 text-purple-400" />
                <span className="text-[10px] font-medium text-purple-400">{comment.author}</span>
                <span className="text-[9px] text-muted-foreground/40">{timeAgo(comment.timestamp)}</span>
              </div>
              <p className="text-xs text-muted-foreground/80 leading-relaxed">{comment.content}</p>
            </div>
          ))}
        </div>
      )}

      {/* Review result badge */}
      {task.reviewResult && (
        <div className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold',
          task.reviewResult === 'approved'
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
            : 'border-amber-500/30 bg-amber-500/10 text-amber-400',
        )}>
          {task.reviewResult === 'approved' ? (
            <><CheckIcon className="h-3 w-3" /> Approved</>
          ) : (
            <><AlertTriangleIcon className="h-3 w-3" /> Changes Requested</>
          )}
        </div>
      )}

      {/* Inline diff viewer */}
      {task.worktreeBranch && diffFiles.length > 0 && (
        <div className="rounded-lg border border-border/30 overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border/30 px-3 py-1.5 bg-muted/10">
            <GitCompareIcon className="h-3 w-3 text-muted-foreground/50" />
            <span className="text-[10px] font-medium text-muted-foreground">{diffFiles.length} changed file{diffFiles.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="flex" style={{ maxHeight: '400px' }}>
            {/* File list */}
            <div className="w-48 shrink-0 border-r border-border/30 overflow-y-auto bg-muted/5">
              {diffFiles.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => setSelectedFile(file.path)}
                  className={cn(
                    'flex w-full items-center gap-1.5 px-2 py-1 text-left text-[10px] transition-colors',
                    selectedFile === file.path ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/20',
                  )}
                >
                  <span className={cn(
                    'shrink-0 text-[8px] font-bold',
                    file.status === 'A' ? 'text-emerald-400' : file.status === 'D' ? 'text-red-400' : 'text-amber-400',
                  )}>{file.status}</span>
                  <span className="truncate">{file.path.split('/').pop()}</span>
                </button>
              ))}
            </div>
            {/* Diff content */}
            <div className="flex-1 overflow-auto">
              {diffLoading ? (
                <div className="flex items-center justify-center py-8"><LoaderIcon className="h-4 w-4 animate-spin text-muted-foreground/40" /></div>
              ) : selectedFile && fileDiff ? (
                <DiffView diff={fileDiff} filePath={selectedFile} />
              ) : (
                <div className="flex items-center justify-center py-8 text-[10px] text-muted-foreground/40">Select a file to view diff</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 pt-1">
        {!isApproved && (
          <>
            <button
              type="button"
              onClick={() => reviewTask(task.id, true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20"
            >
              <CheckIcon className="h-3.5 w-3.5" />
              Approve
            </button>
            <button
              type="button"
              onClick={() => reviewTask(task.id, false)}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20"
            >
              <XIcon className="h-3.5 w-3.5" />
              Reject
            </button>
          </>
        )}

        {/* Merge button — shown after approval */}
        {isApproved && task.worktreeBranch && (
          <button
            type="button"
            onClick={handleMerge}
            disabled={merging}
            className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
          >
            {merging ? <LoaderIcon className="h-3.5 w-3.5 animate-spin" /> : <GitCompareIcon className="h-3.5 w-3.5" />}
            Merge to current branch
          </button>
        )}
      </div>

      {/* Merge error */}
      {mergeError && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[10px] text-red-400">
          {mergeError}
        </div>
      )}
    </section>
  );
};

import type { FC } from 'react';
import { useState, useRef, useEffect, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import { app } from '@/lib/ipc-client';
import { DiffView } from './DiffView';
import { MarkdownText } from '../thread/MarkdownText';
import type {
  WorkspaceTask,
  TaskPlanStep,
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
  ChevronDownIcon,
  FileIcon,
  ShieldAlertIcon,
  BotIcon,
  GitCompareIcon,
  SquareIcon,
  ClockIcon,
  SendIcon,
  AlertTriangleIcon,
} from 'lucide-react';

/* ── Status badge config ──────────────────────────────── */

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

/* ── Step status icon ─────────────────────────────────── */

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

/* ── Time helpers ─────────────────────────────────────── */

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

/* ── Output line coloring helper ──────────────────────── */

function outputLineClass(line: string): string {
  if (line.startsWith('You:')) return 'text-foreground font-semibold';
  if (line.startsWith('$ ')) return 'text-primary';
  if (line.startsWith('[Error]') || line.includes('error') || line.includes('Error')) return 'text-red-400';
  if (line.startsWith('[')) return 'text-amber-400';
  if (line.includes('success') || line.includes('Success') || line.includes('\u2713')) return 'text-emerald-400';
  return 'text-muted-foreground/70';
}

/* ── Collapsible Plan Section ─────────────────────────── */

const PlanSection: FC<{ task: WorkspaceTask; defaultExpanded?: boolean }> = ({ task, defaultExpanded = false }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const plan = task.plan;
  if (!plan) return null;

  return (
    <section className="rounded-xl border border-border/40 bg-card/50">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/10"
      >
        <ChevronDownIcon className={cn(
          'h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform',
          !expanded && '-rotate-90',
        )} />
        <span className="text-xs font-semibold text-foreground uppercase tracking-wider">Plan</span>
        <span className="text-[10px] text-muted-foreground/40">
          {plan.steps.filter((s) => s.status === 'done').length}/{plan.steps.length} steps
        </span>
        <div className="flex-1" />
        {!task.planApprovedAt && task.status === 'planning' && (
          <span className="text-[10px] text-amber-400 font-medium">Awaiting approval</span>
        )}
        {task.planApprovedAt && (
          <span className="text-[10px] text-emerald-400/60">Approved</span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-border/20 px-4 py-3 space-y-4">
          {/* Approach — rendered with MarkdownText for rich formatting */}
          <div>
            <h4 className="mb-1.5 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">Approach</h4>
            <div className="text-xs text-muted-foreground/80 leading-relaxed">
              <MarkdownText text={plan.approach} />
            </div>
          </div>

          {/* Steps checklist */}
          <div>
            <h4 className="mb-2 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">Steps</h4>
            <ol className="space-y-1.5">
              {plan.steps.map((step, i) => (
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
          {plan.filesToModify.length > 0 && (
            <div>
              <h4 className="mb-1.5 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">Files to modify</h4>
              <div className="flex flex-wrap gap-1.5">
                {plan.filesToModify.map((file) => (
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
          {plan.testsToRun.length > 0 && (
            <div>
              <h4 className="mb-1.5 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">Tests to run</h4>
              <div className="flex flex-wrap gap-1.5">
                {plan.testsToRun.map((test) => (
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
          {plan.risks.length > 0 && (
            <div>
              <h4 className="mb-1.5 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">Risks</h4>
              <ul className="space-y-1">
                {plan.risks.map((risk, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-amber-400/70 leading-relaxed">
                    <ShieldAlertIcon className="mt-0.5 h-3 w-3 shrink-0" />
                    {risk}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
};

/* ── Agent Output Area ────────────────────────────────── */

const AgentOutputArea: FC<{
  output: string[];
  isRunning: boolean;
  activeToolName: string | null;
  label?: string;
}> = ({ output, isRunning, activeToolName, label }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(0);

  useEffect(() => {
    if (output.length > prevLen.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
    prevLen.current = output.length;
  }, [output.length]);

  return (
    <section className="flex flex-col min-h-0 flex-1">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">
          {label ?? 'Output'}
        </h3>
        {isRunning && (
          <span className="flex items-center gap-1 text-[9px] text-blue-400">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
            {activeToolName ?? 'working...'}
          </span>
        )}
      </div>
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 rounded-lg border border-border/30 bg-black/30 overflow-y-auto"
      >
        <div className="p-3 font-mono text-[10px] leading-relaxed space-y-0.5">
          {output.map((line, i) => (
            <div
              key={i}
              className={cn('whitespace-pre-wrap break-all', outputLineClass(line))}
            >
              {line}
            </div>
          ))}
          {isRunning && (
            <span className="mt-1 inline-block h-3 w-1 bg-primary animate-pulse" />
          )}
        </div>
      </div>
    </section>
  );
};

/* ── Plan Chat (pinned at bottom during planning) ─────── */

const PlanChat: FC<{ taskId: string }> = ({ taskId }) => {
  const { project, generatePlan, engineStreams } = useWorkspace();
  const [input, setInput] = useState('');
  const isPlanStreaming = engineStreams.get('planning')?.status === 'streaming';

  const handleSend = () => {
    const text = input.trim();
    if (!text || isPlanStreaming || !project) return;
    generatePlan(taskId, text);
    setInput('');
  };

  return (
    <div className="rounded-lg border border-border/30 bg-muted/5 p-3">
      <div className="text-[10px] font-medium text-muted-foreground/60 mb-2">
        {isPlanStreaming ? 'Revising...' : 'Suggest changes to the plan'}
      </div>
      <div className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="e.g. 'Focus only on the API routes, skip the UI changes'"
          rows={2}
          disabled={isPlanStreaming}
          className="flex-1 resize-none rounded-md border border-border/40 bg-muted/10 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!input.trim() || isPlanStreaming}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary transition-colors hover:bg-primary/20 disabled:opacity-30"
        >
          {isPlanStreaming ? (
            <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <SendIcon className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  );
};

/* ── ReviewSection (inline diff + merge workflow) ─────── */

const ReviewSection: FC<{ task: WorkspaceTask }> = ({ task }) => {
  const { project, reviewTask, replanTask, mergeTask, setActiveEngine } = useWorkspace();
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
        Review{' '}
        {task.worktreeBranch && (
          <span className="text-muted-foreground/40 font-mono normal-case">({task.worktreeBranch})</span>
        )}
      </h3>

      {/* Review summary rendered with MarkdownText */}
      {task.reviewSummary && (
        <div className="rounded-lg border border-border/30 bg-background/40 px-3 py-2.5">
          <div className="text-xs text-muted-foreground/80 leading-relaxed">
            <MarkdownText text={task.reviewSummary} />
          </div>
        </div>
      )}

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
            <span className="text-[10px] font-medium text-muted-foreground">
              {diffFiles.length} changed file{diffFiles.length !== 1 ? 's' : ''}
            </span>
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
                    selectedFile === file.path
                      ? 'bg-primary/10 text-foreground'
                      : 'text-muted-foreground hover:bg-muted/20',
                  )}
                >
                  <span className={cn(
                    'shrink-0 text-[8px] font-bold',
                    file.status === 'A' ? 'text-emerald-400' : file.status === 'D' ? 'text-red-400' : 'text-amber-400',
                  )}>
                    {file.status}
                  </span>
                  <span className="truncate">{file.path.split('/').pop()}</span>
                </button>
              ))}
            </div>
            {/* Diff content */}
            <div className="flex-1 overflow-auto">
              {diffLoading ? (
                <div className="flex items-center justify-center py-8">
                  <LoaderIcon className="h-4 w-4 animate-spin text-muted-foreground/40" />
                </div>
              ) : selectedFile && fileDiff ? (
                <DiffView diff={fileDiff} filePath={selectedFile} />
              ) : (
                <div className="flex items-center justify-center py-8 text-[10px] text-muted-foreground/40">
                  Select a file to view diff
                </div>
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
              onClick={() => replanTask(task.id)}
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-500/20"
            >
              <ArrowLeftIcon className="h-3.5 w-3.5" />
              Replan
            </button>
          </>
        )}

        {/* View in Git link */}
        <button
          type="button"
          onClick={() => setActiveEngine('git')}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/30 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/20 hover:text-foreground"
        >
          <GitCompareIcon className="h-3.5 w-3.5" />
          View in Git
        </button>

        {/* Merge button -- shown after approval */}
        {isApproved && task.worktreeBranch && (
          <button
            type="button"
            onClick={handleMerge}
            disabled={merging}
            className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
          >
            {merging ? (
              <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitCompareIcon className="h-3.5 w-3.5" />
            )}
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
    replanTask,
    reviewTask,
    setActiveEngine,
    engineStreams,
  } = useWorkspace();

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  // Resolve the selected task
  const task: WorkspaceTask | undefined = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId),
    [tasks, selectedTaskId],
  );

  const executionState = selectedTaskId ? taskExecutions.get(selectedTaskId) : undefined;

  // Auto-scroll when output grows
  const prevOutputCount = useRef(0);
  useEffect(() => {
    const outputCount = executionState?.output?.length ?? 0;
    if (outputCount > prevOutputCount.current) {
      threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevOutputCount.current = outputCount;
  }, [executionState?.output?.length]);

  // Derived state
  const isPlanning = engineStreams.get('planning')?.status === 'streaming';
  const isExecuting = task?.status === 'executing' || task?.status === 'in_progress';
  const isRunning = executionState?.status === 'running';
  const hasOutput = !!executionState && executionState.output.length > 0;
  const hasPlan = !!task?.plan;
  const hasReview = task?.status === 'review' || task?.status === 'ai_review' || task?.status === 'human_review';
  const isDone = task?.status === 'done';
  const isPlanningStatus = task?.status === 'planning';
  const isDefining = task?.status === 'defining';
  const planStreamDone = !isPlanning && (executionState?.status === 'done' || !executionState);

  // Handle back navigation
  const handleBack = () => {
    setSelectedTaskId(null);
    setActiveEngine('tasks');
  };

  // ── No task selected or not found ──────────────────────
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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Sticky header ──────────────────────────────────── */}
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

          {/* Title (truncated) */}
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

          {/* Stop button — only when executing */}
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
        </div>

        {/* Executing indicator bar */}
        {isExecuting && (
          <div className="mt-2 flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
            <span className="text-[10px] font-medium text-blue-400">
              Executing{executionState?.activeToolName ? ` \u2014 ${executionState.activeToolName}` : '...'}
            </span>
          </div>
        )}
      </div>

      {/* ── Scrollable body ────────────────────────────────── */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-6">

        {/* ─── STATUS: defining ─────────────────────────────── */}
        {isDefining && (
          <>
            {/* Description, labels, metadata */}
            <section>
              {task.description && (
                <div className="text-xs text-muted-foreground/80 leading-relaxed">
                  <MarkdownText text={task.description} />
                </div>
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

            {/* Empty state */}
            {!hasPlan && !hasOutput && (
              <section className="flex flex-col items-center justify-center py-16 text-center">
                <div className="rounded-full border border-border/30 bg-muted/10 p-4 mb-4">
                  <PlayIcon className="h-6 w-6 text-muted-foreground/30" />
                </div>
                <p className="text-sm text-muted-foreground/50 max-w-xs leading-relaxed">
                  This task is queued. Click <span className="font-medium text-indigo-400">Plan</span> on the task board to start planning.
                </p>
              </section>
            )}
          </>
        )}

        {/* ─── STATUS: planning ─────────────────────────────── */}
        {isPlanningStatus && (
          <>
            {/* Full-height agent output area */}
            {hasOutput && (
              <AgentOutputArea
                output={executionState!.output}
                isRunning={isRunning ?? false}
                activeToolName={executionState?.activeToolName ?? null}
                label={isPlanning ? 'Agent Planning' : 'Planning Output'}
              />
            )}

            {/* Plan section (collapsible) — shown once plan exists */}
            {hasPlan && (
              <PlanSection task={task} defaultExpanded />
            )}

            {/* Execute Plan button — shown when plan exists and streaming is done */}
            {hasPlan && planStreamDone && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => approvePlan(task.id)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20"
                >
                  <PlayIcon className="h-3.5 w-3.5" />
                  Execute Plan
                </button>
              </div>
            )}
          </>
        )}

        {/* ─── STATUS: executing ────────────────────────────── */}
        {isExecuting && (
          <>
            {/* Full-height agent output area */}
            {hasOutput && (
              <AgentOutputArea
                output={executionState!.output}
                isRunning={isRunning ?? false}
                activeToolName={executionState?.activeToolName ?? null}
                label="Agent Executing"
              />
            )}

            {/* Plan with step progress (collapsible) */}
            {hasPlan && (
              <PlanSection task={task} />
            )}
          </>
        )}

        {/* ─── STATUS: review ──────────────────────────────── */}
        {hasReview && (
          <ReviewSection task={task} />
        )}

        {/* ─── STATUS: done ────────────────────────────────── */}
        {isDone && (
          <>
            {/* Description */}
            <section>
              {task.description && (
                <div className="text-xs text-muted-foreground/80 leading-relaxed">
                  <MarkdownText text={task.description} />
                </div>
              )}
              {task.completedAt && (
                <div className="mt-2.5 flex items-center gap-3 text-[10px] text-muted-foreground/40">
                  <span className="inline-flex items-center gap-1">
                    <CheckIcon className="h-2.5 w-2.5 text-emerald-400" />
                    Completed {timeAgo(task.completedAt)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <ClockIcon className="h-2.5 w-2.5" />
                    Created {timeAgo(task.createdAt)}
                  </span>
                </div>
              )}
            </section>

            {/* Plan (all steps done, read-only) */}
            {hasPlan && (
              <PlanSection task={task} />
            )}

            {/* Execution summary */}
            {task.reviewSummary && (
              <section className="rounded-xl border border-border/40 bg-card/50 p-4">
                <h4 className="mb-2 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">
                  Execution Summary
                </h4>
                <div className="text-xs text-muted-foreground/80 leading-relaxed">
                  <MarkdownText text={task.reviewSummary} />
                </div>
              </section>
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
          </>
        )}

        {/* ─── STATUS: queued / needs_input / rejected — generic ── */}
        {(task.status === 'queued' || task.status === 'needs_input' || task.status === 'rejected') && (
          <>
            <section>
              {task.description && (
                <div className="text-xs text-muted-foreground/80 leading-relaxed">
                  <MarkdownText text={task.description} />
                </div>
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

            {hasPlan && <PlanSection task={task} />}

            {hasOutput && (
              <AgentOutputArea
                output={executionState!.output}
                isRunning={false}
                activeToolName={null}
                label="Output"
              />
            )}
          </>
        )}

        {/* Scroll anchor */}
        <div ref={threadEndRef} />
      </div>

      {/* ── Plan chat — pinned at bottom, only during planning ── */}
      {isPlanningStatus && (
        <div className="shrink-0 border-t border-border/50 px-4 py-3">
          <PlanChat taskId={task.id} />
        </div>
      )}
    </div>
  );
};

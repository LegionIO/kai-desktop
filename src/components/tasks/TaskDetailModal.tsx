/**
 * TaskDetailModal — task preview modal with Plan and Agent tabs.
 *
 * Plan tab: shows the task description/plan.
 * Agent tab: always-visible terminal with dark idle overlay.
 * Provides a button to navigate to the full TaskDetailPanel view.
 */

import { type FC, useState, useEffect, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ExternalLinkIcon, FileCodeIcon, TerminalIcon, PlayIcon, SquareIcon, CheckCircle2Icon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownText } from '@/components/thread/MarkdownText';
import { TaskTerminal } from './TaskTerminal';
import { ReviewResultsPanel } from './ReviewResultsPanel';
import { HumanReviewActions } from './HumanReviewActions';
import { useAgents } from '@/providers/AgentProvider';
import { useTasks } from '@/providers/TaskProvider';
import type { TaskFile } from '@/types/task';
import { KAI_TASK_STATUS_LABELS, KAI_TASK_STATUS_COLORS } from '@/types/task';

interface TaskDetailModalProps {
  task: TaskFile | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenFullView: (taskId: string) => void;
}

export const TaskDetailModal: FC<TaskDetailModalProps> = ({ task, open, onOpenChange, onOpenFullView }) => {
  const { state: agentState, startAgent, stopAgent } = useAgents();
  const { updateTask, updateTaskStatus } = useTasks();
  const [isStartingAgent, setIsStartingAgent] = useState(false);

  const [activeTab, setActiveTab] = useState<'plan' | 'agent'>('plan');
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(null);

  // Sync terminal session from task
  useEffect(() => {
    if (task) {
      setTerminalSessionId(task.terminalSessionId ?? null);
    }
  }, [task?.id, task?.terminalSessionId]);

  // Auto-switch to agent tab when terminal starts
  useEffect(() => {
    if (terminalSessionId) setActiveTab('agent');
  }, [terminalSessionId]);

  // Reset tab when modal opens
  useEffect(() => {
    if (open) setActiveTab('plan');
  }, [open]);

  const handleTerminalExit = useCallback(() => {
    if (!task) return;
    setTerminalSessionId(null);
    void updateTask(task.id, { terminalSessionId: undefined });
  }, [task, updateTask]);

  const handleStartAgent = useCallback(async () => {
    if (!task?.assignedAgentId) return;
    setIsStartingAgent(true);
    try {
      const result = await startAgent(task.assignedAgentId);
      if (result?.sessionId) setTerminalSessionId(result.sessionId);
    } catch (err) {
      console.error('[TaskDetailModal] start agent failed:', err);
    } finally {
      setIsStartingAgent(false);
    }
  }, [task, startAgent]);

  const handleStopAgent = useCallback(async () => {
    if (!task?.assignedAgentId) return;
    await stopAgent(task.assignedAgentId);
  }, [task, stopAgent]);

  if (!task) return null;

  const assignedAgent = task.assignedAgentId ? agentState.agents.find((a) => a.id === task.assignedAgentId) : null;

  const reviewerAgents = (task.reviewerAgentIds ?? [])
    .map((id) => agentState.agents.find((a) => a.id === id))
    .filter(Boolean);

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

  const leftRows: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: 'Status',
      value: (
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2 py-px text-xs font-medium',
            KAI_TASK_STATUS_COLORS[task.status],
          )}
        >
          {KAI_TASK_STATUS_LABELS[task.status]}
        </span>
      ),
    },
    {
      label: 'Agent',
      value: assignedAgent ? (
        <span className="text-xs text-foreground/80">
          {assignedAgent.icon ?? '🤖'} {assignedAgent.name}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground/30">—</span>
      ),
    },
    {
      label: 'Review',
      value:
        reviewerAgents.length > 0 ? (
          <div className="flex items-center gap-1 flex-wrap">
            {reviewerAgents.map((agent) => (
              <span
                key={agent!.id}
                className="inline-flex items-center rounded-full bg-purple-500/10 px-1.5 py-px text-[10px] font-medium text-purple-400"
              >
                {agent!.icon ?? '🤖'} {agent!.name}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground/30">—</span>
        ),
    },
  ];

  const rightRows: Array<{ label: string; value: string | null }> = [
    { label: 'Created', value: fmtDate(task.createdAt) },
    { label: 'Updated', value: fmtDate(task.updatedAt) },
    { label: 'Started', value: task.startedAt ? fmtDate(task.startedAt) : null },
    { label: 'Completed', value: task.completedAt ? fmtDate(task.completedAt) : null },
  ];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[9998] bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:pointer-events-none" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[9999] flex w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border/70 bg-popover shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:pointer-events-none"
          style={{ height: 'min(90vh, 860px)' }}
        >
          <Dialog.Title className="sr-only">{task.title}</Dialog.Title>
          <Dialog.Description className="sr-only">Preview of task: {task.title}</Dialog.Description>

          {/* Header */}
          <div className="shrink-0 px-6 pt-6 pb-0">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-lg font-semibold text-foreground leading-tight">{task.title}</h2>
              <button
                type="button"
                onClick={() => onOpenFullView(task.id)}
                className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="Open full task view"
              >
                <ExternalLinkIcon className="h-4 w-4" />
              </button>
            </div>

            {/* Metadata: two columns */}
            <div className="mt-3 flex gap-8">
              <div className="flex flex-col gap-0.5">
                {leftRows.map(({ label, value }) => (
                  <div key={label} className="flex h-[18px] items-center gap-2">
                    <span className="w-12 shrink-0 text-xs text-muted-foreground/70">{label}</span>
                    {value}
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-0.5">
                {rightRows.map(({ label, value }) => (
                  <div key={label} className="flex h-[18px] items-center gap-2">
                    <span className="w-18 shrink-0 text-xs text-muted-foreground/70">{label}</span>
                    {value ? (
                      <span className="text-xs text-foreground/80">{value}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground/30">—</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Tab bar */}
            <div className="mt-4 flex items-center gap-1 border-b border-border/40">
              <button
                type="button"
                onClick={() => setActiveTab('plan')}
                className={cn(
                  'flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                  activeTab === 'plan'
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground/80',
                )}
              >
                <FileCodeIcon className="h-3.5 w-3.5" />
                Plan
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('agent')}
                className={cn(
                  'flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                  activeTab === 'agent'
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground/80',
                )}
              >
                <TerminalIcon className="h-3.5 w-3.5" />
                Agent
                {terminalSessionId && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
              </button>
            </div>
          </div>

          {/* Tab content */}
          {activeTab === 'plan' ? (
            /* Plan tab */
            <div className="relative min-h-0 flex-1">
              <div className="pointer-events-none absolute inset-x-0 -top-px z-20 h-10 bg-gradient-to-b from-popover to-transparent" />
              <div className="h-full overflow-y-auto px-6 py-5">
                {task.description ? (
                  <div className="prose-sm text-sm text-foreground/90">
                    <MarkdownText text={task.description} />
                  </div>
                ) : (
                  <p className="text-sm italic text-muted-foreground">No description</p>
                )}
              </div>
            </div>
          ) : (
            /* Agent tab */
            <div className="flex min-h-0 flex-1 flex-col px-6 pt-4 pb-5 gap-3 overflow-y-auto">
              {/* Completion summary */}
              {task.completionSummary && (task.status === 'human_review' || task.status === 'done') && (
                <div className="shrink-0 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
                  <div className="mb-1.5 flex items-center gap-2">
                    <CheckCircle2Icon className="h-3.5 w-3.5 text-emerald-500" />
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                      {task.status === 'human_review' ? 'Ready for review' : 'Completion summary'}
                    </span>
                  </div>
                  <div className="text-xs text-foreground/90 leading-relaxed">
                    <MarkdownText text={task.completionSummary} />
                  </div>
                </div>
              )}

              {/* Review results */}
              {(task.reviewResults ?? []).length > 0 && (
                <div className="shrink-0">
                  <ReviewResultsPanel task={task} />
                </div>
              )}

              {/* Human review actions — approve/reject in modal */}
              {task.status === 'human_review' && (
                <div className="shrink-0">
                  <HumanReviewActions
                    taskId={task.id}
                    onApprove={() => void updateTaskStatus(task.id, 'done')}
                    compact
                  />
                </div>
              )}

              {/* Start/Stop toolbar — only in states where execution is relevant */}
              {assignedAgent && (task.status === 'todo' || task.status === 'in_progress') && (
                <div className="shrink-0 flex items-center gap-2">
                  {assignedAgent.status === 'running' ? (
                    <button
                      type="button"
                      onClick={() => void handleStopAgent()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/20"
                    >
                      <SquareIcon className="h-3 w-3" />
                      Stop
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleStartAgent()}
                      disabled={isStartingAgent}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-500 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                    >
                      <PlayIcon className="h-3 w-3" />
                      {isStartingAgent ? 'Starting...' : 'Start'}
                    </button>
                  )}
                </div>
              )}

              {/* Terminal — always rendered; dark overlay when no session */}
              <div className="relative min-h-[200px] flex-1">
                {terminalSessionId ? (
                  <TaskTerminal
                    sessionId={terminalSessionId}
                    onExit={handleTerminalExit}
                    className="h-full rounded-xl"
                  />
                ) : (
                  <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border/50 bg-[#1a1a2e]">
                    <div className="flex flex-1 items-center justify-center">
                      <div className="flex flex-col items-center gap-2 text-center">
                        <TerminalIcon className="h-8 w-8 text-white/20" />
                        <p className="text-sm text-white/40">No agent running</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

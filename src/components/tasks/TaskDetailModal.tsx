/**
 * TaskDetailModal — compact task preview modal with 4 tabs: Overview, Plan, Execution, Review.
 *
 * Overview tab: status banners, metadata, quick state summary.
 * Plan tab: shows the task description/plan.
 * Execution tab: terminal + start/stop controls.
 * Review tab: reviewer results + reviewer terminals (only shown when reviewers assigned).
 * Provides a button to navigate to the full TaskDetailPanel view.
 */

import { type FC, useState, useEffect, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ExternalLinkIcon,
  FileCodeIcon,
  TerminalIcon,
  PlayIcon,
  SquareIcon,
  CheckCircle2Icon,
  LayoutDashboardIcon,
  UsersIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownText } from '@/components/thread/MarkdownText';
import { TaskTerminal } from './TaskTerminal';
import { ReviewResultsPanel } from './ReviewResultsPanel';
import { HumanReviewActions } from './HumanReviewActions';
import { BlockTaskActions } from './BlockTaskActions';
import { TaskRunTimeline } from './TaskRunTimeline';
import { useAgents } from '@/providers/AgentProvider';
import { useTasks } from '@/providers/TaskProvider';
import type { TaskFile } from '@/types/task';
import { KAI_TASK_STATUS_LABELS, KAI_TASK_STATUS_COLORS } from '@/types/task';

type TabId = 'overview' | 'plan' | 'execution' | 'review';

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

  const getDefaultTab = (status: TaskFile['status']): TabId => {
    switch (status) {
      case 'todo':
        return 'plan';
      case 'in_progress':
        return 'execution';
      case 'blocked':
      case 'ai_review':
      case 'human_review':
      case 'done':
        return 'overview';
      default:
        return 'overview';
    }
  };

  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(null);
  const [activeTerminalTab, setActiveTerminalTab] = useState<string | null>(null);

  // Sync terminal session from task
  useEffect(() => {
    if (task) {
      setTerminalSessionId(task.terminalSessionId ?? null);
    }
  }, [task?.id, task?.terminalSessionId]);

  // Auto-switch to execution tab when terminal starts
  useEffect(() => {
    if (terminalSessionId) setActiveTab('execution');
  }, [terminalSessionId]);

  // Reset tab when modal opens based on task status
  useEffect(() => {
    if (open && task) setActiveTab(getDefaultTab(task.status));
  }, [open, task?.id]);

  // Listen for "Request Changes" event — switch to overview tab
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as string;
      if (detail === task?.id) {
        setActiveTab('overview');
      }
    };
    window.addEventListener('kai:request-changes-focus', handler);
    return () => window.removeEventListener('kai:request-changes-focus', handler);
  }, [task?.id]);

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

  const hasReviewers = (task.reviewerAgentIds ?? []).length > 0;

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

  // Tab definitions
  const tabs: Array<{ id: TabId; label: string; icon: FC<{ className?: string }>; show: boolean }> = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboardIcon, show: true },
    { id: 'plan', label: 'Plan', icon: FileCodeIcon, show: true },
    { id: 'execution', label: 'Execution', icon: TerminalIcon, show: true },
    { id: 'review', label: 'Review', icon: UsersIcon, show: hasReviewers },
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

            {/* Tab bar */}
            <div className="mt-4 flex items-center gap-1 border-b border-border/40">
              {tabs
                .filter((t) => t.show)
                .map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={cn(
                      'flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                      activeTab === tab.id
                        ? 'border-primary text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground/80',
                    )}
                  >
                    <tab.icon className="h-3.5 w-3.5" />
                    {tab.label}
                    {tab.id === 'execution' && terminalSessionId && (
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    )}
                  </button>
                ))}
            </div>
          </div>

          {/* ═══ OVERVIEW TAB ═══ */}
          {activeTab === 'overview' && (
            <div className="relative min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {/* Status-specific banners */}
              {task.status === 'blocked' &&
                (() => {
                  const blockReason =
                    [...(task.reviewNotes ?? [])].reverse().find((n) => !n.content.includes('[Autopilot] Unblocked:'))
                      ?.content ??
                    ((task as unknown as { runs?: Array<{ outcome?: string; summary?: string }> }).runs ?? [])
                      .slice()
                      .reverse()
                      .find((r) => r.outcome === 'blocked')?.summary ??
                    '';
                  return (
                    <div className="mb-4">
                      <BlockTaskActions taskId={task.id} currentReason={blockReason} mode="view" />
                    </div>
                  );
                })()}

              {task.status === 'human_review' && (
                <div className="mb-4">
                  <HumanReviewActions
                    taskId={task.id}
                    onApprove={() => void updateTaskStatus(task.id, 'done')}
                    compact
                  />
                </div>
              )}

              {/* Completion summary */}
              {task.completionSummary && (task.status === 'human_review' || task.status === 'done') && (
                <div className="mb-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
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

              {/* Metadata grid */}
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 mt-2">
                <div className="flex items-center gap-2">
                  <span className="w-16 shrink-0 text-xs text-muted-foreground/70">Status</span>
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full px-2 py-px text-xs font-medium',
                      KAI_TASK_STATUS_COLORS[task.status],
                    )}
                  >
                    {KAI_TASK_STATUS_LABELS[task.status]}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-16 shrink-0 text-xs text-muted-foreground/70">Agent</span>
                  {assignedAgent ? (
                    <span className="text-xs text-foreground/80">
                      {assignedAgent.icon ?? '🤖'} {assignedAgent.name}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground/30">—</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-16 shrink-0 text-xs text-muted-foreground/70">Created</span>
                  <span className="text-xs text-foreground/80">{fmtDate(task.createdAt)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-16 shrink-0 text-xs text-muted-foreground/70">Updated</span>
                  <span className="text-xs text-foreground/80">{fmtDate(task.updatedAt)}</span>
                </div>
                {task.startedAt && (
                  <div className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-xs text-muted-foreground/70">Started</span>
                    <span className="text-xs text-foreground/80">{fmtDate(task.startedAt)}</span>
                  </div>
                )}
                {task.completedAt && (
                  <div className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-xs text-muted-foreground/70">Completed</span>
                    <span className="text-xs text-foreground/80">{fmtDate(task.completedAt)}</span>
                  </div>
                )}
                {reviewerAgents.length > 0 && (
                  <div className="flex items-center gap-2 col-span-2">
                    <span className="w-16 shrink-0 text-xs text-muted-foreground/70">Reviewers</span>
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
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ═══ PLAN TAB ═══ */}
          {activeTab === 'plan' && (
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
          )}

          {/* ═══ EXECUTION TAB ═══ */}
          {activeTab === 'execution' && (
            <div className="flex min-h-0 flex-1 flex-col px-6 pt-4 pb-5 gap-3 overflow-y-auto">
              {/* Execution history */}
              <div className="shrink-0">
                <TaskRunTimeline task={task} filterType="execution" />
              </div>

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

          {/* ═══ REVIEW TAB ═══ */}
          {activeTab === 'review' && (
            <div className="flex min-h-0 flex-1 flex-col px-6 pt-4 pb-5 gap-3 overflow-y-auto">
              {/* Review results */}
              {(task.reviewResults ?? []).length > 0 && (
                <div className="shrink-0">
                  <ReviewResultsPanel
                    task={task}
                    onViewTerminal={(sessionId) => {
                      setActiveTerminalTab(sessionId);
                    }}
                  />
                </div>
              )}

              {/* Review history */}
              <div className="shrink-0">
                <TaskRunTimeline task={task} filterType="review" />
              </div>

              {/* Reviewer terminal tabs */}
              {(() => {
                const reviewerTerminals = (task.reviewResults ?? []).filter((r) => r.terminalSessionId);
                if (reviewerTerminals.length === 0) return null;
                return (
                  <>
                    <div className="shrink-0 flex items-center gap-0.5 rounded-lg border border-border/40 bg-muted/20 p-0.5">
                      {reviewerTerminals.map((r) => (
                        <button
                          key={r.agentId}
                          type="button"
                          onClick={() => setActiveTerminalTab(r.terminalSessionId!)}
                          className={cn(
                            'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                            activeTerminalTab === r.terminalSessionId
                              ? 'bg-background text-foreground shadow-sm'
                              : 'text-muted-foreground hover:text-foreground/80',
                          )}
                        >
                          <span className="flex items-center gap-1">
                            <span className="shrink-0 text-xs">{r.agentName.slice(0, 2) === '🤖' ? '🤖' : '🔍'}</span>
                            <span className="max-w-[60px] truncate">{r.agentName}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                    {activeTerminalTab && (
                      <div className="relative min-h-[180px] flex-1">
                        <TaskTerminal sessionId={activeTerminalTab} onExit={() => {}} className="h-full rounded-xl" />
                      </div>
                    )}
                  </>
                );
              })()}

              {/* Empty state when no review output */}
              {(task.reviewResults ?? []).length === 0 && (
                <div className="flex min-h-[150px] flex-1 flex-col overflow-hidden rounded-xl border border-border/50 bg-[#1a1a2e]">
                  <div className="flex flex-1 items-center justify-center">
                    <div className="flex flex-col items-center gap-2 text-center">
                      <UsersIcon className="h-8 w-8 text-white/20" />
                      <p className="text-sm text-white/40">No reviewer output yet</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

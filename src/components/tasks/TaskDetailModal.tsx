/**
 * TaskDetailModal — task preview modal with Plan and Agent tabs.
 *
 * Plan tab: shows the task description/plan.
 * Agent tab: shows assigned agent, terminal (always visible), and a steering composer.
 * Provides a button to navigate to the full TaskDetailPanel view.
 */

import { type FC, useState, useEffect, useRef, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ExternalLinkIcon, FileCodeIcon, TerminalIcon, PlayIcon, StopCircleIcon, SendHorizonalIcon } from 'lucide-react';import { cn } from '@/lib/utils';
import { MarkdownText } from '@/components/thread/MarkdownText';
import { TaskTerminal } from './TaskTerminal';
import { useAgents } from '@/providers/AgentProvider';
import { app } from '@/lib/ipc-client';
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
  const { state: agentState } = useAgents();
  const { updateTask } = useTasks();

  const [activeTab, setActiveTab] = useState<'plan' | 'agent'>('plan');
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(null);
  const [isStartingAgent, setIsStartingAgent] = useState(false);
  const [agentInput, setAgentInput] = useState('');
  const agentTextareaRef = useRef<HTMLTextAreaElement>(null);

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

  // Auto-resize agent textarea
  useEffect(() => {
    const el = agentTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [agentInput]);

  const handleStartAgent = useCallback(async () => {
    if (!task) return;
    const runtime = task.agentRuntime ?? 'claude-code';
    setIsStartingAgent(true);
    try {
      const result = await app.tasks.terminalCreate(task.id, {
        runtime,
        cwd: task.metadata?.cwd,
      });
      if (result.sessionId) {
        setTerminalSessionId(result.sessionId);
        void updateTask(task.id, {
          terminalSessionId: result.sessionId,
          agentRuntime: runtime,
          status: 'in_progress',
        });
      }
    } finally {
      setIsStartingAgent(false);
    }
  }, [task, updateTask]);

  const handleStopAgent = useCallback(() => {
    if (!task || !terminalSessionId) return;
    void app.tasks.terminalKill(terminalSessionId);
    setTerminalSessionId(null);
    void updateTask(task.id, { terminalSessionId: undefined });
  }, [task, terminalSessionId, updateTask]);

  const handleTerminalExit = useCallback(() => {
    if (!task) return;
    setTerminalSessionId(null);
    void updateTask(task.id, { terminalSessionId: undefined });
  }, [task, updateTask]);

  const handleAgentSubmit = useCallback(() => {
    const text = agentInput.trim();
    if (!text || !terminalSessionId) return;
    setAgentInput('');
    void app.tasks.terminalWrite(terminalSessionId, text + '\n');
    agentTextareaRef.current?.focus();
  }, [agentInput, terminalSessionId]);

  const handleAgentKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleAgentSubmit();
      }
    },
    [handleAgentSubmit],
  );

  if (!task) return null;

  const assignedAgent = task.assignedAgentId
    ? agentState.agents.find((a) => a.id === task.assignedAgentId)
    : null;

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });

  const leftRows: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: 'Status',
      value: (
        <span className={cn('inline-flex items-center rounded-full px-2 py-px text-xs font-medium', KAI_TASK_STATUS_COLORS[task.status])}>
          {KAI_TASK_STATUS_LABELS[task.status]}
        </span>
      ),
    },
    {
      label: 'Agent',
      value: assignedAgent
        ? <span className="text-xs text-foreground/80">{assignedAgent.icon ?? '🤖'} {assignedAgent.name}</span>
        : <span className="text-xs text-muted-foreground/30">—</span>,
    },
  ];

  const rightRows: Array<{ label: string; value: string | null }> = [
    { label: 'Created',   value: fmtDate(task.createdAt) },
    { label: 'Updated',   value: fmtDate(task.updatedAt) },
    { label: 'Started',   value: task.startedAt ? fmtDate(task.startedAt) : null },
    { label: 'Completed', value: task.completedAt ? fmtDate(task.completedAt) : null },
  ];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[9998] bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:pointer-events-none" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[9999] flex w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border/70 bg-popover shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:pointer-events-none"
          style={{ maxHeight: 'min(85vh, 720px)' }}
        >
          <Dialog.Title className="sr-only">{task.title}</Dialog.Title>
          <Dialog.Description className="sr-only">
            Preview of task: {task.title}
          </Dialog.Description>

          {/* Header */}
          <div className="shrink-0 px-6 pt-6 pb-0">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-lg font-semibold text-foreground leading-tight">
                {task.title}
              </h2>
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
                    {value
                      ? <span className="text-xs text-foreground/80">{value}</span>
                      : <span className="text-xs text-muted-foreground/30">—</span>
                    }
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
                {terminalSessionId && (
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                )}
              </button>
            </div>
          </div>

          {/* Tab content */}
          {activeTab === 'plan' ? (
            /* Plan tab */
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {task.description ? (
                <div className="prose-sm text-sm text-foreground/90">
                  <MarkdownText text={task.description} />
                </div>
              ) : (
                <p className="text-sm italic text-muted-foreground">No description</p>
              )}
            </div>
          ) : (
            /* Agent tab */
            <div className="flex min-h-0 flex-1 flex-col">
              {terminalSessionId ? (
                <>
                  {/* Terminal */}
                  <div className="min-h-0 flex-1 px-6 pt-4">
                    <TaskTerminal
                      sessionId={terminalSessionId}
                      onExit={handleTerminalExit}
                      className="h-full rounded-xl"
                    />
                  </div>
                  {/* Stop + steering composer */}
                  <div className="shrink-0 px-6 pb-5 pt-3 space-y-2">
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={handleStopAgent}
                        className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
                      >
                        <StopCircleIcon className="h-3.5 w-3.5" />
                        Stop
                      </button>
                    </div>
                    <div className="flex flex-col gap-0 rounded-2xl border border-border/70 bg-muted/20 px-3 py-2">
                      <textarea
                        ref={agentTextareaRef}
                        value={agentInput}
                        onChange={(e) => setAgentInput(e.target.value)}
                        onKeyDown={handleAgentKeyDown}
                        placeholder="Send instructions to the agent…"
                        rows={1}
                        className="min-h-[36px] max-h-[120px] w-full resize-none overflow-y-auto bg-transparent px-1 py-0.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
                      />
                      <div className="flex items-center justify-end">
                        <button
                          type="button"
                          onClick={handleAgentSubmit}
                          disabled={!agentInput.trim()}
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                        >
                          <SendHorizonalIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                /* No terminal — show start button */
                <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
                  <TerminalIcon className="h-10 w-10 text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground">
                    {assignedAgent
                      ? `Start ${assignedAgent.name} to see the terminal here.`
                      : 'Start an agent to see the terminal here.'}
                  </p>
                  <button
                    type="button"
                    onClick={handleStartAgent}
                    disabled={isStartingAgent}
                    className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
                  >
                    <PlayIcon className="h-3.5 w-3.5" />
                    {isStartingAgent ? 'Starting…' : 'Start'}
                  </button>
                </div>
              )}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

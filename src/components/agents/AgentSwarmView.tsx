/**
 * AgentSwarmView — main panel visualization of all agents in the swarm.
 *
 * Shows a grid of agent cards with status, runtime, current task, and controls.
 * Matches the visual density and style of the TaskQueue / Plugin Marketplace.
 */

import { type FC, useState, useCallback } from 'react';
import {
  BotIcon,
  PlusIcon,
  PlayIcon,
  SquareIcon,
  TerminalIcon,
  BrainIcon,
  ZapIcon,
  Trash2Icon,
  LinkIcon,
  UnlinkIcon,
  TrashIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFullWidthContent } from '@/hooks/useFullWidthContent';
import { useAgents } from '@/providers/AgentProvider';
import { useTasks } from '@/providers/TaskProvider';
import { AgentStatusBadge } from './AgentStatusBadge';
import { HireAgentDialog } from './HireAgentDialog';
import { TaskTerminal } from '@/components/tasks/TaskTerminal';
import type { AgentFile, AgentRuntime, AgentRole } from '../../../shared/agent-types';

const RUNTIME_META: Record<AgentRuntime, { label: string; icon: FC<{ size?: number; className?: string }>; color: string }> = {
  'claude-code': { label: 'Claude Code', icon: TerminalIcon, color: 'text-amber-500' },
  codex: { label: 'Codex', icon: BrainIcon, color: 'text-emerald-500' },
  mastra: { label: 'Mastra', icon: ZapIcon, color: 'text-violet-500' },
};

const ROLE_LABELS: Record<AgentRole, string> = {
  general: 'General',
  engineer: 'Engineer',
  reviewer: 'Reviewer',
  researcher: 'Researcher',
};

export const AgentSwarmView: FC = () => {
  const { state, selectAgent, startAgent, stopAgent, fireAgent } = useAgents();
  const { state: taskState } = useTasks();
  const fullWidth = useFullWidthContent();
  const { agents, selectedAgentId } = state;

  const [hireDialogOpen, setHireDialogOpen] = useState(false);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);

  const getTaskForAgent = (agent: AgentFile) =>
    agent.currentTaskId
      ? taskState.tasks.find((t) => t.id === agent.currentTaskId) ?? null
      : null;

  // Detail view when an agent is selected
  const selectedAgent = selectedAgentId ? agents.find((a) => a.id === selectedAgentId) : null;
  if (selectedAgent) {
    return <AgentDetailPanel agent={selectedAgent} />;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Top gradient fade */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-16 bg-gradient-to-b from-background from-55% to-transparent md:h-20" />

      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto pt-16 md:pt-20">
        <div className={cn('mx-auto w-full px-4 pb-6', !fullWidth && 'max-w-3xl')}>
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Agent Swarm</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {agents.length === 0
                ? 'Hire agents to automate your workflow'
                : `${agents.length} agent${agents.length === 1 ? '' : 's'} · ${agents.filter((a) => a.status === 'running').length} running`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setHireDialogOpen(true)}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            <PlusIcon size={15} />
            Hire Agent
          </button>
        </div>

        {/* Agent Grid */}
        {agents.length === 0 ? (
          <EmptySwarm onHire={() => setHireDialogOpen(true)} />
        ) : (
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
            {agents.map((agent) => (
              <SwarmCard
                key={agent.id}
                agent={agent}
                task={getTaskForAgent(agent)}
                isExpanded={expandedAgentId === agent.id}
                onToggleExpand={() =>
                  setExpandedAgentId(expandedAgentId === agent.id ? null : agent.id)
                }
                onSelect={() => selectAgent(agent.id)}
                onStart={() => void startAgent(agent.id)}
                onStop={() => void stopAgent(agent.id)}
                onFire={() => void fireAgent(agent.id)}
              />
            ))}
          </div>
        )}
        </div>
      </div>

      <HireAgentDialog open={hireDialogOpen} onOpenChange={setHireDialogOpen} />
    </div>
  );
};

// ── Swarm Card ───────────────────────────────────────────────────────────

interface SwarmCardProps {
  agent: AgentFile;
  task: { id: string; title: string; status: string } | null;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onSelect: () => void;
  onStart: () => void;
  onStop: () => void;
  onFire: () => void;
}

const SwarmCard: FC<SwarmCardProps> = ({
  agent,
  task,
  isExpanded,
  onToggleExpand,
  onSelect,
  onStart,
  onStop,
  onFire,
}) => {
  const runtime = RUNTIME_META[agent.runtime];
  const RuntimeIcon = runtime.icon;
  const [confirmFire, setConfirmFire] = useState(false);

  return (
    <div
      className={cn(
        'group relative flex flex-col rounded-xl border border-border/60 bg-card transition-all',
        agent.status === 'running'
          ? 'border-emerald-500/30 shadow-[0_0_0_1px_rgba(16,185,129,0.08)]'
          : 'hover:border-border hover:shadow-sm',
      )}
    >
      {/* Card Header */}
      <div className="flex items-start gap-3 p-4 pb-3 cursor-pointer" onClick={onSelect}>
        {/* Avatar */}
        <div
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg',
            agent.status === 'running'
              ? 'bg-emerald-500/10'
              : 'bg-muted/50',
          )}
        >
          {agent.icon ?? '🤖'}
        </div>

        {/* Info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">
              {agent.name}
            </h3>
            <AgentStatusBadge status={agent.status} />
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="capitalize">{ROLE_LABELS[agent.role]}</span>
            <span className="text-border">·</span>
            <span className={cn('flex items-center gap-1', runtime.color)}>
              <RuntimeIcon size={11} />
              {runtime.label}
            </span>
          </div>
        </div>
      </div>

      {/* Description */}
      {agent.description && (
        <div className="px-4 pb-2">
          <p className="text-xs text-muted-foreground/80 line-clamp-2">
            {agent.description}
          </p>
        </div>
      )}

      {/* Current Task */}
      <div className="px-4 pb-3">
        {task ? (
          <div className="flex items-center gap-2 rounded-lg bg-muted/30 px-2.5 py-1.5 text-xs">
            <LinkIcon size={10} className="text-muted-foreground shrink-0" />
            <span className="truncate text-foreground/80">{task.title}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg bg-muted/20 px-2.5 py-1.5 text-xs text-muted-foreground/50 italic">
            No task assigned
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4 border-t border-border/40 px-4 py-2.5 text-[11px] text-muted-foreground">
        <span>{agent.stats.tasksCompleted} completed</span>
        {agent.stats.lastRunAt && (
          <span>Last: {new Date(agent.stats.lastRunAt).toLocaleDateString()}</span>
        )}
        {agent.stats.crashCount > 0 && (
          <span className="text-red-400">{agent.stats.crashCount} crashes</span>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 border-t border-border/40 px-4 py-2.5">
        {agent.status === 'running' ? (
          <button
            type="button"
            onClick={onStop}
            className="flex items-center gap-1.5 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 transition-colors hover:bg-red-500/20"
          >
            <SquareIcon size={11} />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={onStart}
            disabled={!agent.currentTaskId}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <PlayIcon size={11} />
            Start
          </button>
        )}

        {agent.status === 'running' && agent.terminalSessionId && (
          <button
            type="button"
            onClick={onToggleExpand}
            className="flex items-center gap-1.5 rounded-lg bg-muted/40 px-2.5 py-1.5 text-xs font-medium text-foreground/70 transition-colors hover:bg-muted/60"
          >
            <TerminalIcon size={11} />
            {isExpanded ? 'Hide' : 'Terminal'}
          </button>
        )}

        <div className="flex-1" />

        {confirmFire ? (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => { onFire(); setConfirmFire(false); }}
              className="rounded-md px-2 py-1 text-[10px] font-medium text-red-600 dark:text-red-400 bg-red-500/10 hover:bg-red-500/20 transition-colors"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirmFire(false)}
              className="rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted/50 transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmFire(true)}
            disabled={agent.status === 'running'}
            className="rounded-md p-1.5 text-muted-foreground/40 transition-colors hover:text-red-500 hover:bg-red-500/10 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Fire agent"
          >
            <Trash2Icon size={13} />
          </button>
        )}
      </div>

      {/* Expanded Terminal */}
      {isExpanded && agent.terminalSessionId && (
        <div className="border-t border-border/40 p-2">
          <TaskTerminal sessionId={agent.terminalSessionId} />
        </div>
      )}
    </div>
  );
};

// ── Agent Detail Panel (full-width, shown when an agent is selected) ────

const AgentDetailPanel: FC<{ agent: AgentFile }> = ({ agent }) => {
  const { startAgent, stopAgent, fireAgent, unassignTask, selectAgent } = useAgents();
  const fullWidth = useFullWidthContent();
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [confirmFire, setConfirmFire] = useState(false);

  const runtime = RUNTIME_META[agent.runtime];
  const RuntimeIcon = runtime.icon;

  const handleStart = useCallback(async () => {
    setIsStarting(true);
    try {
      const result = await startAgent(agent.id);
      if (result.error) {
        console.warn('[AgentDetail] Start failed:', result.error);
      }
    } finally {
      setIsStarting(false);
    }
  }, [agent.id, startAgent]);

  const handleStop = useCallback(async () => {
    setIsStopping(true);
    try {
      await stopAgent(agent.id);
    } finally {
      setIsStopping(false);
    }
  }, [agent.id, stopAgent]);

  const handleFire = useCallback(async () => {
    await fireAgent(agent.id);
    selectAgent(null);
  }, [agent.id, fireAgent, selectAgent]);

  const handleUnassign = useCallback(async () => {
    await unassignTask(agent.id);
  }, [agent.id, unassignTask]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Top gradient fade */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-16 bg-gradient-to-b from-background from-55% to-transparent md:h-20" />

      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto pt-16 md:pt-20">
        <div className={cn('mx-auto w-full px-4 pb-6', !fullWidth && 'max-w-3xl')}>
          {/* Agent Header */}
          <div className="mb-6 flex items-start gap-4">
            <div
              className={cn(
                'flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-2xl',
                agent.status === 'running' ? 'bg-emerald-500/10' : 'bg-muted/50',
              )}
            >
              {agent.icon ?? '🤖'}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2.5">
                <h1 className="text-xl font-semibold text-foreground">{agent.name}</h1>
                <AgentStatusBadge status={agent.status} />
              </div>
              <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
                <span className="capitalize">{ROLE_LABELS[agent.role]}</span>
                <span className="text-border">·</span>
                <span className={cn('flex items-center gap-1', runtime.color)}>
                  <RuntimeIcon size={13} />
                  {runtime.label}
                </span>
              </div>
              {agent.description && (
                <p className="mt-2 text-sm text-muted-foreground/80">{agent.description}</p>
              )}
            </div>
          </div>

          {/* Stats */}
          <div className="mb-6 flex items-center gap-6 text-sm text-muted-foreground">
            <span>{agent.stats.tasksCompleted} tasks completed</span>
            {agent.stats.lastRunAt && (
              <span>Last run: {new Date(agent.stats.lastRunAt).toLocaleDateString()}</span>
            )}
            {agent.stats.crashCount > 0 && (
              <span className="text-red-400">{agent.stats.crashCount} crashes</span>
            )}
          </div>

          {/* Task Assignment */}
          <div className="mb-6 rounded-xl border border-border/60 bg-card p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-foreground">Current Task</span>
              {agent.currentTaskId && agent.status !== 'running' && (
                <button
                  type="button"
                  onClick={() => void handleUnassign()}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
                >
                  <UnlinkIcon size={11} />
                  Unassign
                </button>
              )}
            </div>
            {agent.currentTaskId ? (
              <div className="flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-2 text-sm">
                <LinkIcon size={12} className="text-muted-foreground shrink-0" />
                <span className="truncate text-foreground/80">Task assigned</span>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground/60 italic">
                No task assigned. Assign a task from the task queue.
              </p>
            )}
          </div>

          {/* Controls */}
          <div className="mb-6 rounded-xl border border-border/60 bg-card p-4">
            <span className="text-sm font-medium text-foreground block mb-3">Controls</span>
            <div className="flex gap-2">
              {agent.status === 'running' ? (
                <button
                  type="button"
                  onClick={() => void handleStop()}
                  disabled={isStopping}
                  className="flex items-center gap-1.5 rounded-lg bg-red-500/10 px-3.5 py-2 text-sm font-medium text-red-600 dark:text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
                >
                  <SquareIcon size={13} />
                  {isStopping ? 'Stopping...' : 'Stop'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleStart()}
                  disabled={isStarting || !agent.currentTaskId}
                  className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3.5 py-2 text-sm font-medium text-emerald-600 dark:text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <PlayIcon size={13} />
                  {isStarting ? 'Starting...' : 'Start'}
                </button>
              )}
            </div>
            {!agent.currentTaskId && agent.status !== 'running' && (
              <p className="mt-2 text-xs text-muted-foreground/60">
                Assign a task before starting the agent.
              </p>
            )}
          </div>

          {/* Terminal (when running) */}
          {agent.status === 'running' && agent.terminalSessionId && (
            <div className="mb-6 rounded-xl border border-border/60 bg-card overflow-hidden">
              <div className="px-4 py-2.5 border-b border-border/40">
                <span className="text-sm font-medium text-foreground flex items-center gap-2">
                  <TerminalIcon size={13} />
                  Terminal
                </span>
              </div>
              <div className="p-2">
                <TaskTerminal sessionId={agent.terminalSessionId} />
              </div>
            </div>
          )}

          {/* Danger Zone */}
          <div className="rounded-xl border border-red-500/20 bg-card p-4">
            <span className="text-sm font-medium text-foreground block mb-3">Danger Zone</span>
            {confirmFire ? (
              <div className="flex items-center gap-3">
                <span className="text-sm text-red-500">Are you sure you want to fire this agent?</span>
                <button
                  type="button"
                  onClick={() => void handleFire()}
                  className="rounded-lg bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-500/20 transition-colors"
                >
                  Yes, fire
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmFire(false)}
                  className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted/50 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmFire(true)}
                disabled={agent.status === 'running'}
                className="flex items-center gap-1.5 text-sm text-muted-foreground/60 hover:text-red-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <TrashIcon size={13} />
                Fire agent
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ── Empty State ──────────────────────────────────────────────────────────

const EmptySwarm: FC<{ onHire: () => void }> = ({ onHire }) => (
  <div className="flex flex-col items-center justify-center py-24 text-center">
    <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/30 text-muted-foreground">
      <BotIcon size={32} strokeWidth={1.2} />
    </div>
    <h2 className="mb-1.5 text-lg font-semibold text-foreground/80">Your swarm is empty</h2>
    <p className="mb-6 max-w-sm text-sm text-muted-foreground leading-relaxed">
      Hire agents to build your swarm. Each agent has a dedicated runtime and can work on tasks
      from your board autonomously.
    </p>
    <button
      type="button"
      onClick={onHire}
      className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
    >
      <PlusIcon size={16} />
      Hire Your First Agent
    </button>
  </div>
);

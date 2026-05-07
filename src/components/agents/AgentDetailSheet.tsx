/**
 * AgentDetailSheet — slide-over detail panel for a selected agent.
 *
 * Shows agent info, config, current task, and Start/Stop controls.
 * When running, embeds the terminal view.
 */

import { type FC, useState, useCallback } from 'react';
import {
  XIcon,
  PlayIcon,
  SquareIcon,
  TrashIcon,
  BotIcon,
  TerminalIcon,
  BrainIcon,
  ZapIcon,
  LinkIcon,
  UnlinkIcon,
} from 'lucide-react';
import { useAgents } from '@/providers/AgentProvider';
import { AgentStatusBadge } from './AgentStatusBadge';
import { TaskTerminal } from '@/components/tasks/TaskTerminal';
import type { AgentFile, AgentRuntime } from '../../../shared/agent-types';

const RUNTIME_LABELS: Record<AgentRuntime, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  mastra: 'Mastra',
};

const RUNTIME_ICONS: Record<AgentRuntime, FC<{ size?: number; className?: string }>> = {
  'claude-code': TerminalIcon,
  codex: BrainIcon,
  mastra: ZapIcon,
};

const ROLE_LABELS: Record<string, string> = {
  general: 'General',
  engineer: 'Engineer',
  reviewer: 'Reviewer',
  researcher: 'Researcher',
};

interface AgentDetailSheetProps {
  agent: AgentFile;
  onClose: () => void;
}

export const AgentDetailSheet: FC<AgentDetailSheetProps> = ({ agent, onClose }) => {
  const { startAgent, stopAgent, fireAgent, unassignTask } = useAgents();
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [confirmFire, setConfirmFire] = useState(false);

  const RuntimeIcon = RUNTIME_ICONS[agent.runtime] ?? TerminalIcon;

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
    onClose();
  }, [agent.id, fireAgent, onClose]);

  const handleUnassign = useCallback(async () => {
    await unassignTask(agent.id);
  }, [agent.id, unassignTask]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border/50 px-4 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
          {agent.icon ? (
            <span className="text-lg">{agent.icon}</span>
          ) : (
            <BotIcon size={18} strokeWidth={1.5} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold">{agent.name}</h2>
            <AgentStatusBadge status={agent.status} />
          </div>
          <div className="text-xs text-muted-foreground">
            {ROLE_LABELS[agent.role] ?? agent.role}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
        >
          <XIcon size={15} />
        </button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Info Section */}
        <div className="border-b border-border/30 px-4 py-3 space-y-2">
          {agent.description && (
            <p className="text-xs text-muted-foreground">{agent.description}</p>
          )}
          <div className="flex items-center gap-2 text-xs">
            <RuntimeIcon size={12} className="text-muted-foreground" />
            <span className="text-muted-foreground">{RUNTIME_LABELS[agent.runtime]}</span>
          </div>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span>{agent.stats.tasksCompleted} tasks completed</span>
            {agent.stats.lastRunAt && (
              <span>Last run: {new Date(agent.stats.lastRunAt).toLocaleDateString()}</span>
            )}
          </div>
        </div>

        {/* Task Assignment */}
        <div className="border-b border-border/30 px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Current Task</span>
            {agent.currentTaskId && agent.status !== 'running' && (
              <button
                type="button"
                onClick={() => void handleUnassign()}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
              >
                <UnlinkIcon size={10} />
                Unassign
              </button>
            )}
          </div>
          {agent.currentTaskId ? (
            <div className="mt-1.5 flex items-center gap-1.5 rounded-md bg-muted/30 px-2 py-1.5 text-xs">
              <LinkIcon size={10} className="text-muted-foreground shrink-0" />
              <span className="truncate text-foreground/80">Task assigned</span>
            </div>
          ) : (
            <p className="mt-1.5 text-xs text-muted-foreground/60 italic">
              No task assigned. Assign a task from the task board.
            </p>
          )}
        </div>

        {/* Controls */}
        <div className="border-b border-border/30 px-4 py-3">
          <div className="flex gap-2">
            {agent.status === 'running' ? (
              <button
                type="button"
                onClick={() => void handleStop()}
                disabled={isStopping}
                className="flex items-center gap-1.5 rounded-lg bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
              >
                <SquareIcon size={12} />
                {isStopping ? 'Stopping...' : 'Stop'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleStart()}
                disabled={isStarting || !agent.currentTaskId}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <PlayIcon size={12} />
                {isStarting ? 'Starting...' : 'Start'}
              </button>
            )}
          </div>
          {!agent.currentTaskId && agent.status !== 'running' && (
            <p className="mt-1.5 text-[10px] text-muted-foreground/60">
              Assign a task before starting the agent.
            </p>
          )}
        </div>

        {/* Terminal (when running) */}
        {agent.status === 'running' && agent.terminalSessionId && (
          <div className="px-2 py-2">
            <TaskTerminal sessionId={agent.terminalSessionId} />
          </div>
        )}

        {/* Danger Zone */}
        <div className="px-4 py-3">
          {confirmFire ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-500">Are you sure?</span>
              <button
                type="button"
                onClick={() => void handleFire()}
                className="rounded-md bg-red-500/10 px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-500/20 transition-colors"
              >
                Yes, fire
              </button>
              <button
                type="button"
                onClick={() => setConfirmFire(false)}
                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmFire(true)}
              disabled={agent.status === 'running'}
              className="flex items-center gap-1.5 text-xs text-muted-foreground/60 hover:text-red-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <TrashIcon size={12} />
              Fire agent
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

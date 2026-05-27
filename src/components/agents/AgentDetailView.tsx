/**
 * AgentDetailView — configuration panel for a selected agent.
 *
 * Shows instructions editor, runtime/role config, stats, and a read-only
 * terminal viewer when the agent is actively running.
 */

import { type FC, useState, useEffect, useRef, useCallback } from 'react';
import {
  BotIcon,
  TerminalIcon,
  Trash2Icon,
  Loader2Icon,
  ClipboardListIcon,
  ArrowRightIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFullWidthContent } from '@/hooks/useFullWidthContent';
import { useAgents } from '@/providers/AgentProvider';
import { useTasks } from '@/providers/TaskProvider';
import { AgentStatusBadge } from './AgentStatusBadge';
import { RuntimePicker } from './RuntimePicker';
import { DeleteAgentModal } from './DeleteAgentModal';
import { TaskTerminal } from '@/components/tasks/TaskTerminal';
import type { AgentFile, AgentRuntime } from '../../../shared/agent-types';

// ── Component ────────────────────────────────────────────────────────────

interface AgentDetailViewProps {
  agent: AgentFile;
}

export const AgentDetailView: FC<AgentDetailViewProps> = ({ agent }) => {
  const { updateAgent, deleteAgent, selectAgent, state } = useAgents();
  const { state: taskState } = useTasks();
  const fullWidth = useFullWidthContent();

  const isSynthesizing = state.synthesizingIds.has(agent.id);
  const isPending = agent.name === 'New Agent';

  const [instructions, setInstructions] = useState(agent.instructions ?? '');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync instructions when agent changes externally
  useEffect(() => {
    setInstructions(agent.instructions ?? '');
  }, [agent.id, agent.instructions]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 400) + 'px';
  }, [instructions]);

  // Debounced save for instructions
  const handleInstructionsChange = useCallback(
    (value: string) => {
      setInstructions(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void updateAgent(agent.id, { instructions: value });
      }, 500);
    },
    [agent.id, updateAgent],
  );

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleRuntimeChange = useCallback(
    (runtime: AgentRuntime) => {
      void updateAgent(agent.id, { runtime });
    },
    [agent.id, updateAgent],
  );

  const handleDelete = useCallback(async () => {
    await deleteAgent(agent.id);
    selectAgent(null);
  }, [agent.id, deleteAgent, selectAgent]);

  // Cross-nav: jump to the task this agent is currently working on
  const currentTask = agent.currentTaskId
    ? taskState.tasks.find((t) => t.id === agent.currentTaskId)
    : null;

  const handleNavigateToTask = useCallback(() => {
    if (!agent.currentTaskId) return;
    window.dispatchEvent(
      new CustomEvent('kai:navigate', {
        detail: { tab: 'tasks', selectedId: agent.currentTaskId },
      }),
    );
  }, [agent.currentTaskId]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Top gradient fade */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-16 bg-gradient-to-b from-background from-55% to-transparent md:h-20" />

      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto pt-16 md:pt-20">
        <div className={cn('mx-auto w-full px-5 pb-6', !fullWidth && 'max-w-3xl')}>
          {/* Agent Header */}
          <div className="mb-8 flex items-center gap-3">
            <div
              className={cn(
                'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg',
                agent.status === 'running' ? 'bg-emerald-500/10' : 'bg-muted/50',
              )}
            >
              {agent.icon ?? <BotIcon size={18} className="text-muted-foreground" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className={cn(
                  'truncate text-base font-semibold',
                  isPending ? 'italic text-muted-foreground/50' : 'text-foreground',
                )}>{agent.name}</h2>
                <AgentStatusBadge status={agent.status} />
              </div>
            </div>
          </div>

          {/* Cross-nav: currently working on task */}
          {agent.currentTaskId && (
            <button
              type="button"
              onClick={handleNavigateToTask}
              className="group mb-6 flex w-full items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 text-left transition-colors hover:border-[var(--brand-accent)]/40 hover:bg-[var(--brand-accent)]/5"
            >
              <ClipboardListIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                  Currently working on
                </p>
                <p className="truncate text-sm text-foreground">
                  {currentTask?.title ?? 'Open task'}
                </p>
              </div>
              <ArrowRightIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--brand-accent)]" />
            </button>
          )}

          {/* Instructions Editor */}
          <div className="mb-6">
            <label className="mb-2 block text-sm font-medium text-foreground">
              Instructions
            </label>
            <p className="mb-3 text-xs text-muted-foreground">
              System prompt for this agent. Defines how it should behave, what it focuses on, and its constraints.
            </p>
            <div className="relative">
              <textarea
                ref={textareaRef}
                value={instructions}
                onChange={(e) => handleInstructionsChange(e.target.value)}
                placeholder="Tell this agent what to do, how to behave, what to focus on..."
                rows={6}
                disabled={isSynthesizing}
                className={cn(
                  'w-full resize-none rounded-xl border border-border/60 bg-background px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20 transition-opacity',
                  isSynthesizing && 'opacity-40 cursor-not-allowed',
                )}
              />
              {isSynthesizing && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl">
                  <div className="flex items-center gap-2 rounded-lg bg-background/80 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur-sm border border-border/40">
                    <Loader2Icon size={12} className="animate-spin" />
                    Generating system prompt…
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Terminal (read-only, shown when agent is running) */}
          {agent.status === 'running' && agent.terminalSessionId && (
            <div className="mb-6 rounded-xl border border-border/60 bg-card overflow-hidden">
              <div className="px-4 py-2.5 border-b border-border/40">
                <span className="text-sm font-medium text-foreground flex items-center gap-2">
                  <TerminalIcon size={13} />
                  Live Output
                </span>
              </div>
              <div className="p-2">
                <TaskTerminal sessionId={agent.terminalSessionId} />
              </div>
            </div>
          )}

          {/* Configuration */}
          <div className="mb-6 rounded-xl border border-border/60 bg-card p-4">
            <span className="text-sm font-medium text-foreground block mb-4">Configuration</span>

            {/* Runtime */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Runtime
              </label>
              <RuntimePicker value={agent.runtime} onChange={handleRuntimeChange} />
            </div>

          </div>

          {/* Stats */}
          <div className="mb-6 rounded-xl border border-border/60 bg-card p-4">
            <span className="text-sm font-medium text-foreground block mb-3">Activity</span>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-xs text-muted-foreground">Tasks completed</span>
                <p className="font-medium text-foreground">{agent.stats.tasksCompleted}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Total runtime</span>
                <p className="font-medium text-foreground">
                  {agent.stats.totalRuntime > 0
                    ? `${Math.round(agent.stats.totalRuntime / 60)}m`
                    : '—'}
                </p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Last run</span>
                <p className="font-medium text-foreground">
                  {agent.stats.lastRunAt
                    ? new Date(agent.stats.lastRunAt).toLocaleDateString()
                    : '—'}
                </p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Crashes</span>
                <p className={cn('font-medium', agent.stats.crashCount > 0 ? 'text-red-400' : 'text-foreground')}>
                  {agent.stats.crashCount}
                </p>
              </div>
            </div>
          </div>

          {/* Danger Zone */}
          <div className="rounded-xl border border-red-500/20 bg-card p-4">
            <span className="text-sm font-medium text-foreground block mb-3">Danger Zone</span>
            <button
              type="button"
              onClick={() => setShowDeleteModal(true)}
              className="flex items-center gap-1.5 text-sm text-muted-foreground/60 hover:text-red-500 transition-colors"
            >
              <Trash2Icon size={13} />
              Delete agent
            </button>
          </div>

          {/* Delete confirmation modal */}
          {showDeleteModal && (
            <DeleteAgentModal
              agentName={agent.name}
              onConfirm={() => void handleDelete()}
              onClose={() => setShowDeleteModal(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
};

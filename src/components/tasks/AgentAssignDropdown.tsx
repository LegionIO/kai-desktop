/**
 * AgentAssignDropdown — dropdown for assigning/reassigning an agent to a task.
 *
 * Groups agents by status: idle (selectable), running (disabled), error (disabled).
 * Supports `inline`, `badge`, and `button` triggers.
 */

import { type FC, useMemo } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { BotIcon, UserMinusIcon, PlusIcon, ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAgents } from '@/providers/AgentProvider';
import { app } from '@/lib/ipc-client';
import type { AgentFile } from '../../../shared/agent-types';

interface AgentAssignDropdownProps {
  taskId: string;
  currentAgentId?: string;
  onAssigned?: (agentId: string) => void;
  onUnassigned?: () => void;
  variant?: 'badge' | 'button' | 'inline';
  disabled?: boolean;
}

const ROLE_BADGE_COLORS: Record<string, string> = {
  general: 'bg-zinc-500/10 text-zinc-500',
  engineer: 'bg-blue-500/10 text-blue-500',
  reviewer: 'bg-purple-500/10 text-purple-400',
  researcher: 'bg-emerald-500/10 text-emerald-500',
};

const itemClassName =
  'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50';

export const AgentAssignDropdown: FC<AgentAssignDropdownProps> = ({
  taskId,
  currentAgentId,
  onAssigned,
  onUnassigned,
  variant = 'inline',
  disabled = false,
}) => {
  const { state } = useAgents();

  const currentAgent = currentAgentId ? (state.agents.find((a) => a.id === currentAgentId) ?? null) : null;

  const { idle, running, error } = useMemo(() => {
    const idle: AgentFile[] = [];
    const running: AgentFile[] = [];
    const error: AgentFile[] = [];
    for (const a of state.agents) {
      if (a.status === 'idle') idle.push(a);
      else if (a.status === 'running') running.push(a);
      else error.push(a);
    }
    return { idle, running, error };
  }, [state.agents]);

  const handleAssign = async (agentId: string) => {
    try {
      const result = await app.agents.assignTask(agentId, taskId);
      if (result?.ok) onAssigned?.(agentId);
    } catch (err) {
      console.error('[AgentAssignDropdown] assign failed:', err);
    }
  };

  const handleUnassign = async () => {
    if (!currentAgentId) return;
    try {
      const result = await app.agents.unassignTask(currentAgentId);
      if (result?.ok) onUnassigned?.();
    } catch (err) {
      console.error('[AgentAssignDropdown] unassign failed:', err);
    }
  };

  // ── Trigger ───────────────────────────────────────────────────────────
  const renderTrigger = () => {
    if (variant === 'badge') {
      return currentAgent ? (
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[11px] text-foreground/80 hover:bg-muted disabled:opacity-50"
        >
          <span>{currentAgent.icon ?? <BotIcon className="h-3 w-3" />}</span>
          <span className="truncate max-w-[100px]">{currentAgent.name}</span>
          <ChevronDownIcon className="h-3 w-3 opacity-60" />
        </button>
      ) : (
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-full bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/60 hover:text-foreground/80 disabled:opacity-50"
        >
          <PlusIcon className="h-3 w-3" />
          <span>Assign</span>
        </button>
      );
    }

    if (variant === 'button') {
      return (
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1.5 text-xs text-foreground/80 hover:bg-muted/60 disabled:opacity-50"
        >
          {currentAgent ? (
            <>
              <span>{currentAgent.icon ?? <BotIcon className="h-3.5 w-3.5" />}</span>
              <span className="truncate max-w-[120px]">{currentAgent.name}</span>
            </>
          ) : (
            <>
              <PlusIcon className="h-3.5 w-3.5" />
              <span>Assign Agent</span>
            </>
          )}
          <ChevronDownIcon className="h-3 w-3 opacity-60" />
        </button>
      );
    }

    // inline
    return currentAgent ? (
      <button
        type="button"
        disabled={disabled}
        className="inline-flex items-center gap-1 text-xs text-foreground/80 hover:text-foreground disabled:opacity-50"
      >
        <span>{currentAgent.icon ?? '🤖'}</span>
        <span className="truncate max-w-[140px]">{currentAgent.name}</span>
        <ChevronDownIcon className="h-3 w-3 opacity-60" />
      </button>
    ) : (
      <button
        type="button"
        disabled={disabled}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-foreground/80 disabled:opacity-50"
      >
        <PlusIcon className="h-3 w-3" />
        <span>Assign</span>
      </button>
    );
  };

  // ── Item helper ───────────────────────────────────────────────────────
  const renderAgentItem = (agent: AgentFile, isDisabled: boolean, statusHint?: string) => (
    <DropdownMenu.Item
      key={agent.id}
      disabled={isDisabled}
      className={itemClassName}
      onSelect={(e) => {
        if (isDisabled) {
          e.preventDefault();
          return;
        }
        void handleAssign(agent.id);
      }}
      title={statusHint}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-sm">
        {agent.icon ?? <BotIcon className="h-3.5 w-3.5 text-muted-foreground" />}
      </span>
      <span className="flex-1 truncate text-foreground">{agent.name}</span>
      <span
        className={cn(
          'ml-2 inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-medium',
          ROLE_BADGE_COLORS[agent.role] ?? ROLE_BADGE_COLORS.general,
        )}
      >
        {agent.role}
      </span>
    </DropdownMenu.Item>
  );

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        {renderTrigger()}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-50 min-w-[240px] rounded-xl border border-border/70 bg-popover/95 p-1.5 text-popover-foreground shadow-xl backdrop-blur-md"
        >
          {state.agents.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              No agents available. Create one from the Agents view.
            </div>
          ) : (
            <>
              {idle.length > 0 && (
                <DropdownMenu.Group>
                  <DropdownMenu.Label className="px-2 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Idle
                  </DropdownMenu.Label>
                  {idle.map((a) => renderAgentItem(a, false))}
                </DropdownMenu.Group>
              )}

              {running.length > 0 && (
                <DropdownMenu.Group>
                  <DropdownMenu.Separator className="my-1 h-px bg-border/60" />
                  <DropdownMenu.Label className="px-2 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Running
                  </DropdownMenu.Label>
                  {running.map((a) => renderAgentItem(a, true, 'Agent is currently running another task'))}
                </DropdownMenu.Group>
              )}

              {error.length > 0 && (
                <DropdownMenu.Group>
                  <DropdownMenu.Separator className="my-1 h-px bg-border/60" />
                  <DropdownMenu.Label className="px-2 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Error
                  </DropdownMenu.Label>
                  {error.map((a) => renderAgentItem(a, true, 'Agent is in an error state'))}
                </DropdownMenu.Group>
              )}

              {currentAgentId && (
                <>
                  <DropdownMenu.Separator className="my-1 h-px bg-border/60" />
                  <DropdownMenu.Item
                    className={cn(itemClassName, 'text-destructive data-[highlighted]:bg-destructive/10')}
                    onSelect={() => {
                      void handleUnassign();
                    }}
                  >
                    <UserMinusIcon className="h-3.5 w-3.5" />
                    <span>Unassign</span>
                  </DropdownMenu.Item>
                </>
              )}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};

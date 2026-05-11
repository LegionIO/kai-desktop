/**
 * AgentRosterView — vertical list of all agents.
 *
 * Displayed as the default main view when no agent is selected and the user
 * is not in creation mode. Each item is clickable to navigate to the detail view.
 */

import type { FC } from 'react';
import {
  BotIcon,
  PlusIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFullWidthContent } from '@/hooks/useFullWidthContent';
import { useAgents } from '@/providers/AgentProvider';
import { AgentStatusBadge } from './AgentStatusBadge';
import type { AgentFile } from '../../../shared/agent-types';

// ── Component ────────────────────────────────────────────────────────────

export const AgentRosterView: FC = () => {
  const { state, selectAgent, setCreatingAgent } = useAgents();
  const fullWidth = useFullWidthContent();
  const { agents } = state;

  if (agents.length === 0) {
    return <EmptyRoster onCreate={() => setCreatingAgent(true)} />;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Top gradient fade */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-16 bg-gradient-to-b from-background from-55% to-transparent md:h-20" />

      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto pt-16 md:pt-20">
        <div className={cn('mx-auto w-full px-5 pb-6', !fullWidth && 'max-w-3xl')}>
          <div className="space-y-1">
            {agents.map((agent) => (
              <RosterItem
                key={agent.id}
                agent={agent}
                onClick={() => selectAgent(agent.id)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// ── Roster Item ──────────────────────────────────────────────────────────

interface RosterItemProps {
  agent: AgentFile;
  onClick: () => void;
}

const RosterItem: FC<RosterItemProps> = ({ agent, onClick }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-all hover:bg-muted/40"
    >
      {/* Avatar */}
      <div
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base',
          agent.status === 'running' ? 'bg-emerald-500/10' : 'bg-muted/50',
        )}
      >
        {agent.icon ?? <BotIcon size={16} className="text-muted-foreground" />}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {agent.name}
          </span>
          <AgentStatusBadge status={agent.status} />
        </div>
        {agent.instructions && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {agent.instructions}
          </p>
        )}
      </div>

      {/* Stats hint */}
      {agent.stats.tasksCompleted > 0 && (
        <span className="shrink-0 text-[11px] text-muted-foreground/60">
          {agent.stats.tasksCompleted} tasks
        </span>
      )}
    </button>
  );
};

// ── Empty State ──────────────────────────────────────────────────────────

const EmptyRoster: FC<{ onCreate: () => void }> = ({ onCreate }) => (
  <div className="flex h-full flex-col items-center justify-center text-center px-4">
    <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/30 text-muted-foreground">
      <BotIcon size={28} strokeWidth={1.2} />
    </div>
    <h2 className="mb-1.5 text-base font-semibold text-foreground/80">No agents yet</h2>
    <p className="mb-5 max-w-xs text-sm text-muted-foreground leading-relaxed">
      Create an agent to help with your workflow. Describe what it should do and it will be ready to go.
    </p>
    <button
      type="button"
      onClick={onCreate}
      className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
    >
      <PlusIcon size={15} />
      Create Your First Agent
    </button>
  </div>
);

/**
 * AgentCard — compact card displaying agent info in the sidebar list.
 */

import type { FC } from 'react';
import { BotIcon, TerminalIcon, BrainIcon, ZapIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AgentStatusBadge } from './AgentStatusBadge';
import type { AgentFile, AgentRuntime } from '../../../shared/agent-types';

const RUNTIME_ICONS: Record<AgentRuntime, FC<{ size?: number; className?: string }>> = {
  'claude-code': TerminalIcon,
  codex: BrainIcon,
  mastra: ZapIcon,
};

const RUNTIME_LABELS: Record<AgentRuntime, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  mastra: 'Mastra',
};

interface AgentCardProps {
  agent: AgentFile;
  isSelected: boolean;
  onClick: () => void;
}

export const AgentCard: FC<AgentCardProps> = ({ agent, isSelected, onClick }) => {
  const RuntimeIcon = RUNTIME_ICONS[agent.runtime] ?? TerminalIcon;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
        isSelected
          ? 'bg-sidebar-accent/80 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]'
          : 'hover:bg-sidebar-accent/40',
      )}
    >
      {/* Avatar */}
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
        {agent.icon ? (
          <span className="text-base">{agent.icon}</span>
        ) : (
          <BotIcon size={16} strokeWidth={1.6} />
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-sidebar-foreground">
            {agent.name}
          </span>
          <AgentStatusBadge status={agent.status} />
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <RuntimeIcon size={11} />
          <span>{RUNTIME_LABELS[agent.runtime]}</span>
          {agent.currentTaskId && (
            <>
              <span className="text-border">·</span>
              <span className="truncate">Working on task</span>
            </>
          )}
        </div>
      </div>
    </button>
  );
};

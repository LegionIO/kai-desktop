/**
 * AgentCard — sidebar item for agents, matching the ConversationList item pattern.
 *
 * Styled consistently with chat and task sidebar items: same padding,
 * hover/active states, group-hover triple-dots button, right-click support.
 */

import type { FC, MouseEvent } from 'react';
import { BotIcon, EllipsisVerticalIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AgentStatusBadge } from './AgentStatusBadge';
import type { AgentFile } from '../../../shared/agent-types';

function formatRelativeTime(timestamp: string | undefined): string {
  if (!timestamp) return '';
  const diffMs = Date.now() - new Date(timestamp).getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  if (diffMs < 604_800_000) return `${Math.floor(diffMs / 86_400_000)}d ago`;
  return `${Math.floor(diffMs / 604_800_000)}w ago`;
}

interface AgentCardProps {
  agent: AgentFile;
  isSelected: boolean;
  onClick: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  onMoreClick?: (e: MouseEvent) => void;
}

export const AgentCard: FC<AgentCardProps> = ({ agent, isSelected, onClick, onContextMenu, onMoreClick }) => {
  const isPending = agent.name === 'New Agent';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
      className={cn(
        'group flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm cursor-pointer transition-all',
        isSelected
          ? 'shadow-[inset_0_0_0_1px_var(--app-active-item-ring)]'
          : 'hover:bg-sidebar-accent/65',
      )}
      style={isSelected ? { backgroundColor: 'var(--app-active-item)' } : undefined}
    >
      {/* Icon */}
      <BotIcon
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          isSelected ? 'text-primary' : 'text-muted-foreground',
        )}
      />

      {/* Content */}
      <div className="flex flex-col flex-1 min-w-0">
        <span className={cn(
          'line-clamp-2 text-sm font-medium',
          isPending
            ? 'italic text-sidebar-foreground/50'
            : 'text-sidebar-foreground/95',
        )}>
          {agent.name}
        </span>
        <div className="mt-1 flex items-center text-[12px] text-muted-foreground">
          <AgentStatusBadge status={agent.status} className="!px-0 !py-0 !bg-transparent !text-[12px] !font-normal !text-muted-foreground !tracking-normal !normal-case" />
          {(() => {
            const ts = agent.stats?.lastRunAt ?? agent.updatedAt;
            const rel = formatRelativeTime(ts);
            if (!rel) return null;
            return (
              <>
                <span className="mx-1">·</span>
                {agent.status === 'running' ? (
                  <div className="flex items-center gap-0.5 px-1">
                    <div className="h-1 w-1 rounded-full bg-primary animate-bounce [animation-delay:0ms]" />
                    <div className="h-1 w-1 rounded-full bg-primary animate-bounce [animation-delay:150ms]" />
                    <div className="h-1 w-1 rounded-full bg-primary animate-bounce [animation-delay:300ms]" />
                  </div>
                ) : rel}
              </>
            );
          })()}
        </div>
      </div>

      {/* Right actions: triple-dots */}
      <div className="ml-1 flex shrink-0 self-stretch items-center">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onMoreClick?.(e); }}
          className="shrink-0 rounded p-0.5 opacity-0 transition-all group-hover:opacity-100 hover:bg-sidebar-accent"
          title="More options"
          aria-label="More options"
        >
          <EllipsisVerticalIcon className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>
    </div>
  );
};

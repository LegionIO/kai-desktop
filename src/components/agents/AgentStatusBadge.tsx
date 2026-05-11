/**
 * AgentStatusBadge — colored status indicator for agent state.
 */

import type { FC } from 'react';
import { cn } from '@/lib/utils';
import type { AgentStatus } from '../../../shared/agent-types';

const STATUS_CONFIG: Record<AgentStatus, { label: string; dotColor: string; bgColor: string; textColor: string }> = {
  idle: {
    label: 'Idle',
    dotColor: 'bg-zinc-400',
    bgColor: 'bg-zinc-500/10',
    textColor: 'text-zinc-500',
  },
  running: {
    label: 'Running',
    dotColor: 'bg-emerald-500 animate-pulse',
    bgColor: 'bg-emerald-500/10',
    textColor: 'text-emerald-600 dark:text-emerald-400',
  },
  error: {
    label: 'Error',
    dotColor: 'bg-red-500',
    bgColor: 'bg-red-500/10',
    textColor: 'text-red-600 dark:text-red-400',
  },
};

interface AgentStatusBadgeProps {
  status: AgentStatus;
  className?: string;
}

export const AgentStatusBadge: FC<AgentStatusBadgeProps> = ({ status, className }) => {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium',
        config.bgColor,
        config.textColor,
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', config.dotColor)} />
      {config.label}
    </span>
  );
};

/**
 * CouncilMessageBubble — renders a single council message with agent avatar and styling.
 *
 * Different styling per agent:
 * - Aithena (advisor): purple accent, shield icon
 * - Aidan (planner): blue accent, code icon
 * - Airen (reviewer): green accent, check icon
 * - User: standard user bubble (right-aligned)
 */

import { memo, type FC } from 'react';
import { ShieldCheckIcon, CodeIcon, CheckCircleIcon, UserIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownText } from '@/components/thread/MarkdownText';
import type { CouncilMessage } from '../../../shared/task-types';

const AGENT_CONFIG: Record<CouncilMessage['agent'], {
  label: string;
  icon: FC<{ className?: string }>;
  accentColor: string;
  bgColor: string;
  borderColor: string;
}> = {
  aithena: {
    label: 'Aithena',
    icon: ShieldCheckIcon,
    accentColor: 'text-purple-400',
    bgColor: 'bg-purple-500/5',
    borderColor: 'border-purple-500/20',
  },
  aidan: {
    label: 'Aidan',
    icon: CodeIcon,
    accentColor: 'text-blue-400',
    bgColor: 'bg-blue-500/5',
    borderColor: 'border-blue-500/20',
  },
  airen: {
    label: 'Airen',
    icon: CheckCircleIcon,
    accentColor: 'text-emerald-400',
    bgColor: 'bg-emerald-500/5',
    borderColor: 'border-emerald-500/20',
  },
  user: {
    label: 'You',
    icon: UserIcon,
    accentColor: 'text-foreground/70',
    bgColor: 'bg-muted/30',
    borderColor: 'border-border/40',
  },
};

interface CouncilMessageBubbleProps {
  message: CouncilMessage;
}

export const CouncilMessageBubble: FC<CouncilMessageBubbleProps> = memo(({ message }) => {
  const config = AGENT_CONFIG[message.agent];
  const Icon = config.icon;
  const isUser = message.agent === 'user';
  const isOutcome = message.type === 'outcome';

  return (
    <div className={cn('flex gap-3', isUser && 'flex-row-reverse')}>
      {/* Avatar */}
      <div className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border',
        config.borderColor,
        config.bgColor,
      )}>
        <Icon className={cn('h-3.5 w-3.5', config.accentColor)} />
      </div>

      {/* Content */}
      <div className={cn(
        'min-w-0 max-w-[85%] rounded-xl border px-3.5 py-2.5',
        config.borderColor,
        config.bgColor,
        isOutcome && 'border-amber-500/30 bg-amber-500/5',
      )}>
        {/* Agent name + timestamp */}
        <div className="mb-1 flex items-center gap-2">
          <span className={cn('text-[11px] font-semibold', config.accentColor)}>
            {config.label}
          </span>
          {message.phase && (
            <span className="text-[10px] text-muted-foreground/50">
              {message.phase}
            </span>
          )}
        </div>

        {/* Message content */}
        <div className="prose prose-sm prose-invert max-w-none text-sm text-foreground/90 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <MarkdownText text={message.content} />
        </div>
      </div>
    </div>
  );
});

CouncilMessageBubble.displayName = 'CouncilMessageBubble';

/** Typing indicator shown while an agent is streaming. */
export const CouncilTypingIndicator: FC<{ agent: string }> = memo(({ agent }) => {
  const config = AGENT_CONFIG[agent as CouncilMessage['agent']] ?? AGENT_CONFIG.aithena;
  const Icon = config.icon;

  return (
    <div className="flex items-center gap-3">
      <div className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border',
        config.borderColor,
        config.bgColor,
      )}>
        <Icon className={cn('h-3.5 w-3.5', config.accentColor)} />
      </div>
      <div className={cn(
        'flex items-center gap-1.5 rounded-xl border px-3.5 py-2.5',
        config.borderColor,
        config.bgColor,
      )}>
        <div className="flex gap-1">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:0ms]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/40 [animation-delay:300ms]" />
        </div>
        <span className={cn('text-[11px]', config.accentColor)}>
          {config.label} is thinking...
        </span>
      </div>
    </div>
  );
});

CouncilTypingIndicator.displayName = 'CouncilTypingIndicator';

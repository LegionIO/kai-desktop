/**
 * RuntimePicker — radio group for selecting an agent's primary runtime.
 */

import type { FC } from 'react';
import { TerminalIcon, BrainIcon, ZapIcon, SparklesIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentRuntime } from '../../../shared/agent-types';

interface RuntimeOption {
  id: AgentRuntime;
  label: string;
  description: string;
  icon: FC<{ className?: string; size?: number }>;
}

const RUNTIME_OPTIONS: RuntimeOption[] = [
  {
    id: 'auto',
    label: 'Auto',
    description: 'Inherit from your preferred runtime setting',
    icon: SparklesIcon,
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    description: "Anthropic's agentic coding CLI",
    icon: TerminalIcon,
  },
  {
    id: 'codex',
    label: 'Codex',
    description: "OpenAI's coding agent CLI",
    icon: BrainIcon,
  },
  {
    id: 'pi',
    label: 'pi',
    description: 'The pi coding-agent CLI',
    icon: SparklesIcon,
  },
  {
    id: 'mastra',
    label: 'Mastra',
    description: 'Mastra AI framework runtime',
    icon: ZapIcon,
  },
];

interface RuntimePickerProps {
  value: AgentRuntime;
  onChange: (runtime: AgentRuntime) => void;
}

export const RuntimePicker: FC<RuntimePickerProps> = ({ value, onChange }) => {
  return (
    <div className="grid gap-2">
      {RUNTIME_OPTIONS.map((option) => {
        const Icon = option.icon;
        const isSelected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            className={cn(
              'flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-all',
              isSelected
                ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/20'
                : 'border-border/60 bg-card/50 hover:border-border hover:bg-card/80',
            )}
          >
            <div
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                isSelected ? 'bg-primary/10 text-primary' : 'bg-muted/50 text-muted-foreground',
              )}
            >
              <Icon size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className={cn('text-sm font-medium', isSelected && 'text-primary')}>{option.label}</div>
              <div className="text-xs text-muted-foreground">{option.description}</div>
            </div>
            <div
              className={cn(
                'h-4 w-4 shrink-0 rounded-full border-2 transition-colors',
                isSelected ? 'border-primary bg-primary' : 'border-muted-foreground/30',
              )}
            >
              {isSelected && (
                <div className="flex h-full w-full items-center justify-center">
                  <div className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
                </div>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
};

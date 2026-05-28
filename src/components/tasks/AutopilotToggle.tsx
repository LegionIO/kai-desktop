/**
 * AutopilotToggle — compact switch + status text for the task queue toolbar.
 *
 * Shows a small switch (h-4 w-7), the label "Autopilot", and contextual
 * status: "Off" when disabled, "Watching…" when enabled with no current
 * assignments, or "N assigned" when tasks are running under autopilot.
 *
 * Hidden entirely when the orchestrator IPC surface isn't available so
 * older builds don't render a dead control.
 */

import { type FC } from 'react';
import { cn } from '@/lib/utils';
import { useOrchestrator } from '@/hooks/useOrchestrator';
import { Tooltip } from '@/components/ui/Tooltip';

interface AutopilotToggleProps {
  className?: string;
}

export const AutopilotToggle: FC<AutopilotToggleProps> = ({ className }) => {
  const { state, available, loading, toggle } = useOrchestrator();

  if (!available || loading) return null;

  const enabled = state.config.enabled;
  const runningCount = state.decisions.filter((d) => d.started && !d.error).length;

  const statusText = !enabled
    ? 'Off'
    : runningCount > 0
      ? `${runningCount} dispatched`
      : state.running
        ? 'Watching…'
        : 'Idle';

  const handleToggle = () => {
    void toggle(!enabled);
  };

  return (
    <Tooltip
      content={enabled ? 'Autopilot is watching the queue' : 'Enable autopilot to dispatch tasks automatically'}
      side="bottom"
    >
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={handleToggle}
        className={cn(
          'group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors',
          'hover:bg-muted/60',
          className,
        )}
      >
        {/* Switch */}
        <span
          className={cn(
            'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
            enabled
              ? 'bg-[var(--brand-accent)]'
              : 'bg-muted-foreground/30',
          )}
        >
          <span
            className={cn(
              'inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform',
              enabled ? 'translate-x-3.5' : 'translate-x-0.5',
            )}
          />
        </span>

        {/* Label */}
        <span className="text-xs font-medium text-foreground">Autopilot</span>

        {/* Status */}
        <span
          className={cn(
            'flex items-center gap-1 text-xs',
            enabled ? 'text-[var(--brand-accent)]' : 'text-muted-foreground/70',
          )}
        >
          {enabled && runningCount === 0 && (
            <span className="relative flex h-1.5 w-1.5 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--brand-accent)] opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--brand-accent)]" />
            </span>
          )}
          {statusText}
        </span>
      </button>
    </Tooltip>
  );
};

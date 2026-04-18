import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { CheckIcon, ChevronUpIcon, ClipboardListIcon, ShieldCheckIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { usePopoverAlign } from '@/hooks/usePopoverAlign';

export type ExecutionMode = 'auto' | 'plan-first' | 'confirm-writes';

const MODE_OPTIONS: Array<{ value: ExecutionMode; label: string; description: string }> = [
  { value: 'auto', label: 'Auto', description: 'Tools run immediately' },
  { value: 'plan-first', label: 'Plan First', description: 'AI plans before acting' },
  { value: 'confirm-writes', label: 'Confirm Writes', description: 'Approve each write' },
];

export const PlanModeButton: FC<{
  executionMode: ExecutionMode;
  onChangeExecutionMode: (value: ExecutionMode) => void;
}> = ({ executionMode, onChangeExecutionMode }) => {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setIsOpen(false);
    };
    window.addEventListener('pointerdown', handler);
    return () => window.removeEventListener('pointerdown', handler);
  }, [isOpen]);

  const togglePopover = useCallback(() => {
    setIsOpen((o) => !o);
  }, []);
  const popover = usePopoverAlign();

  const isActive = executionMode !== 'auto';
  const tooltipText = executionMode === 'plan-first'
    ? 'Plan mode active'
    : executionMode === 'confirm-writes'
      ? 'Confirmation mode active'
      : 'Execution mode';

  return (
    <div ref={rootRef} className="relative flex items-center">
      {/* Joined button group: chevron + plan toggle */}
      <div className={`flex items-center overflow-hidden rounded-lg border transition-colors ${
        isActive
          ? 'border-primary/50 bg-primary/10'
          : 'border-border/70 bg-card/70'
      }`}>
        {/* Left segment: chevron — opens settings popover */}
        <Tooltip content="Execution mode settings" side="top" sideOffset={8}>
          <button
            type="button"
            onClick={togglePopover}
            className={`flex h-10 w-10 shrink-0 items-center justify-center transition-colors ${
              isActive
                ? 'text-primary hover:bg-primary/15'
                : 'text-muted-foreground hover:bg-muted/50'
            }`}
          >
            <ChevronUpIcon className={`h-3.5 w-3.5 transition-transform ${isOpen ? '' : 'rotate-180'}`} />
          </button>
        </Tooltip>

        {/* Right segment: plan icon — toggles between auto and plan-first */}
        <Tooltip content={tooltipText} side="top" sideOffset={8}>
          <button
            type="button"
            onClick={() => onChangeExecutionMode(isActive ? 'auto' : 'plan-first')}
            className={`flex h-10 w-10 shrink-0 items-center justify-center transition-colors ${
              isActive
                ? 'text-primary hover:bg-primary/15'
                : 'text-muted-foreground hover:bg-muted/50'
            }`}
          >
            <ClipboardListIcon className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      {/* Settings popover */}
      {isOpen && (
        <div ref={popover.ref} style={popover.style} className="absolute bottom-full right-0 z-50 mb-2 w-[280px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_16px_40px_rgba(5,4,15,0.28)] backdrop-blur-xl">
          {/* Mode section */}
          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
            <ShieldCheckIcon className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Execution Mode</span>
          </div>

          <div className="space-y-0.5 px-1 pb-2">
            {MODE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChangeExecutionMode(option.value);
                  setIsOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs transition-colors ${
                  option.value === executionMode
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'hover:bg-muted/60 text-foreground'
                }`}
              >
                {option.value === executionMode && <CheckIcon className="h-3 w-3 shrink-0" />}
                <div className="flex-1 min-w-0 text-left">
                  <span className="block truncate">{option.label}</span>
                  <span className={`block text-[10px] ${
                    option.value === executionMode ? 'text-primary/70' : 'text-muted-foreground'
                  }`}>{option.description}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

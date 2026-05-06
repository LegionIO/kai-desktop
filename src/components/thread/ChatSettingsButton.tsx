import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { ChevronUpIcon, DumbbellIcon, MessageCircleIcon, ScrollTextIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { usePopoverAlign } from '@/hooks/usePopoverAlign';
import { useSplitButtonHover } from '@/hooks/useSplitButtonHover';
import type { ReasoningEffort } from './ReasoningEffortSelector';

const REASONING_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Max' },
];

export type ExecutionMode = 'auto' | 'plan-first';

const MODE_ICONS: Record<ExecutionMode, typeof MessageCircleIcon> = {
  'auto': MessageCircleIcon,
  'plan-first': ScrollTextIcon,
};

export const ChatSettingsButton: FC<{
  reasoningEffort: ReasoningEffort;
  onChangeReasoningEffort: (value: ReasoningEffort) => void;
  executionMode?: ExecutionMode;
  onChangeExecutionMode?: (value: ExecutionMode) => void;
}> = ({ reasoningEffort, onChangeReasoningEffort, executionMode, onChangeExecutionMode }) => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!settingsOpen) return;
    const handler = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    window.addEventListener('pointerdown', handler);
    return () => window.removeEventListener('pointerdown', handler);
  }, [settingsOpen]);

  const toggleSettings = useCallback(() => {
    setSettingsOpen((o) => !o);
  }, []);

  const settingsPopover = usePopoverAlign();
  const { expanded, containerProps } = useSplitButtonHover({ popoverOpen: settingsOpen });

  const hasExecutionMode = executionMode !== undefined && onChangeExecutionMode !== undefined;
  const isNonAutoMode = hasExecutionMode && executionMode !== 'auto';

  const handleMainClick = useCallback(() => {
    if (hasExecutionMode && onChangeExecutionMode && executionMode) {
      onChangeExecutionMode(executionMode === 'auto' ? 'plan-first' : 'auto');
    } else {
      toggleSettings();
    }
  }, [hasExecutionMode, onChangeExecutionMode, executionMode, toggleSettings]);

  const mainTooltip = !hasExecutionMode
    ? 'Chat settings'
    : executionMode === 'plan-first'
      ? 'Plan mode'
      : 'Ask mode';

  const ModeIcon = hasExecutionMode
    ? MODE_ICONS[executionMode ?? 'auto']
    : MessageCircleIcon;

  return (
    <div ref={rootRef} {...containerProps} className="relative flex items-center">
      {/* Joined button group: chevron + mode icon */}
      <div className={`flex items-center overflow-hidden rounded-lg border transition-colors ${
        isNonAutoMode
          ? 'border-primary/50 bg-primary/10'
          : 'border-border/50 bg-muted/40'
      }`}>
        {/* Left segment: chevron — opens settings popover */}
        <div className={`overflow-hidden transition-[max-width,opacity] duration-200 ease-out ${
          expanded ? 'max-w-[2.5rem] opacity-100' : 'max-w-0 opacity-0'
        }`}>
          <Tooltip content="Chat settings" side="top" sideOffset={8}>
            <button
              type="button"
              onClick={toggleSettings}
              className={`flex h-10 w-10 shrink-0 items-center justify-center transition-colors ${
                isNonAutoMode
                  ? 'text-primary hover:bg-primary/15'
                  : 'text-muted-foreground hover:bg-muted/50'
              }`}
            >
              <ChevronUpIcon className={`h-3.5 w-3.5 transition-transform ${settingsOpen ? '' : 'rotate-180'}`} />
            </button>
          </Tooltip>
        </div>

        {/* Right segment: mode icon — cycles execution mode or opens settings */}
        <Tooltip content={mainTooltip} side="top" sideOffset={8}>
          <button
            type="button"
            onClick={handleMainClick}
            className={`flex h-10 w-10 shrink-0 items-center justify-center transition-colors ${
              isNonAutoMode
                ? 'text-primary hover:bg-primary/15'
                : 'text-muted-foreground hover:bg-muted/50'
            }`}
          >
            <ModeIcon className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      {/* Settings popover (reasoning effort + plan mode) */}
      {settingsOpen && (
        <div ref={settingsPopover.ref} style={settingsPopover.style} className="absolute bottom-full right-0 z-50 mb-2 w-[280px] max-w-[calc(100vw-2rem)] max-h-[70vh] overflow-y-auto rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_16px_40px_rgba(5,4,15,0.28)] backdrop-blur-xl">
          {/* Effort track selector */}
          <div className="flex items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2">
              <DumbbellIcon className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Effort [{REASONING_OPTIONS.find((o) => o.value === reasoningEffort)?.label}]</span>
            </div>
            <div className="relative flex h-6 w-[92px] items-center rounded-full bg-muted-foreground/20">
              {/* Sliding thumb */}
              <span
                className="absolute h-4 w-4 rounded-full bg-foreground shadow-sm transition-[left] duration-200 ease-out pointer-events-none"
                style={{ left: `${4 + REASONING_OPTIONS.findIndex((o) => o.value === reasoningEffort) * ((92 - 4 * 2 - 16) / (REASONING_OPTIONS.length - 1))}px` }}
              />
              {/* Clickable dot positions */}
              {REASONING_OPTIONS.map((option, i) => {
                const isActive = option.value === reasoningEffort;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => onChangeReasoningEffort(option.value)}
                    className="absolute flex h-6 w-4 items-center justify-center"
                    style={{ left: `${4 + i * ((92 - 4 * 2 - 16) / (REASONING_OPTIONS.length - 1))}px` }}
                  >
                    <span className={`block h-1.5 w-1.5 rounded-full transition-opacity ${
                      isActive ? 'opacity-0' : 'bg-muted-foreground/50'
                    }`} />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Plan mode toggle */}
          {hasExecutionMode && (
            <>
              <div className="border-t border-border/50 mx-1.5 mt-0.5" />
              <div className="flex items-center justify-between px-3 py-2">
                <div className="flex items-center gap-2">
                  <ScrollTextIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Plan Mode</span>
                </div>
                <button
                  type="button"
                  onClick={() => onChangeExecutionMode!(executionMode === 'auto' ? 'plan-first' : 'auto')}
                  className={`relative inline-flex h-[22px] w-[40px] shrink-0 items-center rounded-full transition-colors ${
                    executionMode === 'plan-first' ? 'bg-primary' : 'bg-muted-foreground/30'
                  }`}
                >
                  <span className={`inline-block h-[16px] w-[16px] rounded-full bg-white shadow-sm transition-transform ${
                    executionMode === 'plan-first' ? 'translate-x-[21px]' : 'translate-x-[3px]'
                  }`} />
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

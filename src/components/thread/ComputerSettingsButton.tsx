import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { CheckIcon, ChevronUpIcon, MonitorIcon, ShieldCheckIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import type { ComputerUseTarget } from '../../../shared/computer-use';

type ApprovalMode = 'step' | 'goal' | 'autonomous';

const TARGET_OPTIONS: Array<{ value: ComputerUseTarget; label: string }> = [
  { value: 'isolated-browser', label: 'Browser' },
  { value: 'local-macos', label: 'Local Mac' },
];

const APPROVAL_OPTIONS: Array<{ value: ApprovalMode; label: string }> = [
  { value: 'step', label: 'Step' },
  { value: 'goal', label: 'Goal' },
  { value: 'autonomous', label: 'Auto' },
];

export const ComputerSettingsButton: FC<{
  target: ComputerUseTarget;
  onChangeTarget: (value: ComputerUseTarget) => void;
  approvalMode: ApprovalMode;
  onChangeApprovalMode: (value: ApprovalMode) => void;
}> = ({ target, onChangeTarget, approvalMode, onChangeApprovalMode }) => {
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

  const toggle = useCallback(() => setIsOpen((o) => !o), []);

  const currentTarget = TARGET_OPTIONS.find((o) => o.value === target) ?? TARGET_OPTIONS[1];
  const currentApproval = APPROVAL_OPTIONS.find((o) => o.value === approvalMode) ?? APPROVAL_OPTIONS[2];

  return (
    <div ref={rootRef} className="relative flex items-center">
      {/* Joined button group: chevron + monitor icon */}
      <div className="flex items-center overflow-hidden rounded-xl border border-border/70 bg-card/70 transition-colors">
        {/* Left segment: chevron — opens settings popover */}
        <Tooltip content="Session settings" side="top" sideOffset={8}>
          <button
            type="button"
            onClick={toggle}
            className="flex h-10 w-10 shrink-0 items-center justify-center transition-colors hover:bg-muted/50 text-muted-foreground"
          >
            <ChevronUpIcon className={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </button>
        </Tooltip>

        {/* Right segment: monitor icon */}
        <Tooltip
          content={
            <span className="flex items-center gap-1.5">
              {currentTarget.label}
              <span className="text-[10px] opacity-60">{currentApproval.label}</span>
            </span>
          }
          side="top"
          sideOffset={8}
        >
          <button
            type="button"
            onClick={toggle}
            className="flex h-10 w-10 shrink-0 items-center justify-center transition-colors hover:bg-muted/50 text-muted-foreground"
          >
            <MonitorIcon className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      {/* Settings popover */}
      {isOpen && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-[280px] rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_16px_40px_rgba(5,4,15,0.28)] backdrop-blur-xl">
          {/* Target section */}
          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
            <MonitorIcon className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Target</span>
          </div>

          <div className="space-y-0.5">
            {TARGET_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => onChangeTarget(option.value)}
                className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs transition-colors ${
                  option.value === target
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'hover:bg-muted/60 text-foreground'
                }`}
              >
                {option.value === target && <CheckIcon className="h-3 w-3 shrink-0" />}
                <span className="flex-1 min-w-0 truncate text-left">{option.label}</span>
              </button>
            ))}
          </div>

          {/* Approval mode section */}
          <div className="border-t border-border/50 mx-1.5 mt-1 pt-1">
            <div className="flex items-center gap-2 px-2 pt-1 pb-1.5">
              <ShieldCheckIcon className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Approval</span>
            </div>

            <div className="flex gap-1 px-2 pb-2">
              {APPROVAL_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onChangeApprovalMode(option.value)}
                  className={`flex-1 rounded-lg px-1.5 py-1.5 text-[11px] font-medium transition-colors ${
                    option.value === approvalMode
                      ? 'bg-primary/15 text-primary'
                      : 'hover:bg-muted/60 text-muted-foreground'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

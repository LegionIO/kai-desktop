import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { CheckIcon, ChevronUpIcon, FootprintsIcon, GlobeIcon, LaptopIcon, MonitorIcon, ShieldCheckIcon, TargetIcon, ZapIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { usePopoverAlign } from '@/hooks/usePopoverAlign';
import { useSplitButtonHover } from '@/hooks/useSplitButtonHover';
import type { ComputerUseTarget } from '../../../shared/computer-use';

type ApprovalMode = 'step' | 'goal' | 'autonomous';

const TARGET_OPTIONS: Array<{ value: ComputerUseTarget; label: string; description: string; icon: typeof GlobeIcon }> = [
  { value: 'isolated-browser', label: 'Browser', description: 'Sandboxed browser session', icon: GlobeIcon },
  { value: 'local-macos', label: 'Local Mac', description: 'Full desktop access', icon: LaptopIcon },
];

const APPROVAL_OPTIONS: Array<{ value: ApprovalMode; label: string; description: string; icon: typeof FootprintsIcon }> = [
  { value: 'step', label: 'Step', description: 'Approve every action', icon: FootprintsIcon },
  { value: 'goal', label: 'Goal', description: 'Approve each goal', icon: TargetIcon },
  { value: 'autonomous', label: 'Auto', description: 'No approval needed', icon: ZapIcon },
];

export const ComputerSettingsButton: FC<{
  target: ComputerUseTarget;
  onChangeTarget: (value: ComputerUseTarget) => void;
  approvalMode: ApprovalMode;
  onChangeApprovalMode: (value: ApprovalMode) => void;
  toggled: boolean;
  onToggle: () => void;
}> = ({ target, onChangeTarget, approvalMode, onChangeApprovalMode, toggled, onToggle }) => {
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
  const { expanded, containerProps } = useSplitButtonHover({ popoverOpen: isOpen });

  return (
    <div ref={rootRef} {...containerProps} className="relative flex items-center">
      {/* Joined button group: chevron + monitor toggle */}
      <div className={`flex items-center overflow-hidden rounded-lg border transition-colors ${
        toggled
          ? 'border-primary/50 bg-primary/10'
          : 'border-border/50 bg-muted/40'
      }`}>
        {/* Left segment: chevron — opens settings popover (only when toggled on) */}
        <div className={`overflow-hidden transition-[max-width,opacity] duration-200 ease-out ${
          expanded ? 'max-w-[2.5rem] opacity-100' : 'max-w-0 opacity-0'
        }`}>
          <Tooltip content="Autopilot settings" side="top" sideOffset={8}>
            <button
              type="button"
              onClick={togglePopover}
              className={`flex h-10 w-10 shrink-0 items-center justify-center transition-colors ${
                toggled
                  ? 'text-primary hover:bg-primary/15'
                  : 'text-muted-foreground hover:bg-muted/50'
              }`}
            >
              <ChevronUpIcon className={`h-3.5 w-3.5 transition-transform ${isOpen ? '' : 'rotate-180'}`} />
            </button>
          </Tooltip>
        </div>

        {/* Right segment: monitor icon — toggles computer use on/off */}
        <Tooltip content={toggled ? 'Disable autopilot' : 'Enable autopilot mode'} side="top" sideOffset={8}>
          <button
            type="button"
            onClick={onToggle}
            className={`flex h-10 w-10 shrink-0 items-center justify-center transition-colors ${
              toggled
                ? 'text-primary hover:bg-primary/15'
                : 'text-muted-foreground hover:bg-muted/50'
            }`}
          >
            <MonitorIcon className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      {/* Settings popover */}
      {isOpen && (
        <div ref={popover.ref} style={popover.style} className="absolute bottom-full right-0 z-50 mb-2 w-[280px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_16px_40px_rgba(5,4,15,0.28)] backdrop-blur-xl">
          {/* Target section */}
          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
            <MonitorIcon className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Target</span>
          </div>

          <div className="space-y-0.5">
            {TARGET_OPTIONS.map((option) => {
              const OptionIcon = option.icon;
              return (
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
                  <OptionIcon className="h-4 w-4 shrink-0" />
                  <div className="flex-1 min-w-0 text-left">
                    <span className="block truncate">{option.label}</span>
                    <span className={`block text-[10px] ${
                      option.value === target ? 'text-primary/70' : 'text-muted-foreground'
                    }`}>{option.description}</span>
                  </div>
                  {option.value === target && <CheckIcon className="h-3 w-3 shrink-0" />}
                </button>
              );
            })}
          </div>

          {/* Approval mode section */}
          <div className="border-t border-border/50 mx-1.5 mt-0.5" />
          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
            <ShieldCheckIcon className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Approval</span>
          </div>

          <div className="space-y-0.5 px-1 pb-2">
            {APPROVAL_OPTIONS.map((option) => {
              const OptionIcon = option.icon;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onChangeApprovalMode(option.value)}
                  className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs transition-colors ${
                    option.value === approvalMode
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'hover:bg-muted/60 text-foreground'
                  }`}
                >
                  <OptionIcon className="h-4 w-4 shrink-0" />
                  <div className="flex-1 min-w-0 text-left">
                    <span className="block truncate">{option.label}</span>
                    <span className={`block text-[10px] ${
                      option.value === approvalMode ? 'text-primary/70' : 'text-muted-foreground'
                    }`}>{option.description}</span>
                  </div>
                  {option.value === approvalMode && <CheckIcon className="h-3 w-3 shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

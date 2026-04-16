import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { BrainCircuitIcon, CheckIcon, ChevronUpIcon, CpuIcon, ShuffleIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { formatModelDisplayName } from '@/lib/model-display';
import { Tooltip } from '@/components/ui/Tooltip';
import type { ReasoningEffort } from './ReasoningEffortSelector';

type ModelInfo = {
  key: string;
  displayName: string;
  maxInputTokens?: number;
  computerUseSupport?: string;
};

type ModelCatalog = {
  models: ModelInfo[];
  defaultKey: string | null;
};

const REASONING_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
];

export const ModelSettingsButton: FC<{
  selectedModelKey: string | null;
  onSelectModel: (key: string) => void;
  reasoningEffort: ReasoningEffort;
  onChangeReasoningEffort: (value: ReasoningEffort) => void;
  fallbackEnabled: boolean;
  onToggleFallback: (value: boolean) => void;
}> = ({ selectedModelKey, onSelectModel, reasoningEffort, onChangeReasoningEffort, fallbackEnabled, onToggleFallback }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    app.modelCatalog()
      .then((data) => setCatalog(data as ModelCatalog))
      .catch(() => {});
  }, []);

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

  const models = catalog?.models ?? [];
  const currentKey = selectedModelKey ?? catalog?.defaultKey ?? models[0]?.key;
  const currentModel = models.find((m) => m.key === currentKey) ?? models[0];
  const currentLabel = formatModelDisplayName(currentModel?.displayName ?? 'Model');
  const currentReasoning = REASONING_OPTIONS.find((o) => o.value === reasoningEffort) ?? REASONING_OPTIONS[1];

  return (
    <div ref={rootRef} className="relative flex items-center">
      {/* Joined button group: chevron + model icon */}
      <div className="flex items-center overflow-hidden rounded-xl border border-border/70 bg-card/70 transition-colors">
        {/* Left segment: chevron — opens settings popover */}
        <Tooltip content="Model settings" side="top" sideOffset={8}>
          <button
            type="button"
            onClick={toggle}
            className="flex h-10 w-10 shrink-0 items-center justify-center transition-colors hover:bg-muted/50 text-muted-foreground"
          >
            <ChevronUpIcon className={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </button>
        </Tooltip>

        {/* Right segment: model icon */}
        <Tooltip
          content={
            <span className="flex items-center gap-1.5">
              {currentLabel}
              <span className="text-[10px] opacity-60">{currentReasoning.label}</span>
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
            <CpuIcon className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      {/* Settings popover */}
      {isOpen && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-[280px] rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_16px_40px_rgba(5,4,15,0.28)] backdrop-blur-xl">
          {/* Model section */}
          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
            <CpuIcon className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Model</span>
          </div>

          <div className="max-h-[240px] overflow-y-auto space-y-0.5">
            {models.map((model) => {
              const label = formatModelDisplayName(model.displayName);
              return (
                <button
                  key={model.key}
                  type="button"
                  onClick={() => onSelectModel(model.key)}
                  className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs transition-colors ${
                    model.key === currentKey
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'hover:bg-muted/60 text-foreground'
                  }`}
                >
                  {model.key === currentKey && <CheckIcon className="h-3 w-3 shrink-0" />}
                  <span className="flex-1 min-w-0 truncate text-left">{label}</span>
                  {model.maxInputTokens && (
                    <span className="text-[10px] opacity-50">
                      {Math.round(model.maxInputTokens / 1000)}k
                    </span>
                  )}
                  {model.computerUseSupport && model.computerUseSupport !== 'none' && (
                    <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">
                      CU
                    </span>
                  )}
                </button>
              );
            })}

            {models.length === 0 && (
              <div className="px-3 py-3 text-[10px] text-muted-foreground text-center">
                No models available
              </div>
            )}
          </div>

          {/* Reasoning section */}
          <div className="border-t border-border/50 mx-1.5 mt-1 pt-1">
            <div className="flex items-center gap-2 px-2 pt-1 pb-1.5">
              <BrainCircuitIcon className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Reasoning</span>
            </div>

            <div className="flex gap-1 px-2 pb-2">
              {REASONING_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onChangeReasoningEffort(option.value)}
                  className={`flex-1 rounded-lg px-1.5 py-1.5 text-[11px] font-medium transition-colors ${
                    option.value === reasoningEffort
                      ? 'bg-primary/15 text-primary'
                      : 'hover:bg-muted/60 text-muted-foreground'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {/* Auto-routing toggle */}
          <div className="flex items-center justify-between border-t border-border/50 mx-1.5 mt-0.5 px-2 py-2">
            <div className="flex items-center gap-2">
              <ShuffleIcon className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-foreground">Auto-routing</span>
            </div>
            <button
              type="button"
              onClick={() => onToggleFallback(!fallbackEnabled)}
              className={`relative inline-flex h-[22px] w-[40px] shrink-0 items-center rounded-full transition-colors ${
                fallbackEnabled ? 'bg-primary' : 'bg-muted-foreground/30'
              }`}
            >
              <span className={`inline-block h-[16px] w-[16px] rounded-full bg-white shadow-sm transition-transform ${
                fallbackEnabled ? 'translate-x-[21px]' : 'translate-x-[3px]'
              }`} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

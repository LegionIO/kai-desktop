import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { CheckIcon, ChevronUpIcon, CpuIcon, DumbbellIcon, PenLineIcon, ScrollTextIcon, ShuffleIcon, UserCircleIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { formatModelDisplayName } from '@/lib/model-display';
import { Tooltip } from '@/components/ui/Tooltip';
import { usePopoverAlign } from '@/hooks/usePopoverAlign';
import { useSplitButtonHover } from '@/hooks/useSplitButtonHover';
import type { ReasoningEffort } from './ReasoningEffortSelector';

type ModelInfo = {
  key: string;
  displayName: string;
  maxInputTokens?: number;
  computerUseSupport?: string;
  visionCapable?: boolean;
};

type ModelCatalog = {
  models: ModelInfo[];
  defaultKey: string | null;
};

type ProfileInfo = {
  key: string;
  name: string;
  primaryModelKey: string;
  fallbackModelKeys: string[];
};

type ProfileCatalog = {
  profiles: ProfileInfo[];
  defaultKey: string | null;
};

const REASONING_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Max' },
];

export type ExecutionMode = 'auto' | 'plan-first';

const MODE_ICONS: Record<ExecutionMode, typeof PenLineIcon> = {
  'auto': PenLineIcon,
  'plan-first': ScrollTextIcon,
};

export const ModelSettingsButton: FC<{
  selectedModelKey: string | null;
  onSelectModel: (key: string) => void;
  reasoningEffort: ReasoningEffort;
  onChangeReasoningEffort: (value: ReasoningEffort) => void;
  fallbackEnabled: boolean;
  onToggleFallback: (value: boolean) => void;
  selectedProfileKey?: string | null;
  onSelectProfile?: (key: string | null, primaryModelKey: string | null) => void;
  filter?: (model: ModelInfo) => boolean;
  fallbackToUnfilteredWhenEmpty?: boolean;
  executionMode?: ExecutionMode;
  onChangeExecutionMode?: (value: ExecutionMode) => void;
}> = ({ selectedModelKey, onSelectModel, reasoningEffort, onChangeReasoningEffort, fallbackEnabled, onToggleFallback, selectedProfileKey, onSelectProfile, filter, fallbackToUnfilteredWhenEmpty, executionMode, onChangeExecutionMode }) => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [profileCatalog, setProfileCatalog] = useState<ProfileCatalog | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    app.modelCatalog()
      .then((data) => setCatalog(data as ModelCatalog))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!onSelectProfile) return;
    app.profileCatalog()
      .then((data) => setProfileCatalog(data as ProfileCatalog))
      .catch(() => {});
  }, [onSelectProfile]);

  // Close on outside click
  useEffect(() => {
    if (!settingsOpen && !modelOpen) return;
    const handler = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setSettingsOpen(false);
        setModelOpen(false);
      }
    };
    window.addEventListener('pointerdown', handler);
    return () => window.removeEventListener('pointerdown', handler);
  }, [settingsOpen, modelOpen]);

  const toggleSettings = useCallback(() => {
    setSettingsOpen((o) => !o);
    setModelOpen(false);
  }, []);

  const toggleModel = useCallback(() => {
    setModelOpen((o) => !o);
    setSettingsOpen(false);
  }, []);

  const settingsPopover = usePopoverAlign();
  const modelPopover = usePopoverAlign();
  const { expanded, containerProps } = useSplitButtonHover({ popoverOpen: settingsOpen || modelOpen });

  let models = catalog?.models ?? [];
  if (filter) {
    const filtered = models.filter(filter);
    models = filtered.length > 0 || !fallbackToUnfilteredWhenEmpty ? filtered : models;
  }
  const profiles = profileCatalog?.profiles ?? [];
  const hasProfiles = onSelectProfile && profiles.length > 0;
  const currentProfileKey = selectedProfileKey ?? profileCatalog?.defaultKey;
  const effectiveProfileModelKey = currentProfileKey
    ? profiles.find((p) => p.key === currentProfileKey)?.primaryModelKey
    : undefined;

  const currentKey = selectedModelKey ?? effectiveProfileModelKey ?? catalog?.defaultKey ?? models[0]?.key;
  const currentModel = models.find((m) => m.key === currentKey) ?? models[0];
  const currentLabel = formatModelDisplayName(currentModel?.displayName ?? 'Model');

  const hasExecutionMode = executionMode !== undefined && onChangeExecutionMode !== undefined;
  const isNonAutoMode = hasExecutionMode && executionMode !== 'auto';

  const handleMainClick = useCallback(() => {
    if (hasExecutionMode && onChangeExecutionMode && executionMode) {
      onChangeExecutionMode(executionMode === 'auto' ? 'plan-first' : 'auto');
    } else {
      toggleModel();
    }
  }, [hasExecutionMode, onChangeExecutionMode, executionMode, toggleModel]);

  const mainTooltip = !hasExecutionMode
    ? currentLabel
    : executionMode === 'plan-first'
      ? 'Plan mode'
      : 'Edit mode';

  const ModeIcon = hasExecutionMode
    ? MODE_ICONS[executionMode ?? 'auto']
    : CpuIcon;

  return (
    <div ref={rootRef} {...containerProps} className="relative flex items-center">
      {/* Joined button group: chevron + model icon */}
      <div className={`flex items-center overflow-hidden rounded-lg border transition-colors ${
        isNonAutoMode
          ? 'border-primary/50 bg-primary/10'
          : 'border-border/50 bg-muted/40'
      }`}>
        {/* Left segment: chevron — opens settings popover */}
        <div className={`overflow-hidden transition-[max-width,opacity] duration-200 ease-out ${
          expanded ? 'max-w-[2.5rem] opacity-100' : 'max-w-0 opacity-0'
        }`}>
          <Tooltip content="Model settings" side="top" sideOffset={8}>
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

        {/* Right segment: mode icon — cycles execution mode or opens model picker */}
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

      {/* Settings popover (profiles + model + reasoning + execution mode + auto-routing) */}
      {settingsOpen && (
        <div ref={settingsPopover.ref} style={settingsPopover.style} className="absolute bottom-full right-0 z-50 mb-2 w-[280px] max-w-[calc(100vw-2rem)] max-h-[70vh] overflow-y-auto rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_16px_40px_rgba(5,4,15,0.28)] backdrop-blur-xl">
          {/* Profile section */}
          {hasProfiles && (
            <>
              <div className="flex items-center gap-2 px-3 pt-2 pb-1">
                <UserCircleIcon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Profile</span>
              </div>

              <div className="max-h-[160px] overflow-y-auto space-y-0.5">
                <button
                  type="button"
                  onClick={() => { onSelectProfile(null, null); }}
                  className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs transition-colors ${
                    !currentProfileKey
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'hover:bg-muted/60 text-foreground'
                  }`}
                >
                  {!currentProfileKey && <CheckIcon className="h-3 w-3 shrink-0" />}
                  <span className="flex-1 min-w-0 truncate text-left">Default</span>
                </button>
                {profiles.map((profile) => (
                  <button
                    key={profile.key}
                    type="button"
                    onClick={() => { onSelectProfile(profile.key, profile.primaryModelKey); }}
                    className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs transition-colors ${
                      profile.key === currentProfileKey
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'hover:bg-muted/60 text-foreground'
                    }`}
                  >
                    {profile.key === currentProfileKey && <CheckIcon className="h-3 w-3 shrink-0" />}
                    <span className="flex-1 min-w-0 truncate text-left">{profile.name}</span>
                    {profile.fallbackModelKeys.length > 0 && (
                      <span className="text-[10px] opacity-50">
                        {profile.fallbackModelKeys.length} fallback{profile.fallbackModelKeys.length > 1 ? 's' : ''}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              <div className="border-t border-border/50 mx-1.5 mt-1" />
            </>
          )}

          {/* Model section (inline when execution mode is available) */}
          {hasExecutionMode && (
            <>
              <div className="flex items-center gap-2 px-3 pt-2 pb-1">
                <CpuIcon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Model</span>
              </div>
              <div className="max-h-[200px] overflow-y-auto space-y-0.5">
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
            </>
          )}

          {/* Effort track selector */}
          <div className="border-t border-border/50 mx-1.5 mt-0.5" />
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

          {/* Auto-routing toggle */}
          <div className="border-t border-border/50 mx-1.5 mt-0.5" />
          <div className="flex items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2">
              <ShuffleIcon className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Auto-routing</span>
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

      {/* Model picker popover (standalone, only when execution mode is not available) */}
      {!hasExecutionMode && modelOpen && (
        <div ref={modelPopover.ref} style={modelPopover.style} className="absolute bottom-full right-0 z-50 mb-2 w-[280px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-[0_16px_40px_rgba(5,4,15,0.28)] backdrop-blur-xl">
          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
            <CpuIcon className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Model</span>
          </div>

          <div className="max-h-[300px] overflow-y-auto space-y-0.5">
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
        </div>
      )}
    </div>
  );
};

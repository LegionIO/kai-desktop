/**
 * DictationSettings — Settings panel for the "Dictation Anywhere" feature.
 *
 * Configures: enable/disable, hotkey binding, mode (toggle/hold),
 * input device, and language.
 */

import { useState, useEffect, useCallback, type FC, type ReactNode } from 'react';
import { AlertTriangleIcon, ExternalLinkIcon, InfoIcon, KeyboardIcon, MicIcon, SparklesIcon } from 'lucide-react';
import { SliderField, Toggle, settingsSelectClass, type SettingsProps } from './shared';
import { Tooltip } from '@/components/ui/Tooltip';
import { app } from '@/lib/ipc-client';

/** Pretty-print an Electron accelerator string for display (e.g. "Command+Shift+D" → "⌘⇧D") */
function prettifyHotkey(accelerator: string): string {
  const map: Record<string, string> = {
    CommandOrControl: '⌘',
    Command: '⌘',
    Control: '⌃',
    Shift: '⇧',
    Alt: '⌥',
  };
  return accelerator
    .split('+')
    .map((part) => map[part] ?? part.toUpperCase())
    .join('');
}

function acceleratorKeyFromEvent(e: KeyboardEvent): string | null {
  if (e.key === 'Dead' || e.key === 'Unidentified') return null;
  if (e.code.startsWith('Key')) return e.code.slice(3);
  if (e.code.startsWith('Digit')) return e.code.slice(5);

  switch (e.key) {
    case ' ':
      return 'Space';
    case 'ArrowLeft':
      return 'Left';
    case 'ArrowRight':
      return 'Right';
    case 'ArrowUp':
      return 'Up';
    case 'ArrowDown':
      return 'Down';
    case 'Escape':
      return 'Esc';
    case 'Backspace':
      return 'Backspace';
    case 'Delete':
      return 'Delete';
    case 'Enter':
      return 'Enter';
    case 'Tab':
      return 'Tab';
    default:
      return e.key.length === 1 ? e.key.toUpperCase() : e.key;
  }
}

type DictationConfig = {
  enabled?: boolean;
  provider?: 'azure' | 'openai';
  openai?: { baseUrl?: string; apiKey?: string; model?: string };
  hotkey?: string;
  mode?: 'toggle' | 'hold';
  inputDeviceId?: string | null;
  language?: string;
  vadSilenceDurationMs?: number;
  finalCleanupEnabled?: boolean;
  livePartials?: boolean;
  partialTyping?: PartialTypingConfig;
  debugLogging?: boolean;
};

type DictationRuntimeState = {
  state: string;
  elapsed: number;
  hotkeyRegistered?: boolean;
  hotkeyError?: string | null;
};

const DEFAULT_VAD_SILENCE_DURATION_MS = 850;
const MIN_VAD_SILENCE_DURATION_MS = 300;
const MAX_VAD_SILENCE_DURATION_MS = 5000;

const PARTIAL_STRATEGY_DETAILS = {
  disabled: {
    label: 'Disabled',
    summary:
      'Shows partial speech in the overlay only. The final transcript is typed once when the target still looks safe.',
    bestFor: 'Maximum safety in text fields that already contain important text.',
    tradeoff: 'No live text appears in the target app while you speak.',
  },
  'full-replacement': {
    label: 'Full replacement',
    summary: 'Replaces the whole dictated span through macOS Accessibility.',
    bestFor: 'Smooth live corrections when the app exposes a reliable AX text value.',
    tradeoff: 'Fails closed when AX becomes unreliable; not all apps allow AX value writes.',
  },
  'ax-verified': {
    label: 'AX-verified KB',
    summary: 'Sets the exact AX text selection, reads it back to verify, then types with keyboard events.',
    bestFor: 'Apps where AX can anchor the range but direct AX text replacement is flaky.',
    tradeoff: 'Needs AX range support. If the exact range cannot be verified, it refuses to type.',
  },
  'tail-only': {
    label: 'Tail only',
    summary:
      'Uses keyboard events for tail rewrites, but only after AX anchors the dictated span and verifies the result.',
    bestFor: 'Lower-risk keyboard live typing when the app exposes an AX text range but direct replacement is flaky.',
    tradeoff: 'Skips live typing when AX cannot verify the exact dictated text.',
  },
  'full-patch': {
    label: 'Full patch',
    summary:
      'Uses cursor movement, forward delete, backspace, and insertion, even when AX cannot verify the text field.',
    bestFor: 'Non-AX text fields and simple fields where cursor events are reliable.',
    tradeoff:
      'Highest corruption risk. In unreadable fields Kai cannot detect secure inputs or prove the cursor/text state.',
  },
} as const;

const PARTIAL_STRATEGY_OPTIONS = Object.entries(PARTIAL_STRATEGY_DETAILS).map(([value, detail]) => ({
  value,
  label: detail.label,
})) as Array<{ value: PartialTypingStrategy; label: string }>;

type PartialTypingStrategy = keyof typeof PARTIAL_STRATEGY_DETAILS;
type PartialTypingMode = 'ax' | 'kb';
type PartialTypingConfig = Partial<Record<PartialTypingMode, PartialTypingStrategy>>;

const PARTIAL_STRATEGY_OPTIONS_BY_MODE: Record<PartialTypingMode, PartialTypingStrategy[]> = {
  ax: ['disabled', 'full-replacement', 'ax-verified'],
  kb: ['disabled', 'ax-verified', 'tail-only', 'full-patch'],
};

const DEFAULT_PARTIAL_TYPING: Record<PartialTypingMode, PartialTypingStrategy> = {
  ax: 'disabled',
  kb: 'disabled',
};

function normalizePartialTypingStrategy(
  mode: PartialTypingMode,
  strategy: PartialTypingStrategy,
): PartialTypingStrategy {
  if (PARTIAL_STRATEGY_OPTIONS_BY_MODE[mode].includes(strategy)) return strategy;
  return mode === 'ax' ? 'full-replacement' : 'ax-verified';
}

function resolvePartialTyping(dictation: DictationConfig): Record<PartialTypingMode, PartialTypingStrategy> {
  const legacy = dictation.livePartials
    ? {
        ax: 'full-replacement' as const,
        kb: 'disabled' as const,
      }
    : DEFAULT_PARTIAL_TYPING;

  if (!dictation.partialTyping) {
    return legacy;
  }

  return {
    ax: normalizePartialTypingStrategy('ax', dictation.partialTyping.ax ?? legacy.ax),
    kb: normalizePartialTypingStrategy('kb', dictation.partialTyping.kb ?? legacy.kb),
  };
}

function hasEnabledPartialStrategy(partialTyping: Record<PartialTypingMode, PartialTypingStrategy>): boolean {
  return partialTyping.ax !== 'disabled' || partialTyping.kb !== 'disabled';
}

function getPartialTypingModeLabel(mode: PartialTypingMode): string {
  switch (mode) {
    case 'ax':
      return 'AX';
    case 'kb':
      return 'KB/KX';
  }
}

function getPartialTypingModeDescription(mode: PartialTypingMode): ReactNode {
  switch (mode) {
    case 'ax':
      return (
        <div className="space-y-1.5">
          <p className="font-medium">Accessibility mode</p>
          <p>AX means macOS Accessibility can see the focused text field and its cursor range.</p>
          <p>It is usually safer for live corrections because replacements can be anchored to a known text span.</p>
        </div>
      );
    case 'kb':
      return (
        <div className="space-y-1.5">
          <p className="font-medium">Keyboard fallback</p>
          <p>KB/KX means Kai types synthetic keyboard events into the focused app.</p>
          <p>
            It works in more places, but cursor position is harder to prove unless the selected strategy also verifies
            an AX range.
          </p>
        </div>
      );
  }
}

function getStrategyModeNote(mode: PartialTypingMode, strategy: PartialTypingStrategy): string | null {
  if (mode === 'ax' && strategy === 'full-replacement') {
    return 'This is the preferred AX path. It rewrites the dictated span using Accessibility instead of cursor movements.';
  }
  if (mode === 'kb' && strategy === 'ax-verified') {
    return 'Requires an AX range; otherwise it will skip live partial typing and wait for the final transcript.';
  }
  if (mode === 'kb' && strategy === 'full-patch') {
    return 'Uses cursor movement in the target field, can run without AX verification, and is limited to printable ASCII. This is the highest-risk keyboard fallback.';
  }
  if (mode === 'kb' && strategy === 'tail-only') {
    return 'Requires AX range verification before and after the keyboard rewrite.';
  }
  return null;
}

function PartialStrategyRow({
  mode,
  value,
  onChange,
}: {
  mode: PartialTypingMode;
  value: PartialTypingStrategy;
  onChange: (strategy: PartialTypingStrategy) => void;
}) {
  const modeNote = getStrategyModeNote(mode, value);
  const options = PARTIAL_STRATEGY_OPTIONS_BY_MODE[mode];
  return (
    <>
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
        {getPartialTypingModeLabel(mode)}
        <InfoTip content={getPartialTypingModeDescription(mode)} />
      </span>
      <div className="flex min-w-0 items-center gap-1.5">
        <select
          className={settingsSelectClass}
          value={value}
          onChange={(e) => onChange(e.target.value as PartialTypingStrategy)}
        >
          {options.map((strategy) => (
            <option key={strategy} value={strategy}>
              {PARTIAL_STRATEGY_DETAILS[strategy].label}
            </option>
          ))}
        </select>
        <InfoTip
          content={
            <div className="space-y-1.5">
              <StrategyTooltipContent strategy={value} />
              {modeNote && (
                <p>
                  <span className="font-medium">In {getPartialTypingModeLabel(mode)}:</span> {modeNote}
                </p>
              )}
            </div>
          }
        />
      </div>
    </>
  );
}

const tooltipClassName =
  'z-50 max-w-xs rounded-lg bg-popover px-3 py-2 text-[11px] leading-relaxed text-popover-foreground shadow-lg ring-1 ring-border/50 animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95';

function InfoTip({ content }: { content: ReactNode }) {
  return (
    <Tooltip content={content} side="right" contentClassName={tooltipClassName}>
      <button
        type="button"
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        aria-label="More information"
      >
        <InfoIcon className="h-3 w-3" />
      </button>
    </Tooltip>
  );
}

function StrategyTooltipContent({ strategy }: { strategy: PartialTypingStrategy }) {
  const detail = PARTIAL_STRATEGY_DETAILS[strategy];
  return (
    <div className="space-y-1.5">
      <p className="font-medium">{detail.label}</p>
      <p>{detail.summary}</p>
      <p>
        <span className="font-medium">Good for:</span> {detail.bestFor}
      </p>
      <p>
        <span className="font-medium">Tradeoff:</span> {detail.tradeoff}
      </p>
    </div>
  );
}

export const DictationSettings: FC<SettingsProps> = ({ config, updateConfig }) => {
  const dictation = (config.dictation ?? {}) as DictationConfig;
  const partialTyping = resolvePartialTyping(dictation);
  const [devices, setDevices] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [recordingHotkey, setRecordingHotkey] = useState(false);
  const [heldModifiers, setHeldModifiers] = useState<string[]>([]);
  const [hotkeyDisplay, setHotkeyDisplay] = useState(dictation.hotkey ?? 'CommandOrControl+Shift+D');
  const [runtimeState, setRuntimeState] = useState<DictationRuntimeState | null>(null);
  const [dictationAnywhereUnsupportedReason, setDictationAnywhereUnsupportedReason] = useState<string | null>(null);

  // "Dictation anywhere" (inserting into any app's native field via AX) is
  // macOS-only — there is no Windows/Linux insertion path yet, so the platform
  // seam reports it unsupported off macOS. Fetch it to show an honest
  // "coming soon" banner + disable the toggle rather than let a user enable a
  // feature that would silently no-op. (Local computer use IS experimental on
  // Win/Linux, but that's a separate capability handled in ComputerUseSettings.)
  useEffect(() => {
    let cancelled = false;
    void app.platform
      .getFeatureCapabilities()
      .then((caps) => {
        if (!cancelled && caps.dictationAnywhere.supported === false) {
          setDictationAnywhereUnsupportedReason(caps.dictationAnywhere.reason ?? 'Not available on this platform yet.');
        }
      })
      .catch(() => {
        /* advisory UI hint; ignore fetch failures */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load audio devices
  useEffect(() => {
    app.mic
      .listDevices()
      .then(setDevices)
      .catch(() => {});
  }, []);

  useEffect(() => {
    void app.dictation
      .getState()
      .then((next) => setRuntimeState(next as DictationRuntimeState))
      .catch(() => {});
    return app.dictation.onStateChange((next) => setRuntimeState(next as DictationRuntimeState));
  }, []);

  useEffect(() => {
    if (!recordingHotkey) {
      setHotkeyDisplay(dictation.hotkey ?? 'CommandOrControl+Shift+D');
    }
  }, [dictation.hotkey, recordingHotkey]);

  // Hotkey recording
  const startRecordingHotkey = useCallback(() => {
    setHeldModifiers([]);
    setRecordingHotkey(true);
    void app.dictation.suspendHotkey();
  }, []);

  useEffect(() => {
    if (!recordingHotkey) return;

    const suppress = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    const getModifiers = (e: KeyboardEvent): string[] => {
      const mods: string[] = [];
      if (e.metaKey) mods.push('Command');
      if (e.ctrlKey) mods.push('Control');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      return mods;
    };

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const parts = getModifiers(e);
      setHeldModifiers(parts);

      // Only accept if a non-modifier key is also pressed
      const key = e.key;
      if (!['Meta', 'Control', 'Alt', 'Shift'].includes(key) && parts.length > 0) {
        const keyName = acceleratorKeyFromEvent(e);
        if (!keyName) return;
        parts.push(keyName);
        const accelerator = parts.join('+');
        setHotkeyDisplay(accelerator);
        setHeldModifiers([]);
        void updateConfig('dictation.hotkey', accelerator);
        setRecordingHotkey(false);
      }
    };

    const cancel = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      // Update held modifiers on key release
      setHeldModifiers(getModifiers(e));

      if (e.key === 'Escape') {
        setHeldModifiers([]);
        setRecordingHotkey(false);
      }
    };

    // Suppress all key events during recording to prevent UI side-effects
    window.addEventListener('keydown', handler, true);
    window.addEventListener('keyup', cancel, true);
    window.addEventListener('keypress', suppress, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
      window.removeEventListener('keyup', cancel, true);
      window.removeEventListener('keypress', suppress, true);
      void app.dictation.resumeHotkey();
    };
  }, [recordingHotkey, updateConfig]);

  const updatePartialStrategy = useCallback(
    (mode: PartialTypingMode, strategy: PartialTypingStrategy) => {
      const next = { ...partialTyping, [mode]: normalizePartialTypingStrategy(mode, strategy) };
      void updateConfig('dictation', {
        enabled: dictation.enabled ?? false,
        hotkey: dictation.hotkey ?? 'CommandOrControl+Shift+D',
        mode: dictation.mode ?? 'toggle',
        ...dictation,
        partialTyping: next,
        livePartials: hasEnabledPartialStrategy(next),
      });
    },
    [dictation, partialTyping, updateConfig],
  );

  const updateVadSilenceDuration = useCallback(
    (value: number) => {
      const clamped = Math.max(MIN_VAD_SILENCE_DURATION_MS, Math.min(MAX_VAD_SILENCE_DURATION_MS, Math.round(value)));
      void updateConfig('dictation.vadSilenceDurationMs', clamped);
    },
    [updateConfig],
  );

  const showHotkeyWarning = Boolean(
    dictation.enabled && runtimeState && runtimeState.hotkeyRegistered === false && runtimeState.hotkeyError,
  );

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Dictation Anywhere</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          System-wide voice dictation. Press a global hotkey to start speaking; Kai types only when the focused macOS
          text cursor can be verified.
        </p>
      </div>

      {/* Enable toggle */}
      <fieldset className="rounded-lg border border-border/60 p-3 space-y-3">
        <legend className="px-1 text-[10px] font-medium text-muted-foreground">General</legend>

        {dictationAnywhereUnsupportedReason && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-600 dark:text-amber-400">
            <AlertTriangleIcon className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              {dictationAnywhereUnsupportedReason} Dictation Anywhere is coming to your platform in a future release.
            </span>
          </div>
        )}

        <Toggle
          id="dictation.enabled"
          label="Enable Dictation Anywhere"
          checked={(dictation.enabled ?? false) && !dictationAnywhereUnsupportedReason}
          onChange={(v) => void updateConfig('dictation.enabled', v)}
          disabled={!!dictationAnywhereUnsupportedReason}
        />

        {/* Speech Provider */}
        <div data-setting-id="dictation.provider">
          <label className="text-[10px] text-muted-foreground block mb-1">Speech Recognition Provider</label>
          <select
            className={settingsSelectClass}
            value={dictation.provider ?? 'azure'}
            onChange={(e) => void updateConfig('dictation.provider', e.target.value)}
          >
            <option value="azure">Azure Speech Services</option>
            <option value="openai">OpenAI Realtime</option>
          </select>
        </div>

        {/* OpenAI config fields (shown when openai selected) */}
        {(dictation.provider ?? 'azure') === 'openai' && (
          <div className="space-y-2 rounded-lg border border-border/40 bg-muted/20 p-2.5">
            <div>
              <label className="text-[10px] text-muted-foreground block mb-1">Base URL</label>
              <input
                type="text"
                className="w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs outline-none"
                placeholder="wss://api.openai.com"
                value={dictation.openai?.baseUrl ?? ''}
                onChange={(e) => void updateConfig('dictation.openai.baseUrl', e.target.value || undefined)}
              />
              <p className="mt-0.5 text-[9px] text-muted-foreground">
                WebSocket endpoint for the OpenAI Realtime API. Leave blank for official OpenAI.
              </p>
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-1">API Key</label>
              <input
                type="password"
                className="w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs outline-none"
                placeholder="sk-..."
                value={dictation.openai?.apiKey ?? ''}
                onChange={(e) => void updateConfig('dictation.openai.apiKey', e.target.value || undefined)}
              />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-1">Model</label>
              <input
                type="text"
                className="w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs outline-none"
                placeholder="gpt-realtime-whisper"
                value={dictation.openai?.model ?? ''}
                onChange={(e) => void updateConfig('dictation.openai.model', e.target.value || undefined)}
              />
            </div>
          </div>
        )}

        {/* Azure info note */}
        {(dictation.provider ?? 'azure') === 'azure' && (
          <p className="text-[9px] text-muted-foreground pl-1">Uses credentials from Audio &amp; Voice settings.</p>
        )}

        {/* Hotkey */}
        <div data-setting-id="dictation.hotkey">
          <label className="text-[10px] text-muted-foreground block mb-1">Global Hotkey</label>
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 rounded-xl border border-border/70 bg-card/80 px-3 py-2.5">
              <KeyboardIcon className="h-4 w-4 text-muted-foreground" />
              {recordingHotkey ? (
                <span className="text-sm text-primary" style={{ fontFamily: 'system-ui' }}>
                  {heldModifiers.length > 0 ? (
                    <>
                      {prettifyHotkey(heldModifiers.join('+'))}
                      <span className="ml-1 animate-pulse text-muted-foreground">+ …</span>
                    </>
                  ) : (
                    <span className="animate-pulse">Press key combo…</span>
                  )}
                </span>
              ) : (
                <kbd className="text-sm tracking-wide text-foreground" style={{ fontFamily: 'system-ui' }}>
                  {prettifyHotkey(hotkeyDisplay)}
                </kbd>
              )}
            </div>
            <button
              type="button"
              onClick={startRecordingHotkey}
              className="shrink-0 rounded-xl border border-border/70 bg-card/80 px-3 py-2.5 text-[11px] font-medium text-muted-foreground hover:bg-muted/60 transition-colors"
            >
              {recordingHotkey ? 'Recording…' : 'Change'}
            </button>
          </div>
          {showHotkeyWarning && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[10px] leading-relaxed text-amber-700 dark:text-amber-300">
              <AlertTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{runtimeState?.hotkeyError}</span>
            </div>
          )}
        </div>

        {/* Mode */}
        <div data-setting-id="dictation.mode">
          <label className="text-[10px] text-muted-foreground block mb-1">Activation Mode</label>
          <select
            className={settingsSelectClass}
            value={dictation.mode ?? 'toggle'}
            onChange={(e) => void updateConfig('dictation.mode', e.target.value)}
          >
            <option value="toggle">Toggle (press to start, press to stop)</option>
            <option value="hold">Hold (hold key to record, release to stop)</option>
          </select>
          {dictation.mode === 'hold' && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
              <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
              <div className="min-w-0 flex-1 text-[10px] leading-relaxed text-muted-foreground">
                Hold mode requires macOS Input Monitoring so Kai can detect key release outside the app.
              </div>
              <button
                type="button"
                onClick={() => {
                  void app.computerUse.openLocalMacosPrivacySettings('input-monitoring');
                }}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border/70 bg-card/80 px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <ExternalLinkIcon className="h-3 w-3" />
                Open
              </button>
            </div>
          )}
        </div>
      </fieldset>

      {/* Partials */}
      <fieldset className="rounded-lg border border-border/60 p-3 space-y-3">
        <legend className="px-1 text-[10px] font-medium text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            Partial Typing
            <InfoTip
              content={
                <div className="space-y-1.5">
                  <p className="font-medium">Partial typing</p>
                  <p>
                    Live text that appears before the final result. AX uses macOS Accessibility; KB/KX uses synthetic
                    keyboard events as a fallback.
                  </p>
                  <p>Final transcripts are typed once unless Kai cannot verify the target safely.</p>
                </div>
              }
            />
          </span>
        </legend>

        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <PartialStrategyRow
            mode="ax"
            value={partialTyping.ax}
            onChange={(strategy) => updatePartialStrategy('ax', strategy)}
          />
          <PartialStrategyRow
            mode="kb"
            value={partialTyping.kb}
            onChange={(strategy) => updatePartialStrategy('kb', strategy)}
          />
        </div>

        <details className="group">
          <summary className="cursor-pointer select-none text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground">
            Strategy reference
          </summary>
          <div className="mt-2 space-y-1.5">
            {PARTIAL_STRATEGY_OPTIONS.map((option) => {
              const detail = PARTIAL_STRATEGY_DETAILS[option.value];
              return (
                <div key={option.value} className="rounded-lg border border-border/40 bg-card/40 px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[11px] font-medium text-foreground/90">{detail.label}</span>
                  </div>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{detail.summary}</p>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[9px] text-muted-foreground/80">
                    <span>
                      <span className="font-medium text-muted-foreground">Best for:</span> {detail.bestFor}
                    </span>
                    <span>
                      <span className="font-medium text-muted-foreground">Tradeoff:</span> {detail.tradeoff}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      </fieldset>

      {/* Final transcript */}
      <fieldset className="rounded-lg border border-border/60 p-3 space-y-2">
        <legend className="px-1 text-[10px] font-medium text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <SparklesIcon className="h-3 w-3" />
            Final Transcript
          </span>
        </legend>

        <Toggle
          id="dictation.finalCleanupEnabled"
          label="Clean up final transcript"
          checked={dictation.finalCleanupEnabled ?? false}
          onChange={(v) => void updateConfig('dictation.finalCleanupEnabled', v)}
        />
        <p className="text-[10px] leading-relaxed text-muted-foreground pl-6">
          Runs an LLM pass on the final result to fix recognition mistakes, punctuation, capitalization, filler words,
          and self-corrections before typing.
        </p>
      </fieldset>

      {/* Audio */}
      <fieldset className="rounded-lg border border-border/60 p-3 space-y-3">
        <legend className="px-1 text-[10px] font-medium text-muted-foreground">Audio</legend>

        {/* Device */}
        <div>
          <label className="text-[10px] text-muted-foreground block mb-1">Input Device</label>
          <div className="flex items-center gap-2">
            <MicIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <select
              className={settingsSelectClass}
              value={dictation.inputDeviceId ?? ''}
              onChange={(e) => void updateConfig('dictation.inputDeviceId', e.target.value || null)}
            >
              <option value="">System Default</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Unknown device'}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Language */}
        <div>
          <label className="text-[10px] text-muted-foreground block mb-1">Language (BCP-47)</label>
          <input
            type="text"
            className="w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs outline-none"
            placeholder="en-US"
            value={dictation.language ?? ''}
            onChange={(e) => void updateConfig('dictation.language', e.target.value || undefined)}
          />
          <p className="mt-0.5 text-[9px] text-muted-foreground">
            Leave blank to use the language from Audio &amp; Voice settings.
          </p>
        </div>
      </fieldset>

      {/* Recognition tuning */}
      <fieldset className="rounded-lg border border-border/60 p-3 space-y-3">
        <legend className="px-1 text-[10px] font-medium text-muted-foreground">Recognition</legend>

        <SliderField
          id="dictation.vadSilenceDurationMs"
          label={`VAD silence threshold: ${dictation.vadSilenceDurationMs ?? DEFAULT_VAD_SILENCE_DURATION_MS}ms`}
          value={dictation.vadSilenceDurationMs ?? DEFAULT_VAD_SILENCE_DURATION_MS}
          min={MIN_VAD_SILENCE_DURATION_MS}
          max={MAX_VAD_SILENCE_DURATION_MS}
          step={50}
          onChange={updateVadSilenceDuration}
        />
        <div className="flex items-center justify-between text-[9px] text-muted-foreground">
          <span>Faster (300ms)</span>
          <span>Longer pauses (5000ms)</span>
        </div>
        <p className="text-[9px] text-muted-foreground/70">
          How long a silence must last before the speech service finalizes the current phrase. Takes effect on next
          dictation session.
        </p>
      </fieldset>

      {/* Troubleshooting */}
      <fieldset className="rounded-lg border border-border/60 p-3 space-y-2">
        <legend className="px-1 text-[10px] font-medium text-muted-foreground">Troubleshooting</legend>

        <Toggle
          label="Enable debug logging"
          checked={dictation.debugLogging ?? false}
          onChange={(v) => void updateConfig('dictation.debugLogging', v)}
        />
        <p className="text-[10px] leading-relaxed text-muted-foreground pl-6">
          Prints detailed dictation diagnostics to stdout (visible in the terminal when running Kai from the command
          line). Useful for reporting bugs.
        </p>
      </fieldset>

      {/* Info */}
      <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
        <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          {(dictation.provider ?? 'azure') === 'openai'
            ? 'Dictation uses OpenAI Realtime for low-latency streaming transcription. Requires Accessibility, Automation, and Microphone permissions.'
            : 'Dictation uses your configured Azure Speech provider from Audio & Voice settings. Requires Accessibility, Automation, and Microphone permissions. Autopilot covers Accessibility and Automation; Voice features cover Microphone.'}
        </p>
      </div>
    </div>
  );
};

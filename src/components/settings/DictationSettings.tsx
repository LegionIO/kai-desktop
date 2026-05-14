/**
 * DictationSettings — Settings panel for the "Dictation Anywhere" feature.
 *
 * Configures: enable/disable, hotkey binding, mode (toggle/hold),
 * input device, and language.
 */

import { useState, useEffect, useCallback, type FC, type ReactNode } from 'react';
import { InfoIcon, KeyboardIcon, MicIcon } from 'lucide-react';
import type { SettingsProps } from './shared';
import { Toggle, settingsSelectClass } from './shared';
import { Tooltip } from '@/components/ui/Tooltip';
import { app } from '@/lib/ipc-client';

type DictationConfig = {
  enabled?: boolean;
  hotkey?: string;
  mode?: 'toggle' | 'hold';
  inputDeviceId?: string | null;
  language?: string;
  livePartials?: boolean;
  partialTyping?: PartialTypingConfig;
};

const PARTIAL_STRATEGY_DETAILS = {
  disabled: {
    label: 'Disabled',
    summary: 'Shows partial speech in the overlay only. The final transcript is typed once.',
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
    summary: 'Only appends new partial text or backspaces the previously typed partial before retyping.',
    bestFor: 'Lower-risk keyboard live typing when the caret remains at the end of dictation.',
    tradeoff: 'Can still misplace text if the app moves the caret or the user clicks elsewhere.',
  },
  'full-patch': {
    label: 'Full patch',
    summary: 'Uses the legacy diff plan: left/right movement, forward delete, backspace, and insertion.',
    bestFor: 'Maximum live correction fidelity in simple fields where cursor events are reliable.',
    tradeoff: 'Highest corruption risk in arbitrary apps or fields with existing text.',
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

function normalizePartialTypingStrategy(mode: PartialTypingMode, strategy: PartialTypingStrategy): PartialTypingStrategy {
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
          <p>It works in more places, but cursor position is harder to prove unless the selected strategy also verifies an AX range.</p>
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
    return 'Uses cursor movement in the target field. This is the highest-risk keyboard fallback.';
  }
  if (mode === 'ax' && strategy === 'tail-only') {
    return 'Uses keyboard backspace/type even though AX was available.';
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
            <option key={strategy} value={strategy}>{PARTIAL_STRATEGY_DETAILS[strategy].label}</option>
          ))}
        </select>
        <InfoTip
          content={
            <div className="space-y-1.5">
              <StrategyTooltipContent strategy={value} />
              {modeNote && <p><span className="font-medium">In {getPartialTypingModeLabel(mode)}:</span> {modeNote}</p>}
            </div>
          }
        />
      </div>
    </>
  );
}

const tooltipClassName = 'z-50 max-w-xs rounded-lg bg-popover px-3 py-2 text-[11px] leading-relaxed text-popover-foreground shadow-lg ring-1 ring-border/50 animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95';

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
      <p><span className="font-medium">Good for:</span> {detail.bestFor}</p>
      <p><span className="font-medium">Tradeoff:</span> {detail.tradeoff}</p>
    </div>
  );
}

export const DictationSettings: FC<SettingsProps> = ({ config, updateConfig }) => {
  const dictation = (config.dictation ?? {}) as DictationConfig;
  const partialTyping = resolvePartialTyping(dictation);
  const [devices, setDevices] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [recordingHotkey, setRecordingHotkey] = useState(false);
  const [hotkeyDisplay, setHotkeyDisplay] = useState(dictation.hotkey ?? 'CommandOrControl+Shift+D');

  // Load audio devices
  useEffect(() => {
    app.mic.listDevices().then(setDevices).catch(() => {});
  }, []);

  // Hotkey recording
  const startRecordingHotkey = useCallback(() => {
    setRecordingHotkey(true);
  }, []);

  useEffect(() => {
    if (!recordingHotkey) return;

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Build accelerator string
      const parts: string[] = [];
      if (e.metaKey) parts.push('Command');
      if (e.ctrlKey) parts.push('Control');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');

      // Only accept if a non-modifier key is also pressed
      const key = e.key;
      if (!['Meta', 'Control', 'Alt', 'Shift'].includes(key) && parts.length > 0) {
        const keyName = key.length === 1 ? key.toUpperCase() : key;
        parts.push(keyName);
        const accelerator = parts.join('+');
        setHotkeyDisplay(accelerator);
        void updateConfig('dictation.hotkey', accelerator);
        setRecordingHotkey(false);
      }
    };

    const cancel = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setRecordingHotkey(false);
      }
    };

    window.addEventListener('keydown', handler, true);
    window.addEventListener('keyup', cancel, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
      window.removeEventListener('keyup', cancel, true);
    };
  }, [recordingHotkey, updateConfig]);

  const updatePartialStrategy = useCallback((mode: PartialTypingMode, strategy: PartialTypingStrategy) => {
    const next = { ...partialTyping, [mode]: normalizePartialTypingStrategy(mode, strategy) };
    void updateConfig('dictation.partialTyping', next);
    void updateConfig('dictation.livePartials', hasEnabledPartialStrategy(next));
  }, [partialTyping, updateConfig]);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Dictation Anywhere</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          System-wide voice dictation. Press a global hotkey to start speaking — text is typed into whatever input is focused across macOS.
        </p>
      </div>

      {/* Enable toggle */}
      <fieldset className="rounded-lg border border-border/60 p-3 space-y-3">
        <legend className="px-1 text-[10px] font-medium text-muted-foreground">General</legend>

        <Toggle
          label="Enable Dictation Anywhere"
          checked={dictation.enabled ?? false}
          onChange={(v) => void updateConfig('dictation.enabled', v)}
        />

        {/* Hotkey */}
        <div>
          <label className="text-[10px] text-muted-foreground block mb-1">Global Hotkey</label>
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 rounded-xl border border-border/70 bg-card/80 px-3 py-2">
              <KeyboardIcon className="h-3.5 w-3.5 text-muted-foreground" />
              <span className={`text-xs ${recordingHotkey ? 'text-primary animate-pulse' : ''}`}>
                {recordingHotkey ? 'Press key combo...' : hotkeyDisplay}
              </span>
            </div>
            <button
              type="button"
              onClick={startRecordingHotkey}
              className="shrink-0 rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-[10px] font-medium text-muted-foreground hover:bg-muted/60 transition-colors"
            >
              {recordingHotkey ? 'Recording...' : 'Change'}
            </button>
          </div>
        </div>

        {/* Mode */}
        <div>
          <label className="text-[10px] text-muted-foreground block mb-1">Activation Mode</label>
          <select
            className={settingsSelectClass}
            value={dictation.mode ?? 'toggle'}
            onChange={(e) => void updateConfig('dictation.mode', e.target.value)}
          >
            <option value="toggle">Toggle (press to start, press to stop)</option>
            <option value="hold">Hold (hold key to record, release to stop)</option>
          </select>
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
	                  <p>Partial text is the live transcript that appears before the speech service sends the final result.</p>
	                  <p>AX has a preferred path: full Accessibility replacement. KB/KX contains keyboard fallback strategies for apps where AX is unavailable or unreliable.</p>
	                  <p>Final transcripts are still typed even when both partial strategies are disabled.</p>
                </div>
              }
            />
          </span>
        </legend>

        <div className="grid grid-cols-[80px_minmax(0,1fr)] items-center gap-2">
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

        <div className="grid gap-1.5 sm:grid-cols-2">
          {PARTIAL_STRATEGY_OPTIONS.map((option) => (
            <div key={option.value} className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-card/50 px-2 py-1.5">
              <span className="truncate text-[10px] text-muted-foreground">{option.label}</span>
              <InfoTip content={<StrategyTooltipContent strategy={option.value} />} />
            </div>
          ))}
        </div>
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

      {/* Info */}
      <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Dictation uses your configured Azure Speech provider from Audio &amp; Voice settings.
          Requires Accessibility and Microphone permissions (already granted if you use Autopilot or Voice features).
        </p>
      </div>
    </div>
  );
};

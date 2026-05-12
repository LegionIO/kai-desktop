/**
 * DictationSettings — Settings panel for the "Dictation Anywhere" feature.
 *
 * Configures: enable/disable, hotkey binding, mode (toggle/hold),
 * input device, and language.
 */

import { useState, useEffect, useCallback, type FC } from 'react';
import { MicIcon, KeyboardIcon } from 'lucide-react';
import type { SettingsProps } from './shared';
import { Toggle, settingsSelectClass } from './shared';
import { app } from '@/lib/ipc-client';

type DictationConfig = {
  enabled?: boolean;
  hotkey?: string;
  mode?: 'toggle' | 'hold';
  inputDeviceId?: string | null;
  language?: string;
  livePartials?: boolean;
};

export const DictationSettings: FC<SettingsProps> = ({ config, updateConfig }) => {
  const dictation = (config.dictation ?? {}) as DictationConfig;
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

        <div>
          <Toggle
            label="Type partial results live"
            checked={dictation.livePartials ?? false}
            onChange={(v) => void updateConfig('dictation.livePartials', v)}
          />
          <p className="mt-0.5 ml-7 text-[9px] text-muted-foreground">
            When enabled, partial transcriptions are typed in real-time and corrected when the final result arrives. May cause visual flickering in some apps.
          </p>
        </div>

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

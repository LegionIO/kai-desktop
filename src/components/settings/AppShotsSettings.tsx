import { useEffect, useState, type FC } from 'react';
import type { AdapterCapabilities } from '../../../electron/platform/types.js';
import { app } from '@/lib/ipc-client';
import { settingsSelectClass, SliderField, Toggle, type SettingsProps } from './shared';
import { HotkeyRecorder } from './shared/HotkeyRecorder';

type AppShotsConfig = {
  enabled?: boolean;
  hotkey?: string;
  captureMode?: 'window' | 'display';
  includeUiTree?: boolean;
  includeSelectedText?: boolean;
  uiTreeDepth?: number;
  autoAttach?: boolean;
};

export const AppShotsSettings: FC<SettingsProps & { hideTitle?: boolean }> = ({ config, updateConfig, hideTitle }) => {
  const cfg = (config.appShots ?? {}) as AppShotsConfig;
  const [caps, setCaps] = useState<{ kind: string; capabilities: AdapterCapabilities } | null>(null);

  useEffect(() => {
    app.platform
      .getCapabilities()
      .then(setCaps)
      .catch(() => {});
  }, []);

  const set = <K extends keyof AppShotsConfig>(key: K, value: AppShotsConfig[K]) => {
    void updateConfig('appShots', {
      enabled: cfg.enabled ?? false,
      hotkey: cfg.hotkey ?? 'CommandOrControl+Shift+1',
      captureMode: cfg.captureMode ?? 'window',
      includeUiTree: cfg.includeUiTree ?? true,
      includeSelectedText: cfg.includeSelectedText ?? true,
      uiTreeDepth: cfg.uiTreeDepth ?? 4,
      autoAttach: cfg.autoAttach ?? false,
      [key]: value,
    });
  };

  return (
    <div className="space-y-6">
      <div>
        {!hideTitle && <h3 className="text-sm font-semibold">App Shots</h3>}
        <p className="mt-1 text-xs text-muted-foreground">
          Press a global shortcut to capture the focused window plus its title, process, selected text and accessibility
          tree, and drop everything into the composer as an attachment.
        </p>
        {caps && (
          <p className="mt-1 text-[10px] text-muted-foreground/70">
            Adapter: <span className="font-mono">{caps.kind}</span>
            {caps.capabilities.uiTree ? '' : ' · UI-tree capture unavailable on this platform'}
            {caps.capabilities.screenshotWindow ? '' : ' · window-scoped capture falls back to full display'}
          </p>
        )}
      </div>

      <Toggle label="Enable App Shots" checked={cfg.enabled ?? false} onChange={(v) => set('enabled', v)} />

      <Toggle
        label="Auto-attach to active chat (otherwise paste from clipboard)"
        checked={cfg.autoAttach ?? false}
        onChange={(v) => set('autoAttach', v)}
      />

      <HotkeyRecorder
        label="Global shortcut"
        value={cfg.hotkey ?? 'CommandOrControl+Shift+1'}
        onChange={(accelerator) => set('hotkey', accelerator)}
        onRecordingStart={() => {
          void app.appShots.suspendHotkey();
        }}
        onRecordingEnd={() => {
          void app.appShots.resumeHotkey();
        }}
      />

      <div>
        <label className="text-[10px] text-muted-foreground block mb-0.5">Capture mode</label>
        <select
          className={settingsSelectClass}
          value={cfg.captureMode ?? 'window'}
          onChange={(e) => set('captureMode', e.target.value as 'window' | 'display')}
        >
          <option value="window">Focused window</option>
          <option value="display">Entire display</option>
        </select>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Toggle
          label="Include selected text"
          checked={cfg.includeSelectedText ?? true}
          onChange={(v) => set('includeSelectedText', v)}
        />
        <Toggle
          label="Include UI element tree"
          checked={cfg.includeUiTree ?? true}
          onChange={(v) => set('includeUiTree', v)}
        />
      </div>

      {(cfg.includeUiTree ?? true) && (
        <SliderField
          label={`UI tree depth: ${cfg.uiTreeDepth ?? 4}`}
          value={cfg.uiTreeDepth ?? 4}
          min={1}
          max={10}
          step={1}
          onChange={(v) => set('uiTreeDepth', v)}
        />
      )}

      <button
        type="button"
        disabled={!(cfg.enabled ?? false)}
        onClick={() => {
          void app.appShots.capture().catch((error: unknown) => {
            console.warn('[app-shots] test capture failed:', error instanceof Error ? error.message : String(error));
          });
        }}
        className="w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs font-medium hover:border-primary/60 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {cfg.enabled ? 'Capture now (test)' : 'Enable App Shots to test capture'}
      </button>
    </div>
  );
};

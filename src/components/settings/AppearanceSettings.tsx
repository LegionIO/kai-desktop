import type { FC } from 'react';
import { Toggle, settingsSelectClass, type SettingsProps } from './shared';

export const AppearanceSettings: FC<SettingsProps> = ({ config, updateConfig }) => {
  const ui = config.ui as { theme: string; sidebarWidth: number; fullWidthContent?: boolean };

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold">Appearance</h3>

      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Theme</legend>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Color scheme</label>
          <select className={settingsSelectClass} value={ui.theme} onChange={(e) => updateConfig('ui.theme', e.target.value)}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </fieldset>

      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Layout</legend>
        <Toggle
          label="Full width content"
          checked={!!ui.fullWidthContent}
          onChange={(v) => updateConfig('ui.fullWidthContent', v)}
        />
      </fieldset>
    </div>
  );
};

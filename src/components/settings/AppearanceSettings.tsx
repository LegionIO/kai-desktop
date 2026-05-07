import type { FC } from 'react';
import { settingsSelectClass, type SettingsProps } from './shared';

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
        <div className="flex items-start justify-between gap-3 rounded-md border p-3">
          <div>
            <span className="text-xs font-medium">Full width content</span>
            <p className="mt-0.5 text-[10px] text-muted-foreground">Remove max-width constraints so content uses the full panel width.</p>
          </div>
          <input type="checkbox" checked={!!ui.fullWidthContent} onChange={(e) => updateConfig('ui.fullWidthContent', e.target.checked)} className="mt-0.5 h-4 w-4 rounded" />
        </div>
      </fieldset>
    </div>
  );
};

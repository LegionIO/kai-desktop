import type { FC } from 'react';
import type { SettingsProps } from './shared';

export const GeneralSettings: FC<SettingsProps> = ({ config, updateConfig }) => {
  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold">General</h3>

      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Startup</legend>
        <div className="flex items-start justify-between gap-3 rounded-md border p-3">
          <div>
            <span className="text-xs font-medium">Launch at login</span>
            <p className="mt-0.5 text-[10px] text-muted-foreground">Automatically open Kai when you log in to your Mac.</p>
          </div>
          <input type="checkbox" checked={!!config.launchAtLogin} onChange={(e) => updateConfig('launchAtLogin', e.target.checked)} className="mt-0.5 h-4 w-4 rounded" />
        </div>
      </fieldset>
    </div>
  );
};

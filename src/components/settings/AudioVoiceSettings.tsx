import type { FC } from 'react';
import type { SettingsProps } from './shared';
import { AudioSettings } from './AudioSettings';
import { RealtimeSettings } from './RealtimeSettings';

export const AudioVoiceSettings: FC<SettingsProps> = ({ config, updateConfig }) => {
  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-sm font-semibold mb-1">Audio & Voice</h3>
        <p className="text-xs text-muted-foreground">
          Configure text-to-speech, voice recording, and live voice chat.
        </p>
      </div>

      <div className="space-y-6">
        <h4 className="text-sm font-medium border-b pb-2">Text-to-Speech & Recording</h4>
        <AudioSettings config={config} updateConfig={updateConfig} hideTitle />
      </div>

      <div className="space-y-6">
        <h4 className="text-sm font-medium border-b pb-2">Live Voice Chat</h4>
        <RealtimeSettings config={config} updateConfig={updateConfig} hideTitle />
      </div>
    </div>
  );
};

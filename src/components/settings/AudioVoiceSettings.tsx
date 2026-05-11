import { useState, type FC } from 'react';
import type { SettingsProps } from './shared';
import { AudioSettings } from './AudioSettings';
import { RealtimeSettings } from './RealtimeSettings';

type AudioTab = 'tts' | 'realtime';

export const AudioVoiceSettings: FC<SettingsProps> = ({ config, updateConfig }) => {
  const [activeTab, setActiveTab] = useState<AudioTab>('tts');

  const tabs: Array<{ key: AudioTab; label: string }> = [
    { key: 'tts', label: 'TTS & Recording' },
    { key: 'realtime', label: 'Voice Chat' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Audio & Voice</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Configure text-to-speech, voice recording, and live voice chat.
        </p>
      </div>

      {/* Tab Bar */}
      <div className="flex gap-1 border-b border-border/60">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-t-lg transition-colors ${
              activeTab === tab.key
                ? 'bg-card border border-b-0 border-border/60 text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === 'tts' && <AudioSettings config={config} updateConfig={updateConfig} hideTitle />}
      {activeTab === 'realtime' && <RealtimeSettings config={config} updateConfig={updateConfig} hideTitle />}
    </div>
  );
};

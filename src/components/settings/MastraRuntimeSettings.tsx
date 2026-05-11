import { useState, type FC } from 'react';
import { CollapsibleSection, type SettingsProps } from './shared';
import { MemorySettings } from './MemorySettings';
import { CompactionSettings } from './CompactionSettings';

type RuntimeTab = 'memory' | 'compaction';

export const MastraRuntimeSettings: FC<SettingsProps> = ({ config, updateConfig }) => {
  const [activeTab, setActiveTab] = useState<RuntimeTab>('memory');

  const tabs: Array<{ key: RuntimeTab; label: string }> = [
    { key: 'memory', label: 'Memory' },
    { key: 'compaction', label: 'Compaction' },
  ];

  return (
    <CollapsibleSection title="Advanced Runtime Config" defaultOpen={false}>
      <p className="text-[10px] text-muted-foreground">
        Memory and compaction apply to the Mastra runtime only. Claude and Codex manage context internally.
      </p>

      {/* Tabs */}
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
      {activeTab === 'memory' && <MemorySettings config={config} updateConfig={updateConfig} hideTitle />}
      {activeTab === 'compaction' && <CompactionSettings config={config} updateConfig={updateConfig} hideTitle />}
    </CollapsibleSection>
  );
};

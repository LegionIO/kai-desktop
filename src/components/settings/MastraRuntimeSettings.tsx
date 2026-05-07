import { useState, type FC } from 'react';
import { ChevronRightIcon } from 'lucide-react';
import type { SettingsProps } from './shared';
import { MemorySettings } from './MemorySettings';
import { CompactionSettings } from './CompactionSettings';

type RuntimeTab = 'memory' | 'compaction';

export const MastraRuntimeSettings: FC<SettingsProps> = ({ config, updateConfig }) => {
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<RuntimeTab>('memory');

  const tabs: Array<{ key: RuntimeTab; label: string }> = [
    { key: 'memory', label: 'Memory' },
    { key: 'compaction', label: 'Compaction' },
  ];

  return (
    <div className="rounded-lg border border-border/60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors rounded-lg"
      >
        <ChevronRightIcon className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <span className="text-xs font-semibold">Advanced Runtime Config</span>
        <span className="ml-auto text-[10px] text-muted-foreground">Mastra only</span>
      </button>

      {expanded && (
        <div className="space-y-4 px-3 pb-3">
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
        </div>
      )}
    </div>
  );
};

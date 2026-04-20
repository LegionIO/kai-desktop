import { useState, type FC } from 'react';
import { cn } from '@/lib/utils';
import { InsightsView } from './InsightsView';
import { RoadmapView } from './RoadmapView';
import { IdeationView } from './IdeationView';

/* ── Tab definitions ──────────────────────────────────────────── */

type AnalysisTab = 'insights' | 'roadmap' | 'ideation';

const TABS: { value: AnalysisTab; label: string }[] = [
  { value: 'insights', label: 'Insights' },
  { value: 'roadmap', label: 'Roadmap' },
  { value: 'ideation', label: 'Ideation' },
];

/* ── Component ────────────────────────────────────────────────── */

export const AnalysisView: FC = () => {
  const [activeTab, setActiveTab] = useState<AnalysisTab>('insights');

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border/70 px-5">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setActiveTab(tab.value)}
            className={cn(
              'relative px-3 py-2.5 text-xs font-medium transition-colors',
              activeTab === tab.value
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground/80',
            )}
          >
            {tab.label}
            {activeTab === tab.value && (
              <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-primary" />
            )}
          </button>
        ))}
      </div>

      {/* Active view */}
      <div className="min-h-0 flex-1">
        {activeTab === 'insights' && <InsightsView />}
        {activeTab === 'roadmap' && <RoadmapView />}
        {activeTab === 'ideation' && <IdeationView />}
      </div>
    </div>
  );
};

import { useState, useCallback, type FC } from 'react';
import { MapIcon, WandSparklesIcon } from 'lucide-react';
import { generateId } from '@/lib/utils';
import type { RoadmapPhase } from '../../../shared/workspace-types';
import { RoadmapPhaseCard } from './RoadmapPhaseCard';

/* ── Sample data generator ──────────────────────────────────── */

function generateSamplePhases(): RoadmapPhase[] {
  return [
    {
      id: generateId(),
      name: 'Phase 1 — Foundation',
      description: 'Core infrastructure and project scaffolding',
      features: [
        {
          id: generateId(),
          title: 'Project initialization',
          description: 'Set up build tooling, linting, CI pipeline, and base configuration',
          priority: 'high',
          effort: 'medium',
          status: 'completed',
        },
        {
          id: generateId(),
          title: 'Authentication system',
          description: 'OAuth2 integration with SSO provider and session management',
          priority: 'critical',
          effort: 'large',
          status: 'in_progress',
        },
        {
          id: generateId(),
          title: 'Database schema design',
          description: 'Define core entities, relationships, and migration strategy',
          priority: 'high',
          effort: 'medium',
          status: 'planned',
        },
      ],
    },
    {
      id: generateId(),
      name: 'Phase 2 — Core Features',
      description: 'Primary user-facing functionality',
      features: [
        {
          id: generateId(),
          title: 'Dashboard views',
          description: 'Real-time metrics, charts, and status panels',
          priority: 'high',
          effort: 'large',
          status: 'planned',
        },
        {
          id: generateId(),
          title: 'API endpoints',
          description: 'RESTful API with validation, pagination, and error handling',
          priority: 'high',
          effort: 'xlarge',
          status: 'planned',
        },
        {
          id: generateId(),
          title: 'Notification system',
          description: 'In-app and email notifications with preference controls',
          priority: 'medium',
          effort: 'medium',
          status: 'planned',
        },
      ],
    },
    {
      id: generateId(),
      name: 'Phase 3 — Polish & Launch',
      description: 'Quality assurance, performance tuning, and release prep',
      features: [
        {
          id: generateId(),
          title: 'Performance optimization',
          description: 'Bundle splitting, caching, lazy loading, and query optimization',
          priority: 'medium',
          effort: 'large',
          status: 'planned',
        },
        {
          id: generateId(),
          title: 'Accessibility audit',
          description: 'WCAG 2.1 AA compliance review and remediation',
          priority: 'medium',
          effort: 'small',
          status: 'planned',
        },
        {
          id: generateId(),
          title: 'Documentation',
          description: 'API docs, onboarding guide, and architecture decision records',
          priority: 'low',
          effort: 'medium',
          status: 'planned',
        },
      ],
    },
  ];
}

/* ── Component ──────────────────────────────────────────────── */

export const RoadmapView: FC = () => {
  const [phases, setPhases] = useState<RoadmapPhase[]>([]);

  const generateRoadmap = useCallback(() => {
    setPhases(generateSamplePhases());
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">Roadmap</h2>
        <button
          type="button"
          onClick={generateRoadmap}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <WandSparklesIcon className="h-3.5 w-3.5" />
          Generate Roadmap
        </button>
      </div>

      {/* Content */}
      {phases.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <MapIcon className="h-10 w-10 text-muted-foreground/40" />
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Generate a roadmap for your project
            </p>
            <p className="mt-1 text-xs text-muted-foreground/60">
              AI will analyze your codebase and create a phased plan
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
          {phases.map((phase) => (
            <RoadmapPhaseCard key={phase.id} phase={phase} />
          ))}
        </div>
      )}
    </div>
  );
};

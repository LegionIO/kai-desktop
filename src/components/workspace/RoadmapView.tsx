import { useState, useCallback, useMemo, type FC } from 'react';
import { MapIcon, WandSparklesIcon, InfoIcon } from 'lucide-react';
import { generateId } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import type { RoadmapPhase, RoadmapFeature } from '../../../shared/workspace-types';
import { RoadmapPhaseCard } from './RoadmapPhaseCard';

/* ── Sample data generator (project-aware) ─────────────────── */

function generateSamplePhases(projectName: string): RoadmapPhase[] {
  return [
    {
      id: generateId(),
      name: `Phase 1 — ${projectName} Foundation`,
      description: `Core infrastructure and scaffolding for ${projectName}`,
      features: [
        {
          id: generateId(),
          title: 'Project initialization and build tooling',
          description: `Set up build tooling, linting, CI pipeline, and base configuration for ${projectName}`,
          priority: 'high',
          effort: 'medium',
          status: 'completed',
        },
        {
          id: generateId(),
          title: 'Authentication and session management',
          description: `OAuth2 integration with SSO provider and session management for ${projectName}`,
          priority: 'critical',
          effort: 'large',
          status: 'in_progress',
        },
        {
          id: generateId(),
          title: 'Database schema and data layer',
          description: `Define core entities, relationships, and migration strategy for ${projectName}`,
          priority: 'high',
          effort: 'medium',
          status: 'planned',
        },
      ],
    },
    {
      id: generateId(),
      name: `Phase 2 — ${projectName} Core Features`,
      description: `Primary user-facing functionality for ${projectName}`,
      features: [
        {
          id: generateId(),
          title: 'Dashboard and real-time views',
          description: `Real-time metrics, charts, and status panels for ${projectName}`,
          priority: 'high',
          effort: 'large',
          status: 'planned',
        },
        {
          id: generateId(),
          title: 'REST API with validation',
          description: `RESTful API with Zod validation, pagination, and structured error handling for ${projectName}`,
          priority: 'high',
          effort: 'xlarge',
          status: 'planned',
        },
        {
          id: generateId(),
          title: 'Notification and alerting system',
          description: `In-app and email notifications with user preference controls for ${projectName}`,
          priority: 'medium',
          effort: 'medium',
          status: 'planned',
        },
      ],
    },
    {
      id: generateId(),
      name: `Phase 3 — ${projectName} Polish & Launch`,
      description: `Quality assurance, performance tuning, and release prep for ${projectName}`,
      features: [
        {
          id: generateId(),
          title: 'Performance optimization pass',
          description: `Bundle splitting, caching, lazy loading, and query optimization for ${projectName}`,
          priority: 'medium',
          effort: 'large',
          status: 'planned',
        },
        {
          id: generateId(),
          title: 'Accessibility audit (WCAG 2.1 AA)',
          description: `WCAG 2.1 AA compliance review and remediation for all ${projectName} views`,
          priority: 'medium',
          effort: 'small',
          status: 'planned',
        },
        {
          id: generateId(),
          title: 'Documentation and onboarding guide',
          description: `API docs, onboarding guide, and architecture decision records for ${projectName}`,
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
  const { project, convertFeatureToTask } = useWorkspace();
  const projectName = project?.name ?? 'this project';

  const [phases, setPhases] = useState<RoadmapPhase[]>([]);

  const generateRoadmap = useCallback(() => {
    setPhases(generateSamplePhases(projectName));
  }, [projectName]);

  /* ── Stats ────────────────────────────────────────────── */
  const stats = useMemo(() => {
    const allFeatures = phases.flatMap((p) => p.features);
    const total = allFeatures.length;
    const completed = allFeatures.filter((f) => f.status === 'completed').length;
    const inProgress = allFeatures.filter((f) => f.status === 'in_progress').length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { total, completed, inProgress, pct };
  }, [phases]);

  const handleConvertToTask = useCallback((feature: RoadmapFeature) => {
    const priorityMap = { critical: 'critical', high: 'high', medium: 'medium', low: 'low' } as const;
    convertFeatureToTask(feature.id, feature.title, feature.description, priorityMap[feature.priority]);
  }, [convertFeatureToTask]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Roadmap</h2>
            <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">
              <InfoIcon className="h-3 w-3" />
              AI generation coming soon
            </span>
          </div>
          {phases.length > 0 && (
            <div className="mt-1 flex items-center gap-3">
              <span className="text-[10px] font-medium text-muted-foreground">
                {stats.total} features
              </span>
              <span className="text-[10px] font-medium text-emerald-400">
                {stats.completed} completed
              </span>
              <span className="text-[10px] font-medium text-blue-400">
                {stats.inProgress} in progress
              </span>
              <span className="text-[10px] font-medium text-muted-foreground/60">
                {stats.pct}% done
              </span>
            </div>
          )}
        </div>
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
              Generate a roadmap for {projectName}
            </p>
            <p className="mt-1 text-xs text-muted-foreground/60">
              AI will analyze your codebase and create a phased plan
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
          {phases.map((phase) => (
            <RoadmapPhaseCard key={phase.id} phase={phase} onConvertFeature={handleConvertToTask} />
          ))}
        </div>
      )}
    </div>
  );
};

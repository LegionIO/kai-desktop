import { useCallback, useMemo, type FC } from 'react';
import { MapIcon, WandSparklesIcon, LoaderIcon, WrenchIcon } from 'lucide-react';
import { generateId } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import { extractJsonFromResponse } from '@/lib/workspace-agent';
import type { RoadmapPhase, RoadmapFeature } from '../../../shared/workspace-types';
import { RoadmapPhaseCard } from './RoadmapPhaseCard';

/* ── Fallback sample data (project-aware) ─────────────────── */

function generateFallbackPhases(projectName: string): RoadmapPhase[] {
  return [
    {
      id: generateId(),
      name: `Phase 1 -- ${projectName} Foundation`,
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
      ],
    },
    {
      id: generateId(),
      name: `Phase 2 -- ${projectName} Core Features`,
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
          description: `RESTful API with Zod validation and structured error handling for ${projectName}`,
          priority: 'high',
          effort: 'xlarge',
          status: 'planned',
        },
      ],
    },
    {
      id: generateId(),
      name: `Phase 3 -- ${projectName} Polish & Launch`,
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

/* ── Parse LLM response into RoadmapPhase objects ────────── */

function parsePhasesFromResponse(text: string): RoadmapPhase[] | null {
  type RawFeature = {
    title?: string;
    description?: string;
    priority?: string;
    effort?: string;
    status?: string;
  };
  type RawPhase = {
    name?: string;
    description?: string;
    features?: RawFeature[];
  };

  const parsed = extractJsonFromResponse<{ phases: RawPhase[] }>(text);
  if (!parsed?.phases || !Array.isArray(parsed.phases)) return null;

  const validPriorities = new Set(['low', 'medium', 'high', 'critical']);
  const validEfforts = new Set(['small', 'medium', 'large', 'xlarge']);
  const validStatuses = new Set(['planned', 'in_progress', 'completed']);

  return parsed.phases
    .filter((raw) => raw.name)
    .map((raw) => ({
      id: generateId(),
      name: raw.name!,
      description: raw.description ?? '',
      features: (raw.features ?? [])
        .filter((f) => f.title)
        .map((f) => ({
          id: generateId(),
          title: f.title!,
          description: f.description ?? '',
          priority: (validPriorities.has(f.priority ?? '') ? f.priority : 'medium') as RoadmapFeature['priority'],
          effort: (validEfforts.has(f.effort ?? '') ? f.effort : 'medium') as RoadmapFeature['effort'],
          status: (validStatuses.has(f.status ?? '') ? f.status : 'planned') as RoadmapFeature['status'],
        })),
    }));
}

/* ── Component ──────────────────────────────────────────────── */

export const RoadmapView: FC = () => {
  const { project, convertFeatureToTask, roadmapPhases: phases, setRoadmapPhases: setPhases, engineStreams, startEngineStream } = useWorkspace();
  const projectName = project?.name ?? 'this project';
  const projectPath = project?.path ?? '';

  // Derive streaming state from provider
  const stream = engineStreams.get('roadmap');
  const isGenerating = stream?.status === 'streaming';
  const activeToolName = stream?.activeToolName ?? null;
  const streamProgress = isGenerating
    ? (activeToolName ? `Using ${activeToolName}...` : `Planning... (${stream?.lineCount ?? 0} lines)`)
    : '';

  const generateRoadmap = useCallback(() => {
    if (isGenerating) return;

    if (!projectPath) {
      setPhases(generateFallbackPhases(projectName));
      return;
    }

    startEngineStream({
      engine: 'roadmap',
      prompt: `Analyze the project at ${projectPath} and create a development roadmap. Examine the current state of the codebase, identify what has been built, what is in progress, and what needs to be done. Create 3-4 phases with specific features.`,
      freshConversation: true,
      onComplete: (accumulated) => {
        const parsed = parsePhasesFromResponse(accumulated);
        if (parsed && parsed.length > 0) {
          setPhases(parsed);
        } else {
          setPhases(generateFallbackPhases(projectName));
        }
      },
      onError: (error) => {
        console.error('[RoadmapView] Stream error:', error);
        setPhases(generateFallbackPhases(projectName));
      },
    });
  }, [isGenerating, projectPath, projectName, startEngineStream, setPhases]);

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
            {isGenerating && activeToolName && (
              <span className="inline-flex items-center gap-1 rounded-md bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-400">
                <WrenchIcon className="h-3 w-3 animate-pulse" />
                {activeToolName}
              </span>
            )}
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
          disabled={isGenerating}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          {isGenerating ? (
            <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <WandSparklesIcon className="h-3.5 w-3.5" />
          )}
          {isGenerating ? 'Analyzing...' : 'Generate Roadmap'}
        </button>
      </div>

      {/* Content */}
      {isGenerating ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <LoaderIcon className="h-10 w-10 animate-spin text-primary/60" />
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Analyzing {projectName}...
            </p>
            <p className="mt-1 text-xs text-muted-foreground/60">
              {streamProgress || 'Examining project structure and planning phases'}
            </p>
          </div>
        </div>
      ) : phases.length === 0 ? (
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

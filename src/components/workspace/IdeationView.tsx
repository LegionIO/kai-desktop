import { useState, useMemo, type FC } from 'react';
import { LightbulbIcon, SparklesIcon, InfoIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { generateId } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import type { Idea, IdeaCategory, IdeaSeverity } from '../../../shared/workspace-types';
import { IdeaCard } from './IdeaCard';

/* ── Category filter config ─────────────────────────────── */

const CATEGORIES: { value: IdeaCategory; label: string }[] = [
  { value: 'code-improvement', label: 'Code Improvement' },
  { value: 'code-quality',     label: 'Code Quality' },
  { value: 'performance',      label: 'Performance' },
  { value: 'security',         label: 'Security' },
  { value: 'documentation',    label: 'Documentation' },
  { value: 'ui-ux',            label: 'UI/UX' },
];

/* ── Severity badge colors ─────────────────────────────── */

const SEVERITY_COLORS: Record<IdeaSeverity, string> = {
  critical: 'text-red-400',
  high: 'text-amber-400',
  medium: 'text-blue-400',
  low: 'text-muted-foreground',
  info: 'text-slate-400',
};

/* ── Sample idea generation (project-aware) ────────────── */

function generateSampleIdeas(projectName: string): Idea[] {
  const now = Date.now();
  return [
    {
      id: generateId(),
      title: `Extract duplicated validation logic in ${projectName}`,
      description: `Multiple route handlers in ${projectName} contain identical input validation. Extract into shared middleware to reduce duplication and ensure consistency across the codebase.`,
      category: 'code-improvement',
      severity: 'medium',
      affectedFiles: ['src/api/routes/tasks.ts', 'src/api/routes/config.ts', 'src/api/routes/voice.ts'],
      createdAt: now,
    },
    {
      id: generateId(),
      title: `Add error boundaries to ${projectName} workspace views`,
      description: `Workspace engine views in ${projectName} lack error boundaries. A failing component crashes the entire workspace panel instead of showing a recovery UI. This is a high-priority reliability concern.`,
      category: 'code-quality',
      severity: 'high',
      affectedFiles: ['src/components/workspace/WorkspaceView.tsx'],
      createdAt: now - 60000,
    },
    {
      id: generateId(),
      title: `Lazy-load heavy workspace engines in ${projectName}`,
      description: `All workspace engines in ${projectName} are imported eagerly. Use React.lazy for engines like Roadmap and Ideation to reduce initial bundle size by an estimated 35%.`,
      category: 'performance',
      severity: 'medium',
      affectedFiles: ['src/components/workspace/WorkspaceView.tsx'],
      createdAt: now - 120000,
    },
    {
      id: generateId(),
      title: `Sanitize plugin configuration input in ${projectName}`,
      description: `Plugin configuration values in ${projectName} are passed directly to executeCapability without sanitization. Add Zod validation schemas to prevent injection attacks through the plugin system.`,
      category: 'security',
      severity: 'critical',
      affectedFiles: ['src/components/workspace/PluginManager.tsx', 'shared/workspace-types.ts'],
      createdAt: now - 180000,
    },
    {
      id: generateId(),
      title: `Document ${projectName} IPC protocol`,
      description: `The WorkspaceIPC interface in ${projectName} lacks JSDoc comments. Add descriptions for each method to improve developer onboarding and reduce integration errors.`,
      category: 'documentation',
      severity: 'low',
      affectedFiles: ['shared/workspace-types.ts'],
      createdAt: now - 240000,
    },
    {
      id: generateId(),
      title: `Improve task card visual hierarchy in ${projectName}`,
      description: `Task cards in ${projectName} show too many elements at equal visual weight. Emphasize title and status, de-emphasize labels and timestamps to improve scanability.`,
      category: 'ui-ux',
      severity: 'low',
      affectedFiles: ['src/components/workspace/TaskCard.tsx'],
      createdAt: now - 300000,
    },
    {
      id: generateId(),
      title: `Cache vector embeddings for repeated queries`,
      description: `The context engine in ${projectName} recomputes embeddings for identical search queries. Add an LRU cache to avoid redundant computation and reduce latency by ~60%.`,
      category: 'performance',
      severity: 'high',
      affectedFiles: ['src/tools/context-engine/analysis/endpointAnalyzer.ts'],
      createdAt: now - 360000,
    },
    {
      id: generateId(),
      title: `Enforce strict CSP headers in ${projectName}`,
      description: `The Express server in ${projectName} does not set Content-Security-Policy headers. Add CSP to prevent XSS attacks in the dashboard. This is a critical security hardening measure.`,
      category: 'security',
      severity: 'critical',
      affectedFiles: ['src/api/server.ts'],
      createdAt: now - 420000,
    },
  ];
}

/* ── Component ──────────────────────────────────────────── */

export const IdeationView: FC = () => {
  const { project, convertIdeaToTask } = useWorkspace();
  const projectName = project?.name ?? 'this project';

  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [activeCategory, setActiveCategory] = useState<IdeaCategory | 'all'>('all');

  const filteredIdeas =
    activeCategory === 'all'
      ? ideas
      : ideas.filter((idea) => idea.category === activeCategory);

  /* ── Severity distribution summary ────────────────────── */
  const severityDistribution = useMemo(() => {
    const counts: Record<IdeaSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const idea of ideas) {
      counts[idea.severity]++;
    }
    return counts;
  }, [ideas]);

  const severitySummaryParts = useMemo(() => {
    const parts: { label: string; count: number; severity: IdeaSeverity }[] = [];
    for (const sev of ['critical', 'high', 'medium', 'low', 'info'] as IdeaSeverity[]) {
      if (severityDistribution[sev] > 0) {
        parts.push({ label: sev, count: severityDistribution[sev], severity: sev });
      }
    }
    return parts;
  }, [severityDistribution]);

  const handleGenerate = () => {
    setIdeas(generateSampleIdeas(projectName));
  };

  const handleConvertToTask = (idea: Idea) => {
    const priority = idea.severity === 'critical' ? 'critical' : idea.severity === 'high' ? 'high' : 'medium';
    convertIdeaToTask(idea.id, idea.title, idea.description, priority);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Ideation</h2>
            <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">
              <InfoIcon className="h-3 w-3" />
              AI generation coming soon
            </span>
          </div>
          {ideas.length > 0 && (
            <div className="mt-1 flex items-center gap-2">
              {severitySummaryParts.map((part) => (
                <span key={part.severity} className={cn('text-[10px] font-medium', SEVERITY_COLORS[part.severity])}>
                  {part.count} {part.label}
                </span>
              ))}
              <span className="text-[10px] text-muted-foreground/40">
                ({ideas.length} total)
              </span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={handleGenerate}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <SparklesIcon className="h-3.5 w-3.5" />
          Generate Ideas
        </button>
      </div>

      {/* Category filter */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/40 px-5 py-2.5">
        <button
          type="button"
          onClick={() => setActiveCategory('all')}
          className={cn(
            'rounded-full px-2.5 py-1 text-[10px] font-medium transition-colors',
            activeCategory === 'all'
              ? 'bg-primary/15 text-primary'
              : 'bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground',
          )}
        >
          All
        </button>
        {CATEGORIES.map((cat) => (
          <button
            key={cat.value}
            type="button"
            onClick={() => setActiveCategory(cat.value)}
            className={cn(
              'rounded-full px-2.5 py-1 text-[10px] font-medium transition-colors',
              activeCategory === cat.value
                ? 'bg-primary/15 text-primary'
                : 'bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground',
            )}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {filteredIdeas.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <LightbulbIcon className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                {ideas.length === 0
                  ? 'Generate ideas to discover improvements'
                  : 'No ideas match this category'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground/60">
                {ideas.length === 0
                  ? `AI will analyze ${projectName} and suggest actionable improvements.`
                  : 'Try selecting a different category filter.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filteredIdeas.map((idea) => (
              <IdeaCard key={idea.id} idea={idea} onConvert={() => handleConvertToTask(idea)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

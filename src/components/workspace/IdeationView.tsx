import { useState, type FC } from 'react';
import { LightbulbIcon, SparklesIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { generateId } from '@/lib/utils';
import type { Idea, IdeaCategory } from '../../../shared/workspace-types';
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

/* ── Sample idea generation ─────────────────────────────── */

function generateSampleIdeas(): Idea[] {
  const now = Date.now();
  return [
    {
      id: generateId(),
      title: 'Extract duplicated validation logic',
      description: 'Multiple route handlers contain identical input validation. Extract into shared middleware to reduce duplication and ensure consistency.',
      category: 'code-improvement',
      severity: 'medium',
      affectedFiles: ['src/api/routes/tasks.ts', 'src/api/routes/config.ts', 'src/api/routes/voice.ts'],
      createdAt: now,
    },
    {
      id: generateId(),
      title: 'Add error boundary to workspace views',
      description: 'Workspace engine views lack error boundaries. A failing component crashes the entire workspace panel instead of showing a recovery UI.',
      category: 'code-quality',
      severity: 'high',
      affectedFiles: ['src/components/workspace/WorkspaceView.tsx'],
      createdAt: now - 60000,
    },
    {
      id: generateId(),
      title: 'Lazy-load heavy workspace engines',
      description: 'All workspace engines are imported eagerly. Use React.lazy for engines like Roadmap and Ideation to reduce initial bundle size.',
      category: 'performance',
      severity: 'medium',
      affectedFiles: ['src/components/workspace/WorkspaceView.tsx'],
      createdAt: now - 120000,
    },
    {
      id: generateId(),
      title: 'Sanitize user input in plugin config',
      description: 'Plugin configuration values are passed directly to executeCapability without sanitization. Add input validation to prevent injection.',
      category: 'security',
      severity: 'critical',
      affectedFiles: ['src/components/workspace/PluginManager.tsx', 'shared/workspace-types.ts'],
      createdAt: now - 180000,
    },
    {
      id: generateId(),
      title: 'Document workspace IPC protocol',
      description: 'The WorkspaceIPC interface lacks JSDoc comments. Add descriptions for each method to improve developer onboarding.',
      category: 'documentation',
      severity: 'low',
      affectedFiles: ['shared/workspace-types.ts'],
      createdAt: now - 240000,
    },
    {
      id: generateId(),
      title: 'Improve task card visual hierarchy',
      description: 'Task cards show too many elements at equal weight. Emphasize title and status, de-emphasize labels and timestamps.',
      category: 'ui-ux',
      severity: 'low',
      affectedFiles: ['src/components/workspace/TaskCard.tsx'],
      createdAt: now - 300000,
    },
    {
      id: generateId(),
      title: 'Cache vector embeddings for repeated queries',
      description: 'The context engine recomputes embeddings for identical search queries. Add an LRU cache to avoid redundant computation.',
      category: 'performance',
      severity: 'high',
      affectedFiles: ['src/tools/context-engine/analysis/endpointAnalyzer.ts'],
      createdAt: now - 360000,
    },
    {
      id: generateId(),
      title: 'Enforce strict CSP headers',
      description: 'The Express server does not set Content-Security-Policy headers. Add CSP to prevent XSS in the dashboard.',
      category: 'security',
      severity: 'high',
      affectedFiles: ['src/api/server.ts'],
      createdAt: now - 420000,
    },
  ];
}

/* ── Component ──────────────────────────────────────────── */

export const IdeationView: FC = () => {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [activeCategory, setActiveCategory] = useState<IdeaCategory | 'all'>('all');

  const filteredIdeas =
    activeCategory === 'all'
      ? ideas
      : ideas.filter((idea) => idea.category === activeCategory);

  const handleGenerate = () => {
    setIdeas(generateSampleIdeas());
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">Ideation</h2>
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
                  ? 'AI will analyze your codebase and suggest actionable improvements.'
                  : 'Try selecting a different category filter.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filteredIdeas.map((idea) => (
              <IdeaCard key={idea.id} idea={idea} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

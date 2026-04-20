import { useState, useMemo, useCallback, type FC } from 'react';
import { LightbulbIcon, SparklesIcon, LoaderIcon, WrenchIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { generateId } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import { extractJsonFromResponse } from '@/lib/workspace-agent';
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

/* ── Fallback sample ideas (used when LLM unavailable) ────── */

function generateFallbackIdeas(projectName: string): Idea[] {
  const now = Date.now();
  return [
    {
      id: generateId(),
      title: `Extract duplicated validation logic in ${projectName}`,
      description: `Multiple route handlers contain identical input validation. Extract into shared middleware.`,
      category: 'code-improvement',
      severity: 'medium',
      affectedFiles: ['src/api/routes/tasks.ts', 'src/api/routes/config.ts'],
      createdAt: now,
    },
    {
      id: generateId(),
      title: `Add error boundaries to workspace views`,
      description: `Workspace engine views lack error boundaries. A failing component crashes the entire workspace panel.`,
      category: 'code-quality',
      severity: 'high',
      affectedFiles: ['src/components/workspace/WorkspaceView.tsx'],
      createdAt: now - 60000,
    },
    {
      id: generateId(),
      title: `Lazy-load heavy workspace engines`,
      description: `All workspace engines are imported eagerly. Use React.lazy for less-used engines to reduce initial bundle size.`,
      category: 'performance',
      severity: 'medium',
      affectedFiles: ['src/components/workspace/WorkspaceView.tsx'],
      createdAt: now - 120000,
    },
  ];
}

/* ── Parse LLM response into Idea objects ────────────────── */

function parseIdeasFromResponse(text: string): Idea[] | null {
  type RawIdea = {
    title?: string;
    description?: string;
    category?: string;
    severity?: string;
    affectedFiles?: string[];
    suggestedFix?: string;
  };

  const parsed = extractJsonFromResponse<{ ideas: RawIdea[] }>(text);
  if (!parsed?.ideas || !Array.isArray(parsed.ideas)) return null;

  const validCategories = new Set<string>(CATEGORIES.map((c) => c.value));
  const validSeverities = new Set<string>(['info', 'low', 'medium', 'high', 'critical']);
  const now = Date.now();

  return parsed.ideas
    .filter((raw) => raw.title && raw.description)
    .map((raw, idx) => ({
      id: generateId(),
      title: raw.title!,
      description: raw.description! + (raw.suggestedFix ? `\n\n**Suggested fix:** ${raw.suggestedFix}` : ''),
      category: (validCategories.has(raw.category ?? '') ? raw.category : 'code-improvement') as IdeaCategory,
      severity: (validSeverities.has(raw.severity ?? '') ? raw.severity : 'medium') as IdeaSeverity,
      affectedFiles: Array.isArray(raw.affectedFiles) ? raw.affectedFiles : [],
      createdAt: now - idx * 1000,
    }));
}

/* ── Component ──────────────────────────────────────────── */

export const IdeationView: FC = () => {
  const { project, convertIdeaToTask, ideas, setIdeas, engineStreams, startEngineStream } = useWorkspace();
  const projectName = project?.name ?? 'this project';
  const projectPath = project?.path ?? '';

  const [activeCategory, setActiveCategory] = useState<IdeaCategory | 'all'>('all');

  // Derive streaming state from provider
  const stream = engineStreams.get('ideation');
  const isGenerating = stream?.status === 'streaming';
  const activeToolName = stream?.activeToolName ?? null;
  const streamProgress = isGenerating
    ? (activeToolName ? `Using ${activeToolName}...` : `Analyzing... (${stream?.lineCount ?? 0} lines)`)
    : '';

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

  const handleGenerate = useCallback(() => {
    if (isGenerating) return;

    if (!projectPath) {
      setIdeas(generateFallbackIdeas(projectName));
      return;
    }

    startEngineStream({
      engine: 'ideation',
      prompt: `Analyze the codebase at ${projectPath} and generate improvement ideas. Focus on actionable, specific suggestions across all categories (code quality, performance, security, documentation, UI/UX, architecture).`,
      freshConversation: true,
      onComplete: (accumulated) => {
        const parsed = parseIdeasFromResponse(accumulated);
        if (parsed && parsed.length > 0) {
          setIdeas(parsed);
        } else {
          setIdeas(generateFallbackIdeas(projectName));
        }
      },
      onError: (error) => {
        console.error('[IdeationView] Stream error:', error);
        setIdeas(generateFallbackIdeas(projectName));
      },
    });
  }, [isGenerating, projectPath, projectName, startEngineStream, setIdeas]);

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
            {isGenerating && activeToolName && (
              <span className="inline-flex items-center gap-1 rounded-md bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-400">
                <WrenchIcon className="h-3 w-3 animate-pulse" />
                {activeToolName}
              </span>
            )}
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
          disabled={isGenerating}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          {isGenerating ? (
            <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <SparklesIcon className="h-3.5 w-3.5" />
          )}
          {isGenerating ? 'Analyzing...' : 'Generate Ideas'}
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
        {isGenerating ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <LoaderIcon className="h-10 w-10 animate-spin text-primary/60" />
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Analyzing {projectName}...
              </p>
              <p className="mt-1 text-xs text-muted-foreground/60">
                {streamProgress || 'Scanning codebase for improvements'}
              </p>
            </div>
          </div>
        ) : filteredIdeas.length === 0 ? (
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

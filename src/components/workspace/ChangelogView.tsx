import { useState, useCallback, type FC } from 'react';
import { FileTextIcon, PlusIcon, CopyIcon, CheckIcon, CalendarIcon, LoaderIcon, WrenchIcon } from 'lucide-react';
import { generateId } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';
import { extractJsonFromResponse } from '@/lib/workspace-agent';
import type { ChangelogRelease, ChangelogChange } from '../../../shared/workspace-types';
import { ChangelogEntry } from './ChangelogEntry';

/* ── Date formatting ───────────────────────────────────────── */

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/* ── Fallback release generation ──────────────────────────── */

function generateFallbackRelease(projectName: string): ChangelogRelease {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  return {
    id: generateId(),
    version: `1.${now.getMonth()}.${now.getDate()}`,
    date: dateStr,
    summary: `Workspace engine improvements and bug fixes for ${projectName} from completed tasks.`,
    changes: [
      { type: 'added', description: `Ideation engine with AI-powered code improvement suggestions for ${projectName}` },
      { type: 'added', description: 'Worktree management panel for isolated branch workflows' },
      { type: 'changed', description: 'Kanban board cards now display progress bars for in-flight tasks' },
      { type: 'fixed', description: 'Task status transitions no longer skip the AI review step' },
      { type: 'removed', description: 'Deprecated v0 workspace API endpoints' },
    ],
  };
}

/* ── Parse LLM response into a ChangelogRelease ──────────── */

function parseChangelogFromResponse(text: string): ChangelogRelease | null {
  type RawChange = {
    type?: string;
    description?: string;
  };
  type RawChangelog = {
    version?: string;
    date?: string;
    summary?: string;
    changes?: RawChange[];
  };

  const parsed = extractJsonFromResponse<RawChangelog>(text);
  if (!parsed?.changes || !Array.isArray(parsed.changes)) return null;

  const validTypes = new Set(['added', 'changed', 'fixed', 'removed']);
  const now = new Date();

  return {
    id: generateId(),
    version: parsed.version ?? `1.${now.getMonth()}.${now.getDate()}`,
    date: parsed.date ?? now.toISOString().split('T')[0],
    summary: parsed.summary ?? 'Release notes generated from git history.',
    changes: parsed.changes
      .filter((c) => c.description)
      .map((c) => ({
        type: (validTypes.has(c.type ?? '') ? c.type : 'changed') as ChangelogChange['type'],
        description: c.description!,
      })),
  };
}

/* ── Component ──────────────────────────────────────────── */

export const ChangelogView: FC = () => {
  const { project, tasks, changelogReleases: releases, setChangelogReleases: setReleases, engineStreams, startEngineStream } = useWorkspace();
  const projectName = project?.name ?? 'this project';
  const projectPath = project?.path ?? '';

  const [copied, setCopied] = useState(false);

  // Derive streaming state from provider
  const stream = engineStreams.get('changelog');
  const isGenerating = stream?.status === 'streaming';
  const activeToolName = stream?.activeToolName ?? null;
  const streamProgress = isGenerating
    ? (activeToolName ? `Using ${activeToolName}...` : `Analyzing history... (${stream?.lineCount ?? 0} lines)`)
    : '';

  const handleGenerate = useCallback(() => {
    if (isGenerating) return;

    const doneTasks = tasks.filter((t) => t.status === 'done');

    // If no project path, fall back to task-based or sample changelog
    if (!projectPath) {
      if (doneTasks.length > 0) {
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        const changes: ChangelogChange[] = doneTasks.map((task) => {
          let type: ChangelogChange['type'] = 'changed';
          const title = task.title.toLowerCase();
          if (title.includes('add') || title.includes('new') || title.includes('create') || title.includes('implement')) {
            type = 'added';
          } else if (title.includes('fix') || title.includes('bug') || title.includes('resolve')) {
            type = 'fixed';
          } else if (title.includes('remove') || title.includes('delete') || title.includes('deprecate')) {
            type = 'removed';
          }
          const ideaLabel = task.labels.find((l) => l.startsWith('idea:'));
          const roadmapLabel = task.labels.find((l) => l.startsWith('roadmap:'));
          let origin = '';
          if (ideaLabel) origin = ' (from Ideation)';
          if (roadmapLabel) origin = ' (from Roadmap)';
          return { type, description: `${task.title}${origin}`, taskId: task.id };
        });

        const release: ChangelogRelease = {
          id: generateId(),
          version: `1.${now.getMonth()}.${now.getDate()}`,
          date: dateStr,
          summary: `Release compiled from ${doneTasks.length} completed task${doneTasks.length > 1 ? 's' : ''} in ${projectName}.`,
          changes,
        };
        setReleases([release, ...releases]);
      } else {
        setReleases([generateFallbackRelease(projectName), ...releases]);
      }
      return;
    }

    const taskContext = doneTasks.length > 0
      ? `\n\nCompleted tasks:\n${doneTasks.map((t) => `- ${t.title}: ${t.description}`).join('\n')}`
      : '';

    startEngineStream({
      engine: 'changelog',
      prompt: `Generate a changelog for the project at ${projectPath}. Examine git log for recent changes and categorize them.${taskContext}`,
      freshConversation: true,
      onComplete: (accumulated) => {
        const parsed = parseChangelogFromResponse(accumulated);
        if (parsed && parsed.changes.length > 0) {
          setReleases([parsed, ...releases]);
        } else if (doneTasks.length > 0) {
          const now = new Date();
          const dateStr = now.toISOString().split('T')[0];
          const changes: ChangelogChange[] = doneTasks.map((task) => {
            let type: ChangelogChange['type'] = 'changed';
            const title = task.title.toLowerCase();
            if (title.includes('add') || title.includes('new')) type = 'added';
            else if (title.includes('fix') || title.includes('bug')) type = 'fixed';
            else if (title.includes('remove') || title.includes('delete')) type = 'removed';
            return { type, description: task.title };
          });
          setReleases([{
            id: generateId(),
            version: `1.${now.getMonth()}.${now.getDate()}`,
            date: dateStr,
            summary: `Release compiled from ${doneTasks.length} completed tasks.`,
            changes,
          }, ...releases]);
        } else {
          setReleases([generateFallbackRelease(projectName), ...releases]);
        }
      },
      onError: (error) => {
        console.error('[ChangelogView] Stream error:', error);
        setReleases([generateFallbackRelease(projectName), ...releases]);
      },
    });
  }, [isGenerating, projectPath, projectName, tasks, releases, setReleases, startEngineStream]);

  const handleCopy = async () => {
    if (releases.length === 0) return;

    const text = releases
      .map((r) => {
        const header = `## ${r.version} (${r.date})\n\n${r.summary}`;
        const sections = (['added', 'changed', 'fixed', 'removed'] as const)
          .map((type) => {
            const items = r.changes.filter((c) => c.type === type);
            if (items.length === 0) return '';
            const label = type.charAt(0).toUpperCase() + type.slice(1);
            return `### ${label}\n${items.map((c) => `- ${c.description}`).join('\n')}`;
          })
          .filter(Boolean)
          .join('\n\n');
        return `${header}\n\n${sections}`;
      })
      .join('\n\n---\n\n');

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Changelog</h2>
            {isGenerating && activeToolName && (
              <span className="inline-flex items-center gap-1 rounded-md bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-400">
                <WrenchIcon className="h-3 w-3 animate-pulse" />
                {activeToolName}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/50">
            <CalendarIcon className="h-3 w-3" />
            {formatDate(new Date())}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            disabled={releases.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
          >
            {copied ? (
              <CheckIcon className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <CopyIcon className="h-3.5 w-3.5" />
            )}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={isGenerating}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            {isGenerating ? (
              <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <PlusIcon className="h-3.5 w-3.5" />
            )}
            {isGenerating ? 'Analyzing...' : 'Generate Changelog'}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isGenerating ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <LoaderIcon className="h-10 w-10 animate-spin text-primary/60" />
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Analyzing git history...
              </p>
              <p className="mt-1 text-xs text-muted-foreground/60">
                {streamProgress || 'Scanning commits and generating release notes'}
              </p>
            </div>
          </div>
        ) : releases.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <FileTextIcon className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Generate a changelog from git history
              </p>
              <p className="mt-1 text-xs text-muted-foreground/60">
                {tasks.filter((t) => t.status === 'done').length > 0
                  ? `${tasks.filter((t) => t.status === 'done').length} done task(s) will be included with git history analysis.`
                  : 'AI will analyze git commits to generate release notes.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {releases.map((release) => (
              <ChangelogEntry key={release.id} release={release} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

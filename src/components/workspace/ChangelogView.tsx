import { useState, type FC } from 'react';
import { FileTextIcon, PlusIcon, CopyIcon, CheckIcon } from 'lucide-react';
import { generateId } from '@/lib/utils';
import type { ChangelogRelease } from '../../../shared/workspace-types';
import { ChangelogEntry } from './ChangelogEntry';

/* ── Sample release generation ──────────────────────────── */

function generateSampleRelease(): ChangelogRelease {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  return {
    id: generateId(),
    version: `1.${now.getMonth()}.${now.getDate()}`,
    date: dateStr,
    summary: 'Workspace engine improvements and bug fixes from completed tasks.',
    changes: [
      { type: 'added', description: 'Ideation engine with AI-powered code improvement suggestions' },
      { type: 'added', description: 'Worktree management panel for isolated branch workflows' },
      { type: 'changed', description: 'Kanban board cards now display progress bars for in-flight tasks' },
      { type: 'changed', description: 'Plugin settings use tabbed layout for better organization' },
      { type: 'fixed', description: 'Task status transitions no longer skip the AI review step' },
      { type: 'fixed', description: 'Terminal output scrolling jumps on new content' },
      { type: 'removed', description: 'Deprecated v0 workspace API endpoints' },
    ],
  };
}

/* ── Component ──────────────────────────────────────────── */

export const ChangelogView: FC = () => {
  const [releases, setReleases] = useState<ChangelogRelease[]>([]);
  const [copied, setCopied] = useState(false);

  const handleGenerate = () => {
    setReleases((prev) => [generateSampleRelease(), ...prev]);
  };

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
        <h2 className="text-sm font-semibold text-foreground">Changelog</h2>
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
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <PlusIcon className="h-3.5 w-3.5" />
            Generate Changelog
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {releases.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <FileTextIcon className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Generate a changelog from completed tasks
              </p>
              <p className="mt-1 text-xs text-muted-foreground/60">
                AI will compile release notes from your done tasks.
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

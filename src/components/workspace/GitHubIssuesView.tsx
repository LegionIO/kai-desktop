import { useState, type FC } from 'react';
import { GitBranchIcon, TagIcon, UserIcon, ClockIcon, ArrowRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/providers/WorkspaceProvider';

/* ── Sample GitHub issues ─────────────────────────────────── */

interface GitHubIssue {
  number: number;
  title: string;
  labels: Array<{ name: string; color: string }>;
  author: string;
  createdAt: number;
  state: 'open' | 'closed';
}

const SAMPLE_ISSUES: GitHubIssue[] = [
  {
    number: 42,
    title: 'Fix authentication token refresh on session expiry',
    labels: [
      { name: 'bug', color: 'red' },
      { name: 'auth', color: 'purple' },
    ],
    author: 'dev-sarah',
    createdAt: Date.now() - 2 * 60 * 60 * 1000,
    state: 'open',
  },
  {
    number: 41,
    title: 'Add dark mode toggle to settings panel',
    labels: [
      { name: 'enhancement', color: 'blue' },
      { name: 'ui', color: 'cyan' },
    ],
    author: 'dev-mike',
    createdAt: Date.now() - 5 * 60 * 60 * 1000,
    state: 'open',
  },
  {
    number: 39,
    title: 'Update TypeScript to 5.9 and fix type errors',
    labels: [
      { name: 'chore', color: 'amber' },
      { name: 'dependencies', color: 'slate' },
    ],
    author: 'dev-alex',
    createdAt: Date.now() - 24 * 60 * 60 * 1000,
    state: 'open',
  },
  {
    number: 37,
    title: 'Implement webhook retry with exponential backoff',
    labels: [
      { name: 'enhancement', color: 'blue' },
      { name: 'backend', color: 'emerald' },
    ],
    author: 'dev-sarah',
    createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
    state: 'open',
  },
  {
    number: 35,
    title: 'Memory leak in WebSocket connection handler',
    labels: [
      { name: 'bug', color: 'red' },
      { name: 'critical', color: 'red' },
    ],
    author: 'dev-jordan',
    createdAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
    state: 'open',
  },
  {
    number: 33,
    title: 'Add pagination to REST API list endpoints',
    labels: [
      { name: 'enhancement', color: 'blue' },
      { name: 'api', color: 'purple' },
    ],
    author: 'dev-mike',
    createdAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
    state: 'open',
  },
];

/* ── Label color mapping ──────────────────────────────────── */

const LABEL_COLORS: Record<string, { border: string; bg: string; text: string }> = {
  red:     { border: 'border-red-500/30',     bg: 'bg-red-500/10',     text: 'text-red-400' },
  blue:    { border: 'border-blue-500/30',    bg: 'bg-blue-500/10',    text: 'text-blue-400' },
  purple:  { border: 'border-purple-500/30',  bg: 'bg-purple-500/10',  text: 'text-purple-400' },
  cyan:    { border: 'border-cyan-500/30',    bg: 'bg-cyan-500/10',    text: 'text-cyan-400' },
  amber:   { border: 'border-amber-500/30',   bg: 'bg-amber-500/10',   text: 'text-amber-400' },
  emerald: { border: 'border-emerald-500/30', bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
  slate:   { border: 'border-slate-500/30',   bg: 'bg-slate-500/10',   text: 'text-slate-400' },
};

function getLabelStyle(color: string) {
  return LABEL_COLORS[color] ?? LABEL_COLORS.slate;
}

/* ── Time ago ─────────────────────────────────────────────── */

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/* ── Component ────────────────────────────────────────────── */

export const GitHubIssuesView: FC = () => {
  const { addTask } = useWorkspace();
  const [importedIds, setImportedIds] = useState<Set<number>>(new Set());

  const handleImport = (issue: GitHubIssue) => {
    const priority = issue.labels.some((l) => l.name === 'critical')
      ? 'critical' as const
      : issue.labels.some((l) => l.name === 'bug')
        ? 'high' as const
        : 'medium' as const;

    addTask(
      `#${issue.number} ${issue.title}`,
      `Imported from GitHub issue #${issue.number} by @${issue.author}`,
      priority,
      [`github:issue:${issue.number}`],
    );
    setImportedIds((prev) => new Set(prev).add(issue.number));
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
        <div className="flex items-center gap-2">
          <GitBranchIcon className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">GitHub Issues</h2>
          <span className="rounded-full bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {SAMPLE_ISSUES.length} open
          </span>
        </div>
      </div>

      {/* Issues list */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-2">
          {SAMPLE_ISSUES.map((issue) => {
            const isImported = importedIds.has(issue.number);
            return (
              <div
                key={issue.number}
                className="group flex items-start gap-3 rounded-xl border border-border/60 bg-card/80 p-3 transition-colors hover:border-border"
              >
                {/* Issue number */}
                <span className="mt-0.5 shrink-0 font-mono text-xs font-bold text-muted-foreground/60">
                  #{issue.number}
                </span>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm font-medium text-foreground leading-snug">
                    {issue.title}
                  </h4>

                  {/* Labels */}
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {issue.labels.map((label) => {
                      const style = getLabelStyle(label.color);
                      return (
                        <span
                          key={label.name}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium leading-none',
                            style.border,
                            style.bg,
                            style.text,
                          )}
                        >
                          <TagIcon className="h-2 w-2" />
                          {label.name}
                        </span>
                      );
                    })}
                  </div>

                  {/* Meta */}
                  <div className="mt-2 flex items-center gap-3 text-[10px] text-muted-foreground/50">
                    <span className="inline-flex items-center gap-1">
                      <UserIcon className="h-2.5 w-2.5" />
                      {issue.author}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <ClockIcon className="h-2.5 w-2.5" />
                      {timeAgo(issue.createdAt)}
                    </span>
                  </div>
                </div>

                {/* Import button */}
                <div className="shrink-0">
                  {isImported ? (
                    <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 text-[10px] font-medium text-emerald-400">
                      Imported
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleImport(issue)}
                      className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-[10px] font-medium text-primary transition-colors hover:bg-primary/15"
                    >
                      <ArrowRightIcon className="h-3 w-3" />
                      Import to Kanban
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

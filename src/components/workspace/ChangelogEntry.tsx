import type { FC } from 'react';
import { cn } from '@/lib/utils';
import type { ChangelogRelease, ChangelogChange } from '../../../shared/workspace-types';

/* ── Change type config ─────────────────────────────────── */

const CHANGE_TYPE_CONFIG: Record<
  ChangelogChange['type'],
  { label: string; textClass: string; dotClass: string }
> = {
  added:      { label: 'Added',      textClass: 'text-emerald-400', dotClass: 'bg-emerald-400' },
  changed:    { label: 'Changed',    textClass: 'text-blue-400',    dotClass: 'bg-blue-400' },
  fixed:      { label: 'Fixed',      textClass: 'text-amber-400',   dotClass: 'bg-amber-400' },
  removed:    { label: 'Removed',    textClass: 'text-red-400',     dotClass: 'bg-red-400' },
  deprecated: { label: 'Deprecated', textClass: 'text-orange-400',  dotClass: 'bg-orange-400' },
  security:   { label: 'Security',   textClass: 'text-purple-400',  dotClass: 'bg-purple-400' },
};

const CHANGE_TYPE_ORDER: ChangelogChange['type'][] = ['added', 'changed', 'deprecated', 'removed', 'fixed', 'security'];

/* ── Component ──────────────────────────────────────────── */

interface ChangelogEntryProps {
  release: ChangelogRelease;
}

export const ChangelogEntry: FC<ChangelogEntryProps> = ({ release }) => {
  // Group changes by type
  const grouped: Partial<Record<ChangelogChange['type'], ChangelogChange[]>> = {};
  for (const change of release.changes) {
    (grouped[change.type] ??= []).push(change);
  }

  return (
    <div className="relative flex gap-4 rounded-xl border border-border/60 bg-card/80 p-4">
      {/* Version badge with colored left accent */}
      <div className="flex flex-col items-center gap-1">
        <span className="inline-flex items-center rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 font-mono text-xs font-bold text-emerald-400">
          {release.version}
        </span>
        <div className="h-full w-px bg-border/40" />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        {/* Date */}
        <p className="text-xs text-muted-foreground/60">{release.date}</p>

        {/* Summary */}
        <p className="mt-1 text-sm text-foreground leading-relaxed">{release.summary}</p>

        {/* Changes grouped by type */}
        <div className="mt-3 flex flex-col gap-3">
          {CHANGE_TYPE_ORDER.map((type) => {
            const changes = grouped[type];
            if (!changes || changes.length === 0) return null;
            const config = CHANGE_TYPE_CONFIG[type];

            return (
              <div key={type}>
                <span
                  className={cn(
                    'inline-flex items-center rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase leading-none',
                    type === 'added'   && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
                    type === 'changed' && 'border-blue-500/30 bg-blue-500/10 text-blue-400',
                    type === 'fixed'   && 'border-amber-500/30 bg-amber-500/10 text-amber-400',
                    type === 'removed' && 'border-red-500/30 bg-red-500/10 text-red-400',
                  )}
                >
                  {config.label}
                </span>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {changes.map((change, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground/80 leading-relaxed">
                      <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', config.dotClass)} />
                      {change.description}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

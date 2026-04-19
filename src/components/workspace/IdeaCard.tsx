import type { FC } from 'react';
import {
  CodeIcon,
  ShieldCheckIcon,
  ZapIcon,
  LockIcon,
  FileTextIcon,
  PaletteIcon,
  ArrowRightIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Idea, IdeaCategory, IdeaSeverity } from '../../../shared/workspace-types';

/* ── Category config ────────────────────────────────────── */

const CATEGORY_CONFIG: Record<
  IdeaCategory,
  { icon: FC<{ className?: string }>; label: string; badgeClass: string }
> = {
  'code-improvement': {
    icon: CodeIcon,
    label: 'Code Improvement',
    badgeClass: 'border-blue-500/40 bg-blue-500/10 text-blue-400',
  },
  'code-quality': {
    icon: ShieldCheckIcon,
    label: 'Code Quality',
    badgeClass: 'border-purple-500/40 bg-purple-500/10 text-purple-400',
  },
  performance: {
    icon: ZapIcon,
    label: 'Performance',
    badgeClass: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  },
  security: {
    icon: LockIcon,
    label: 'Security',
    badgeClass: 'border-red-500/40 bg-red-500/10 text-red-400',
  },
  documentation: {
    icon: FileTextIcon,
    label: 'Documentation',
    badgeClass: 'border-slate-500/40 bg-slate-500/10 text-slate-400',
  },
  'ui-ux': {
    icon: PaletteIcon,
    label: 'UI/UX',
    badgeClass: 'border-pink-500/40 bg-pink-500/10 text-pink-400',
  },
};

/* ── Severity config ────────────────────────────────────── */

const SEVERITY_CONFIG: Record<IdeaSeverity, { label: string; badgeClass: string }> = {
  critical: { label: 'Critical', badgeClass: 'border-red-500/40 bg-red-500/10 text-red-400' },
  high:     { label: 'High',     badgeClass: 'border-amber-500/40 bg-amber-500/10 text-amber-400' },
  medium:   { label: 'Medium',   badgeClass: 'border-blue-500/40 bg-blue-500/10 text-blue-400' },
  low:      { label: 'Low',      badgeClass: 'border-muted-foreground/30 bg-muted/20 text-muted-foreground' },
  info:     { label: 'Info',     badgeClass: 'border-slate-500/40 bg-slate-500/10 text-slate-400' },
};

/* ── Component ──────────────────────────────────────────── */

interface IdeaCardProps {
  idea: Idea;
  onConvert?: () => void;
}

export const IdeaCard: FC<IdeaCardProps> = ({ idea, onConvert }) => {
  const cat = CATEGORY_CONFIG[idea.category];
  const sev = SEVERITY_CONFIG[idea.severity];
  const CatIcon = cat.icon;

  return (
    <div className="group flex flex-col rounded-xl border border-border/60 bg-card/80 p-3 transition-colors hover:border-border">
      {/* Category badge */}
      <div className="flex items-center gap-2">
        <CatIcon className="h-3.5 w-3.5 shrink-0" />
        <span
          className={cn(
            'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none',
            cat.badgeClass,
          )}
        >
          {cat.label}
        </span>
      </div>

      {/* Title */}
      <h4 className="mt-2 text-sm font-medium text-foreground leading-snug">{idea.title}</h4>

      {/* Description */}
      <p className="mt-1 line-clamp-3 text-xs text-muted-foreground/70 leading-relaxed">
        {idea.description}
      </p>

      {/* Affected files */}
      {idea.affectedFiles.length > 0 && (
        <div className="mt-2 flex flex-col gap-0.5">
          {idea.affectedFiles.slice(0, 2).map((file) => (
            <span
              key={file}
              className="truncate font-mono text-[10px] text-muted-foreground/50"
            >
              {file}
            </span>
          ))}
          {idea.affectedFiles.length > 2 && (
            <span className="text-[10px] text-muted-foreground/40">
              +{idea.affectedFiles.length - 2} more
            </span>
          )}
        </div>
      )}

      {/* Footer: severity + convert button */}
      <div className="mt-auto flex items-center justify-between pt-3">
        <span
          className={cn(
            'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none',
            sev.badgeClass,
          )}
        >
          {sev.label}
        </span>

        <button
          type="button"
          onClick={onConvert}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground/40 transition-colors hover:bg-primary/10 hover:text-primary group-hover:text-muted-foreground/70"
        >
          Convert to Task
          <ArrowRightIcon className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
};

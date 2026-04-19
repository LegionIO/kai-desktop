import type { FC } from 'react';
import { ArrowRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RoadmapFeature, RoadmapPriority } from '../../../shared/workspace-types';

/* ── Badge config ───────────────────────────────────────────── */

const PRIORITY_BADGE: Record<RoadmapPriority, { label: string; className: string }> = {
  low:      { label: 'Low',      className: 'border-slate-500/40 bg-slate-500/10 text-slate-400' },
  medium:   { label: 'Medium',   className: 'border-blue-500/40 bg-blue-500/10 text-blue-400' },
  high:     { label: 'High',     className: 'border-amber-500/40 bg-amber-500/10 text-amber-400' },
  critical: { label: 'Critical', className: 'border-red-500/40 bg-red-500/10 text-red-400' },
};

const EFFORT_BADGE: Record<RoadmapFeature['effort'], { label: string; className: string }> = {
  small:  { label: 'S',  className: 'border-slate-500/40 bg-slate-500/10 text-slate-400' },
  medium: { label: 'M',  className: 'border-blue-500/40 bg-blue-500/10 text-blue-400' },
  large:  { label: 'L',  className: 'border-amber-500/40 bg-amber-500/10 text-amber-400' },
  xlarge: { label: 'XL', className: 'border-red-500/40 bg-red-500/10 text-red-400' },
};

const STATUS_BADGE: Record<RoadmapFeature['status'], { label: string; className: string }> = {
  planned:     { label: 'Planned',     className: 'border-slate-500/40 bg-slate-500/10 text-slate-400' },
  in_progress: { label: 'In Progress', className: 'border-blue-500/40 bg-blue-500/10 text-blue-400' },
  completed:   { label: 'Completed',   className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' },
};

/* ── Component ──────────────────────────────────────────────── */

interface RoadmapFeatureCardProps {
  feature: RoadmapFeature;
  onConvert?: () => void;
}

export const RoadmapFeatureCard: FC<RoadmapFeatureCardProps> = ({ feature, onConvert }) => {
  const priority = PRIORITY_BADGE[feature.priority];
  const effort = EFFORT_BADGE[feature.effort];
  const status = STATUS_BADGE[feature.status];

  return (
    <div className="group rounded-lg border border-border/50 bg-card/60 p-3 transition-colors hover:border-border/80">
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-medium text-foreground">{feature.title}</h4>
        {onConvert && (
          <button
            type="button"
            onClick={onConvert}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground/40 transition-colors hover:bg-primary/10 hover:text-primary group-hover:text-muted-foreground/70"
          >
            Convert to Task
            <ArrowRightIcon className="h-3 w-3" />
          </button>
        )}
      </div>
      {feature.description && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground/70 leading-relaxed">
          {feature.description}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {/* Priority */}
        <span
          className={cn(
            'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none',
            priority.className,
          )}
        >
          {priority.label}
        </span>
        {/* Effort */}
        <span
          className={cn(
            'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none',
            effort.className,
          )}
        >
          {effort.label}
        </span>
        {/* Status */}
        <span
          className={cn(
            'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none',
            status.className,
          )}
        >
          {status.label}
        </span>
      </div>
    </div>
  );
};

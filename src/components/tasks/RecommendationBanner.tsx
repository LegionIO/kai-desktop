/**
 * RecommendationBanner — displays Aithena's proactive recommendations for a task.
 *
 * Shows a collapsible summary bar with expandable recommendation cards.
 * Supports dismiss (X), apply (for next_action type), and auto-fading consumed indicators.
 */

import { type FC, useState, useEffect, useCallback, memo } from 'react';
import {
  ZapIcon,
  XIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  AlertTriangleIcon,
  ArrowRightIcon,
  BookOpenIcon,
  InfoIcon,
  ShieldAlertIcon,
  PlayIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTasks } from '@/providers/TaskProvider';
import type { Recommendation, ConsumedRecommendation } from '@/types/recommendation';

interface RecommendationBannerProps {
  taskId: string;
}

// ── Type Config ─────────────────────────────────────────────────────────────

const TYPE_CONFIG: Record<Recommendation['type'], {
  label: string;
  icon: FC<{ className?: string; size?: number }>;
  badgeColor: string;
  borderColor: string;
}> = {
  risk: {
    label: 'Risk',
    icon: AlertTriangleIcon,
    badgeColor: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    borderColor: 'border-l-amber-500/60',
  },
  escalation: {
    label: 'Escalation',
    icon: ShieldAlertIcon,
    badgeColor: 'bg-red-500/15 text-red-400 border-red-500/30',
    borderColor: 'border-l-red-500/60',
  },
  next_action: {
    label: 'Action',
    icon: ArrowRightIcon,
    badgeColor: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
    borderColor: 'border-l-sky-500/60',
  },
  context: {
    label: 'Context',
    icon: InfoIcon,
    badgeColor: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
    borderColor: 'border-l-slate-500/60',
  },
  learning: {
    label: 'Learning',
    icon: BookOpenIcon,
    badgeColor: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    borderColor: 'border-l-emerald-500/60',
  },
};

const CONFIDENCE_COLORS: Record<string, string> = {
  high: 'text-emerald-400',
  medium: 'text-amber-400',
  low: 'text-slate-400',
};

// ── Main Component ──────────────────────────────────────────────────────────

export const RecommendationBanner: FC<RecommendationBannerProps> = memo(({ taskId }) => {
  const { getRecommendations, getConsumedRecommendations, dismissRecommendation, applyRecommendation } = useTasks();

  const recommendations = getRecommendations(taskId);
  const consumed = getConsumedRecommendations(taskId);

  const [expanded, setExpanded] = useState(false);
  const [fadingConsumed, setFadingConsumed] = useState<Set<string>>(new Set());

  // Auto-expand on high-confidence risk or escalation
  useEffect(() => {
    const hasUrgent = recommendations.some(
      (r) => (r.type === 'risk' || r.type === 'escalation') && r.confidence === 'high',
    );
    if (hasUrgent && !expanded) {
      setExpanded(true);
    }
  }, [recommendations]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fade consumed items after 8 seconds
  useEffect(() => {
    if (consumed.length === 0) return;
    const latest = consumed[consumed.length - 1];
    if (!latest.timestamp || fadingConsumed.has(latest.id)) return;

    const timer = setTimeout(() => {
      setFadingConsumed((prev) => new Set(prev).add(latest.id));
    }, 8000);
    return () => clearTimeout(timer);
  }, [consumed, fadingConsumed]);

  // Filter out faded consumed items for display
  const visibleConsumed = consumed.filter((c) => !fadingConsumed.has(c.id)).slice(-3);

  const handleDismiss = useCallback((recId: string) => {
    dismissRecommendation(taskId, recId);
  }, [taskId, dismissRecommendation]);

  const handleApply = useCallback((rec: Recommendation) => {
    applyRecommendation(taskId, rec);
  }, [taskId, applyRecommendation]);

  // Don't render if nothing to show
  if (recommendations.length === 0 && visibleConsumed.length === 0) return null;

  return (
    <div className="mx-6 mt-2 animate-in fade-in slide-in-from-bottom-1 duration-200">
      {/* ─── Summary Bar ─── */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors',
          recommendations.some((r) => r.type === 'risk' || r.type === 'escalation')
            ? 'border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/10'
            : 'border-violet-500/15 bg-violet-500/5 hover:bg-violet-500/10',
        )}
      >
        <ZapIcon size={12} className="text-violet-400 flex-shrink-0" />
        <span className="text-[11px] text-muted-foreground flex-1">
          {recommendations.length} recommendation{recommendations.length !== 1 ? 's' : ''} from Aithena
          {recommendations.some((r) => r.type === 'risk' || r.type === 'escalation') && (
            <span className="ml-1.5 text-amber-400 font-medium">
              ({recommendations.filter((r) => r.type === 'risk' || r.type === 'escalation').length} alert{recommendations.filter((r) => r.type === 'risk' || r.type === 'escalation').length !== 1 ? 's' : ''})
            </span>
          )}
        </span>
        {expanded ? (
          <ChevronUpIcon size={12} className="text-muted-foreground/60" />
        ) : (
          <ChevronDownIcon size={12} className="text-muted-foreground/60" />
        )}
      </button>

      {/* ─── Expanded Cards ─── */}
      {expanded && (
        <div className="mt-2 space-y-1.5">
          {recommendations.map((rec) => (
            <RecommendationCard
              key={rec.id}
              recommendation={rec}
              onDismiss={handleDismiss}
              onApply={handleApply}
            />
          ))}
        </div>
      )}

      {/* ─── Consumed Indicators (mini, auto-fade) ─── */}
      {visibleConsumed.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {visibleConsumed.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-1.5 px-2 py-0.5 text-[10px] text-muted-foreground/60 animate-in fade-in"
            >
              <span className="opacity-60">
                {c.action === 'learned' && 'Learned'}
                {c.action === 'injected_context' && 'Injected'}
                {c.action === 'paused_execution' && 'Paused'}
                {c.action === 'suggested_action' && 'Applied'}
              </span>
              <span className="truncate">{c.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

RecommendationBanner.displayName = 'RecommendationBanner';

// ── Card Component ──────────────────────────────────────────────────────────

interface RecommendationCardProps {
  recommendation: Recommendation;
  onDismiss: (id: string) => void;
  onApply: (rec: Recommendation) => void;
}

const RecommendationCard: FC<RecommendationCardProps> = memo(({ recommendation, onDismiss, onApply }) => {
  const config = TYPE_CONFIG[recommendation.type];
  const Icon = config.icon;

  return (
    <div
      className={cn(
        'relative rounded-lg border border-border/40 bg-card/50 pl-3 pr-2 py-2 border-l-2',
        config.borderColor,
      )}
    >
      <div className="flex items-start gap-2">
        {/* Type badge */}
        <span className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium flex-shrink-0', config.badgeColor)}>
          <Icon size={10} />
          {config.label}
        </span>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-medium text-foreground/90 leading-tight">{recommendation.title}</p>
          {recommendation.rationale && (
            <p className="mt-0.5 text-[10px] text-muted-foreground leading-snug line-clamp-2">
              {recommendation.rationale}
            </p>
          )}
          {recommendation.suggested_action && recommendation.type === 'next_action' && (
            <p className="mt-1 text-[10px] text-sky-400/80 leading-snug">
              {recommendation.suggested_action}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Confidence indicator */}
          <span className={cn('text-[9px]', CONFIDENCE_COLORS[recommendation.confidence] ?? 'text-slate-400')}>
            {recommendation.confidence}
          </span>

          {/* Apply button (next_action only) */}
          {recommendation.type === 'next_action' && recommendation.suggested_action && (
            <button
              type="button"
              onClick={() => onApply(recommendation)}
              className="rounded-md bg-sky-500/10 border border-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-400 hover:bg-sky-500/20 transition-colors"
              title="Apply this suggestion"
            >
              <PlayIcon size={9} className="inline mr-0.5" />
              Apply
            </button>
          )}

          {/* Dismiss */}
          <button
            type="button"
            onClick={() => onDismiss(recommendation.id)}
            className="rounded-md p-0.5 text-muted-foreground/40 hover:text-muted-foreground/80 hover:bg-muted/30 transition-colors"
            title="Dismiss"
          >
            <XIcon size={11} />
          </button>
        </div>
      </div>
    </div>
  );
});

RecommendationCard.displayName = 'RecommendationCard';

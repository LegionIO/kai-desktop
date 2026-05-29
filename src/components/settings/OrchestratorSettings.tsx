/**
 * OrchestratorSettings — settings panel for the task dispatcher / orchestrator.
 *
 * Exposes the dispatcher knobs: enable, polling interval, max concurrency,
 * matching strategy, auto-start, and require-human-review. Wires directly
 * to the orchestrator IPC surface via useOrchestrator (not config.json),
 * so it's safe to render even when the surface isn't yet exposed — it just
 * shows a friendly fallback.
 */

import type { FC } from 'react';
import { useOrchestrator, type MatchingStrategy, type ReviewMode } from '@/hooks/useOrchestrator';
import { settingsSelectClass } from './shared';

const STRATEGY_OPTIONS: Array<{ value: MatchingStrategy; label: string; description: string }> = [
  {
    value: 'simple',
    label: 'Simple',
    description: 'Score each agent against the task using keyword overlap and role matching.',
  },
  {
    value: 'ai-scored',
    label: 'AI Scored',
    description: 'Use an AI model to score how well each agent fits the task.',
  },
];

interface OrchestratorSettingsProps {
  hideTitle?: boolean;
}

export const OrchestratorSettings: FC<OrchestratorSettingsProps> = ({ hideTitle }) => {
  const { state, available, loading, setConfig } = useOrchestrator();

  if (loading) {
    return (
      <div className="space-y-6">
        {!hideTitle && <h3 className="text-sm font-semibold">Orchestrator</h3>}
        <div className="rounded-lg border p-3 text-xs text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!available) {
    return (
      <div className="space-y-6">
        {!hideTitle && <h3 className="text-sm font-semibold">Orchestrator</h3>}
        <div className="rounded-lg border p-3 text-xs text-muted-foreground">
          Orchestrator is not available in this build of {__BRAND_PRODUCT_NAME}. Update to the latest version to enable
          automatic task dispatching.
        </div>
      </div>
    );
  }

  const cfg = state.config;

  return (
    <div className="space-y-6">
      {!hideTitle && <h3 className="text-sm font-semibold">Orchestrator</h3>}

      {/* Master enable */}
      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Dispatcher</legend>

        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-border/70 bg-card/80 px-3 py-2">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => void setConfig({ enabled: e.target.checked })}
            className="rounded"
          />
          <span className="text-xs">Enable orchestrator</span>
        </label>
        <p className="text-[10px] text-muted-foreground/80 pl-1">
          When on, {__BRAND_PRODUCT_NAME} watches the queue and assigns tasks to idle agents on its own. Decisions
          appear in the Activity log on the queue.
        </p>

        {/* Interval slider */}
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">
            Tick interval: every {Math.round(cfg.intervalMs / 1000)}s
          </label>
          <input
            type="range"
            className="w-full accent-[var(--color-primary)]"
            min={5000}
            max={300000}
            step={5000}
            value={cfg.intervalMs}
            onChange={(e) => void setConfig({ intervalMs: Number(e.target.value) })}
          />
          <div className="mt-0.5 flex justify-between text-[9px] text-muted-foreground/60">
            <span>5s</span>
            <span>5min</span>
          </div>
        </div>

        {/* Max concurrent */}
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">
            Max concurrent agents: {cfg.maxConcurrentAgents}
          </label>
          <input
            type="range"
            className="w-full accent-[var(--color-primary)]"
            min={1}
            max={10}
            step={1}
            value={cfg.maxConcurrentAgents}
            onChange={(e) => void setConfig({ maxConcurrentAgents: Number(e.target.value) })}
          />
          <div className="mt-0.5 flex justify-between text-[9px] text-muted-foreground/60">
            <span>1</span>
            <span>10</span>
          </div>
        </div>

        {/* Matching strategy */}
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Matching strategy</label>
          <select
            className={settingsSelectClass}
            value={cfg.matchingStrategy}
            onChange={(e) => void setConfig({ matchingStrategy: e.target.value as MatchingStrategy })}
          >
            {STRATEGY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <p className="mt-0.5 text-[10px] text-muted-foreground/70">
            {STRATEGY_OPTIONS.find((o) => o.value === cfg.matchingStrategy)?.description}
          </p>
        </div>
      </fieldset>

      {/* Behavior */}
      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Behavior</legend>

        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-border/70 bg-card/80 px-3 py-2">
          <input
            type="checkbox"
            checked={cfg.autoStart}
            onChange={(e) => void setConfig({ autoStart: e.target.checked })}
            className="rounded"
          />
          <span className="text-xs">Auto-start agents</span>
        </label>
        <p className="text-[10px] text-muted-foreground/80 pl-1">
          When on, the matched agent is launched immediately. Off means tasks get assigned but you still kick them off
          manually.
        </p>

        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-border/70 bg-card/80 px-3 py-2">
          <input
            type="checkbox"
            checked={cfg.requireHumanReview}
            onChange={(e) => void setConfig({ requireHumanReview: e.target.checked })}
            className="rounded"
          />
          <span className="text-xs">Require human review before completion</span>
        </label>
        <p className="text-[10px] text-muted-foreground/80 pl-1">
          Completed tasks land in <span className="font-medium">Human review</span> instead of going straight to{' '}
          <span className="font-medium">Done</span>.
        </p>
      </fieldset>

      {/* Review Policy */}
      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Review Policy</legend>

        {/* Min AI Reviewers */}
        <div>
          <label className="text-xs block mb-0.5">Minimum AI reviewers</label>
          <input
            type="number"
            className="w-20 rounded border border-border bg-card px-2 py-1 text-xs"
            min={0}
            max={5}
            value={cfg.reviewPolicy?.minReviewers ?? 2}
            onChange={(e) =>
              void setConfig({
                reviewPolicy: { ...cfg.reviewPolicy, minReviewers: Number(e.target.value) } as NonNullable<
                  typeof cfg.reviewPolicy
                >,
              })
            }
          />
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Number of AI reviewers orchestrator assigns to each task
          </p>
        </div>

        {/* Skip Human Review on Approval */}
        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-border/70 bg-card/80 px-3 py-2">
          <input
            type="checkbox"
            checked={cfg.reviewPolicy?.skipHumanReviewOnApproval ?? false}
            onChange={(e) =>
              void setConfig({
                reviewPolicy: { ...cfg.reviewPolicy, skipHumanReviewOnApproval: e.target.checked } as NonNullable<
                  typeof cfg.reviewPolicy
                >,
              })
            }
            className="rounded"
          />
          <span className="text-xs">Auto-complete when AI approves</span>
        </label>
        <p className="text-[11px] text-muted-foreground pl-1">Skip human review when all AI reviewers approve</p>

        {/* AI Can Require Human Review — only visible when skip is enabled */}
        {cfg.reviewPolicy?.skipHumanReviewOnApproval && (
          <>
            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-border/70 bg-card/80 px-3 py-2">
              <input
                type="checkbox"
                checked={cfg.reviewPolicy?.aiCanRequireHumanReview ?? false}
                onChange={(e) =>
                  void setConfig({
                    reviewPolicy: { ...cfg.reviewPolicy, aiCanRequireHumanReview: e.target.checked } as NonNullable<
                      typeof cfg.reviewPolicy
                    >,
                  })
                }
                className="rounded"
              />
              <span className="text-xs">AI can escalate to human</span>
            </label>
            <p className="text-[11px] text-muted-foreground pl-1">
              AI may still route complex or untestable work to human review
            </p>
          </>
        )}

        {/* Max Retries Before Escalation */}
        <div>
          <label className="text-xs block mb-0.5">Max retries before escalation</label>
          <input
            type="number"
            className="w-20 rounded border border-border bg-card px-2 py-1 text-xs"
            min={1}
            max={10}
            value={cfg.reviewPolicy?.maxRetriesBeforeEscalation ?? 3}
            onChange={(e) =>
              void setConfig({
                reviewPolicy: {
                  ...cfg.reviewPolicy,
                  maxRetriesBeforeEscalation: Number(e.target.value),
                } as NonNullable<typeof cfg.reviewPolicy>,
              })
            }
          />
          <p className="mt-0.5 text-[11px] text-muted-foreground">Failed attempts before escalating to human review</p>
        </div>

        {/* Default Review Mode */}
        <div>
          <label className="text-xs block mb-0.5">Review mode</label>
          <select
            className={settingsSelectClass}
            value={cfg.reviewPolicy?.defaultReviewMode ?? 'parallel'}
            onChange={(e) =>
              void setConfig({
                reviewPolicy: { ...cfg.reviewPolicy, defaultReviewMode: e.target.value as ReviewMode } as NonNullable<
                  typeof cfg.reviewPolicy
                >,
              })
            }
          >
            <option value="parallel">Parallel</option>
            <option value="sequential">Sequential</option>
          </select>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Parallel runs all reviewers at once; sequential stops on first rejection
          </p>
        </div>
      </fieldset>

      {/* Unblock Policy */}
      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Unblock Policy</legend>

        {/* Enable AI Unblock */}
        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-border/70 bg-card/80 px-3 py-2">
          <input
            type="checkbox"
            checked={cfg.unblockPolicy?.enabled ?? false}
            onChange={(e) =>
              void setConfig({
                unblockPolicy: { ...cfg.unblockPolicy, enabled: e.target.checked } as NonNullable<
                  typeof cfg.unblockPolicy
                >,
              })
            }
            className="rounded"
          />
          <span className="text-xs">AI unblock attempts</span>
        </label>
        <p className="text-[11px] text-muted-foreground pl-1">
          Orchestrator will try to resolve blocked tasks using AI analysis
        </p>

        {/* Max Attempts — only visible when enabled */}
        {cfg.unblockPolicy?.enabled && (
          <div>
            <label className="text-xs block mb-0.5">Max unblock attempts</label>
            <input
              type="number"
              className="w-20 rounded border border-border bg-card px-2 py-1 text-xs"
              min={1}
              max={5}
              value={cfg.unblockPolicy?.maxAttempts ?? 2}
              onChange={(e) =>
                void setConfig({
                  unblockPolicy: {
                    ...cfg.unblockPolicy,
                    enabled: true,
                    maxAttempts: Number(e.target.value),
                  } as NonNullable<typeof cfg.unblockPolicy>,
                })
              }
            />
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Maximum AI attempts to resolve a blocker before giving up
            </p>
          </div>
        )}
      </fieldset>
    </div>
  );
};

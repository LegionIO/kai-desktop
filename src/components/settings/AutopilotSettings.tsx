/**
 * AutopilotSettings — settings panel for the task dispatcher / autopilot.
 *
 * Exposes the dispatcher knobs: enable, polling interval, max concurrency,
 * matching strategy, auto-start, and require-human-review. Wires directly
 * to the orchestrator IPC surface via useOrchestrator (not config.json),
 * so it's safe to render even when the surface isn't yet exposed — it just
 * shows a friendly fallback.
 */

import type { FC } from 'react';
import { useOrchestrator, type MatchingStrategy } from '@/hooks/useOrchestrator';
import { settingsSelectClass } from './shared';

const STRATEGY_OPTIONS: Array<{ value: MatchingStrategy; label: string; description: string }> = [
  { value: 'best-fit', label: 'Best fit', description: 'Score each agent against the task and pick the highest match.' },
  { value: 'round-robin', label: 'Round-robin', description: 'Cycle through idle agents in order.' },
  { value: 'random', label: 'Random', description: 'Pick any idle agent at random.' },
];

interface AutopilotSettingsProps {
  hideTitle?: boolean;
}

export const AutopilotSettings: FC<AutopilotSettingsProps> = ({ hideTitle }) => {
  const { state, available, loading, setConfig } = useOrchestrator();

  if (loading) {
    return (
      <div className="space-y-6">
        {!hideTitle && <h3 className="text-sm font-semibold">Autopilot</h3>}
        <div className="rounded-lg border p-3 text-xs text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!available) {
    return (
      <div className="space-y-6">
        {!hideTitle && <h3 className="text-sm font-semibold">Autopilot</h3>}
        <div className="rounded-lg border p-3 text-xs text-muted-foreground">
          Autopilot is not available in this build of {__BRAND_PRODUCT_NAME}. Update to the latest
          version to enable automatic task dispatching.
        </div>
      </div>
    );
  }

  const cfg = state.config;

  return (
    <div className="space-y-6">
      {!hideTitle && <h3 className="text-sm font-semibold">Autopilot</h3>}

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
          <span className="text-xs">Enable autopilot</span>
        </label>
        <p className="text-[10px] text-muted-foreground/80 pl-1">
          When on, {__BRAND_PRODUCT_NAME} watches the queue and assigns tasks to idle agents on its
          own. Decisions appear in the Activity log on the queue.
        </p>

        {/* Interval slider */}
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">
            Tick interval: every {cfg.intervalSeconds}s
          </label>
          <input
            type="range"
            className="w-full accent-[var(--color-primary)]"
            min={5}
            max={300}
            step={5}
            value={cfg.intervalSeconds}
            onChange={(e) => void setConfig({ intervalSeconds: Number(e.target.value) })}
          />
          <div className="mt-0.5 flex justify-between text-[9px] text-muted-foreground/60">
            <span>5s</span>
            <span>5min</span>
          </div>
        </div>

        {/* Max concurrent */}
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">
            Max concurrent tasks: {cfg.maxConcurrent}
          </label>
          <input
            type="range"
            className="w-full accent-[var(--color-primary)]"
            min={1}
            max={10}
            step={1}
            value={cfg.maxConcurrent}
            onChange={(e) => void setConfig({ maxConcurrent: Number(e.target.value) })}
          />
          <div className="mt-0.5 flex justify-between text-[9px] text-muted-foreground/60">
            <span>1</span>
            <span>10</span>
          </div>
        </div>

        {/* Matching strategy */}
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">
            Matching strategy
          </label>
          <select
            className={settingsSelectClass}
            value={cfg.matchingStrategy}
            onChange={(e) => void setConfig({ matchingStrategy: e.target.value as MatchingStrategy })}
          >
            {STRATEGY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
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
          When on, the matched agent is launched immediately. Off means tasks get assigned but you
          still kick them off manually.
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
          Completed tasks land in <span className="font-medium">Human review</span> instead of going
          straight to <span className="font-medium">Done</span>.
        </p>
      </fieldset>
    </div>
  );
};

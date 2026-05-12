import { useState, useEffect, useCallback, type FC } from 'react';
import { settingsSelectClass, Toggle, NumberField, type SettingsProps } from './shared';
import { app } from '@/lib/ipc-client';

type RuntimeInfo = { id: string; name: string; available: boolean; reason?: string };

type AgentConfig = {
  runtime: string;
  maxTurns?: number;
  autoContinueOnMaxTurns?: boolean;
};

const BUILT_IN_RUNTIME_IDS = new Set(['mastra', 'claude-agent-sdk', 'codex-sdk']);

const RUNTIME_DESCRIPTIONS: Record<string, string> = {
  mastra: 'Built-in runtime with full Kai feature support (memory, observer, compaction, multi-provider models).',
  'claude-agent-sdk': 'Anthropic\'s Claude Code agent. Production-tested tool execution, native MCP support, session resume. Kai tools (skills, plan mode, ask_user, settings) available via MCP bridge.',
  'codex-sdk': 'OpenAI\'s Codex agent. Thread-based execution with session resume.',
};

/** Sort order: plugin runtimes always first (pinned), then available before offline, then by priority. */
const RUNTIME_PRIORITY: Record<string, number> = {
  'claude-agent-sdk': 1,
  'codex-sdk': 2,
  'mastra': 3,
};

function sortRuntimes(list: RuntimeInfo[]): RuntimeInfo[] {
  return [...list].sort((a, b) => {
    // Plugin runtimes (not built-in) are always pinned to the top
    const aIsPlugin = !BUILT_IN_RUNTIME_IDS.has(a.id);
    const bIsPlugin = !BUILT_IN_RUNTIME_IDS.has(b.id);
    if (aIsPlugin !== bIsPlugin) return aIsPlugin ? -1 : 1;
    // Within the same group: available before offline
    if (a.available !== b.available) return a.available ? -1 : 1;
    // Among built-ins of the same availability, sort by priority
    const pa = RUNTIME_PRIORITY[a.id] ?? 99;
    const pb = RUNTIME_PRIORITY[b.id] ?? 99;
    return pa - pb;
  });
}

export const RuntimeSettings: FC<SettingsProps & { embedded?: boolean }> = ({ config, updateConfig, embedded }) => {
  const agentConfig = (config.agent as AgentConfig | undefined) ?? { runtime: 'auto' };
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [activeRuntime, setActiveRuntime] = useState<string>('mastra');
  const [loading, setLoading] = useState(true);

  const fetchRuntimes = useCallback(async () => {
    try {
      const [available, active] = await Promise.all([
        app.agent.getAvailableRuntimes(),
        app.agent.getActiveRuntime(),
      ]);
      setRuntimes(available);
      setActiveRuntime(active);
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await fetchRuntimes();
      if (cancelled) return;
    })();
    return () => { cancelled = true; };
  }, [agentConfig.runtime, fetchRuntimes]);

  // Refetch when plugin UI state changes (e.g. a plugin registers/unregisters a runtime)
  useEffect(() => {
    if (!app.plugins?.onUIStateChanged) return;
    return app.plugins.onUIStateChanged(() => {
      void fetchRuntimes();
    });
  }, [fetchRuntimes]);

  const selectedRuntime = agentConfig.runtime;
  const sortedRuntimes = sortRuntimes(runtimes);

  return (
    <div className="space-y-6">
      {!embedded && (
        <div>
          <h3 className="text-sm font-semibold">Agent Runtime</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Choose which agent runtime powers conversations. Each runtime offers different capabilities and trade-offs.
          </p>
        </div>
      )}

      {/* Runtime selector */}
      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Runtime</legend>
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Agent runtime</label>
          <select
            className={settingsSelectClass}
            value={selectedRuntime}
            onChange={(e) => void updateConfig('agent.runtime', e.target.value)}
          >
            <option value="auto">Auto (prefer external runtime if available)</option>
            {/* Plugin-contributed runtimes appear first */}
            {runtimes
              .filter((r) => !BUILT_IN_RUNTIME_IDS.has(r.id))
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            <option value="claude-agent-sdk">Claude Code</option>
            <option value="codex-sdk">Codex</option>
            <option value="mastra">Mastra</option>
          </select>
        </div>

        {/* Runtime descriptions */}
        {selectedRuntime !== 'auto' && RUNTIME_DESCRIPTIONS[selectedRuntime] && (
          <p className="text-[10px] text-muted-foreground/80 italic">
            {RUNTIME_DESCRIPTIONS[selectedRuntime]}
          </p>
        )}
      </fieldset>

      {/* Availability */}
      {!loading && (
        <fieldset className="rounded-lg border p-3 space-y-3">
          <legend className="text-xs font-semibold px-1">Availability</legend>

          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">Active:</span>
            <span className="text-xs font-medium">
              {(runtimes.find((r) => r.id === activeRuntime) ?? runtimes.find((r) => r.name === activeRuntime))?.name ?? activeRuntime}
            </span>
          </div>

          {sortedRuntimes.length > 0 && (
            <div className="space-y-1.5">
              {sortedRuntimes.map((rt) => (
                <div
                  key={rt.id}
                  className="flex items-center gap-2 rounded-xl border border-border/60 bg-card/60 px-3 py-2"
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      rt.available ? 'bg-green-500' : 'bg-red-500'
                    }`}
                  />
                  <span className="text-xs font-medium flex-1">{rt.name}</span>
                  <span className={`text-[10px] ${rt.available ? 'text-muted-foreground' : 'text-red-500 dark:text-red-400'}`}>
                    {rt.available ? 'Available' : 'Unavailable'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </fieldset>
      )}

      {/* Turn Limits */}
      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Turn Limits</legend>
        <NumberField
          label="Max turns"
          value={agentConfig.maxTurns ?? 25}
          onChange={(v) => void updateConfig('agent.maxTurns', v > 0 ? v : undefined)}
          min={1}
          max={200}
        />
        <Toggle
          label="Auto-continue when max turns reached"
          checked={agentConfig.autoContinueOnMaxTurns ?? false}
          onChange={(v) => void updateConfig('agent.autoContinueOnMaxTurns', v)}
        />
        <p className="text-[10px] text-muted-foreground/80">
          When auto-continue is enabled, the agent will automatically resume after hitting the turn limit instead of prompting you.
        </p>
      </fieldset>
    </div>
  );
};

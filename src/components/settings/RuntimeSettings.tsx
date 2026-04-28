import { useState, useEffect, useCallback, type FC } from 'react';
import { settingsSelectClass, type SettingsProps } from './shared';
import { app } from '@/lib/ipc-client';

type RuntimeInfo = { id: string; name: string; available: boolean; reason?: string };

type AgentConfig = {
  runtime: 'auto' | 'mastra' | 'claude-agent-sdk' | 'codex-sdk';
};

const RUNTIME_DESCRIPTIONS: Record<string, string> = {
  mastra: 'Built-in runtime with full Kai feature support (memory, observer, compaction, multi-provider models).',
  'claude-agent-sdk': 'Anthropic\'s Claude Code agent. Production-tested tool execution, native MCP support, session resume.',
  'codex-sdk': 'OpenAI\'s Codex agent. Thread-based execution with session resume.',
};

/** Sort order: available first, then by priority (Claude > Codex > Mastra). */
const RUNTIME_PRIORITY: Record<string, number> = {
  'claude-agent-sdk': 0,
  'codex-sdk': 1,
  'mastra': 2,
};

function sortRuntimes(list: RuntimeInfo[]): RuntimeInfo[] {
  return [...list].sort((a, b) => {
    // Available runtimes sort before inactive ones
    if (a.available !== b.available) return a.available ? -1 : 1;
    // Within the same availability group, sort by priority
    const pa = RUNTIME_PRIORITY[a.id] ?? 99;
    const pb = RUNTIME_PRIORITY[b.id] ?? 99;
    return pa - pb;
  });
}

export const RuntimeSettings: FC<SettingsProps> = ({ config, updateConfig }) => {
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

  const selectedRuntime = agentConfig.runtime;
  const sortedRuntimes = sortRuntimes(runtimes);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Agent Runtime</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose which agent runtime powers conversations. Each runtime offers different capabilities and trade-offs.
        </p>
      </div>

      {/* Runtime selector */}
      <div>
        <label className="text-[10px] text-muted-foreground block mb-1">Runtime</label>
        <select
          className={settingsSelectClass}
          value={selectedRuntime}
          onChange={(e) => void updateConfig('agent.runtime', e.target.value)}
        >
          <option value="auto">Auto (prefer external runtime if available)</option>
          <option value="mastra">Mastra (built-in)</option>
          <option value="claude-agent-sdk">Claude Code</option>
          <option value="codex-sdk">Codex</option>
        </select>
      </div>

      {/* Active runtime indicator */}
      {!loading && (
        <div className="rounded-xl border border-border/60 bg-card/60 px-3 py-2">
          <span className="text-[10px] text-muted-foreground block mb-1">Active Runtime</span>
          <span className="text-xs font-medium">
            {runtimes.find((r) => r.id === activeRuntime)?.name ?? activeRuntime}
          </span>
        </div>
      )}

      {/* Availability table */}
      {!loading && sortedRuntimes.length > 0 && (
        <div>
          <span className="text-[10px] text-muted-foreground block mb-2">Runtimes</span>
          <div className="space-y-1.5">
            {sortedRuntimes.map((rt) => (
              <div
                key={rt.id}
                className="flex items-center gap-2 rounded-xl border border-border/60 bg-card/60 px-3 py-2"
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    rt.available ? 'bg-green-500' : 'bg-yellow-500'
                  }`}
                />
                <span className="text-xs font-medium flex-1">{rt.name}</span>
                <span className="text-[10px] text-muted-foreground">
                  {rt.available
                    ? 'Available'
                    : rt.reason
                      ? `Inactive — ${rt.reason}`
                      : 'Inactive'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Runtime descriptions */}
      {selectedRuntime !== 'auto' && RUNTIME_DESCRIPTIONS[selectedRuntime] && (
        <p className="text-xs text-muted-foreground/80 italic">
          {RUNTIME_DESCRIPTIONS[selectedRuntime]}
        </p>
      )}

      {/* Capability comparison */}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground transition-colors">
          Runtime Capability Comparison
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-[10px] border-collapse">
            <thead>
              <tr className="border-b border-border/40">
                <th className="text-left py-1 pr-3 font-medium text-muted-foreground">Feature</th>
                <th className="text-center py-1 px-2 font-medium">Mastra</th>
                <th className="text-center py-1 px-2 font-medium">Claude Code</th>
                <th className="text-center py-1 px-2 font-medium">Codex</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              {[
                ['Real-time streaming', true, true, false],
                ['Tool execution', true, true, true],
                ['MCP support', true, true, false],
                ['Custom tools', true, true, false],
                ['Memory layers', true, false, false],
                ['Context compaction', true, false, false],
                ['Tool observer', true, false, false],
                ['Sub-agents', true, true, false],
                ['Multi-provider', true, true, false],
                ['Model fallback', true, true, false],
                ['Session resume', false, true, true],
              ].map(([feature, mastra, claude, codex]) => (
                <tr key={feature as string} className="border-b border-border/20">
                  <td className="py-1 pr-3">{feature as string}</td>
                  <td className="text-center py-1 px-2">{mastra ? '✓' : '—'}</td>
                  <td className="text-center py-1 px-2">{claude ? '✓' : '—'}</td>
                  <td className="text-center py-1 px-2">{codex ? '✓' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
};

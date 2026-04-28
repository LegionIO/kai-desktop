import { useState, useEffect, type FC } from 'react';
import { settingsSelectClass, NumberField, type SettingsProps } from './shared';
import { app } from '@/lib/ipc-client';

type RuntimeInfo = { id: string; name: string; available: boolean };

type AgentConfig = {
  runtime: 'auto' | 'mastra' | 'claude-agent-sdk' | 'codex-sdk';
  claudeAgentSdk?: {
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
    maxTurns?: number;
    thinking?: { type: 'adaptive' } | { type: 'disabled' } | { type: 'enabled'; budgetTokens: number };
    persistSession?: boolean;
  };
  codexSdk?: {
    approval?: 'suggest' | 'auto-edit' | 'full-auto';
  };
};

const RUNTIME_DESCRIPTIONS: Record<string, string> = {
  mastra: 'Built-in runtime with full Kai feature support (memory, observer, compaction, multi-provider models).',
  'claude-agent-sdk': 'Anthropic\'s official agent SDK. Production-tested tool execution, native MCP support, session resume.',
  'codex-sdk': 'OpenAI\'s Codex CLI SDK. Thread-based execution with session resume.',
};

export const RuntimeSettings: FC<SettingsProps> = ({ config, updateConfig }) => {
  const agentConfig = (config.agent as AgentConfig | undefined) ?? { runtime: 'auto' };
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [activeRuntime, setActiveRuntime] = useState<string>('mastra');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [available, active] = await Promise.all([
          app.agent.getAvailableRuntimes(),
          app.agent.getActiveRuntime(),
        ]);
        if (!cancelled) {
          setRuntimes(available);
          setActiveRuntime(active);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [agentConfig.runtime]);

  const selectedRuntime = agentConfig.runtime;

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
          <option value="auto">Auto (prefer external SDK if available)</option>
          <option value="mastra">Mastra (built-in)</option>
          <option value="claude-agent-sdk">Claude Agent SDK</option>
          <option value="codex-sdk">Codex SDK</option>
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
      {!loading && runtimes.length > 0 && (
        <div>
          <span className="text-[10px] text-muted-foreground block mb-2">Installed Runtimes</span>
          <div className="space-y-1.5">
            {runtimes.map((rt) => (
              <div
                key={rt.id}
                className="flex items-center gap-2 rounded-xl border border-border/60 bg-card/60 px-3 py-2"
              >
                <span
                  className={`h-2 w-2 rounded-full ${rt.available ? 'bg-green-500' : 'bg-red-400'}`}
                />
                <span className="text-xs font-medium flex-1">{rt.name}</span>
                <span className="text-[10px] text-muted-foreground">
                  {rt.available ? 'Available' : 'Not installed'}
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

      {/* Claude Agent SDK options */}
      {(selectedRuntime === 'claude-agent-sdk' || selectedRuntime === 'auto') && (
        <div className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-3">
          <h4 className="text-xs font-semibold">Claude Agent SDK Options</h4>

          <div>
            <label className="text-[10px] text-muted-foreground block mb-1">Permission Mode</label>
            <select
              className={settingsSelectClass}
              value={agentConfig.claudeAgentSdk?.permissionMode ?? 'default'}
              onChange={(e) => void updateConfig('agent.claudeAgentSdk.permissionMode', e.target.value)}
            >
              <option value="default">Default (ask for approval)</option>
              <option value="acceptEdits">Accept Edits (auto-approve file writes)</option>
              <option value="bypassPermissions">Bypass Permissions (full auto)</option>
            </select>
          </div>

          <NumberField
            label="Max Turns"
            value={agentConfig.claudeAgentSdk?.maxTurns ?? 25}
            onChange={(v) => void updateConfig('agent.claudeAgentSdk.maxTurns', v)}
            min={1}
            max={100}
          />

          <div>
            <label className="text-[10px] text-muted-foreground block mb-1">Thinking Mode</label>
            <select
              className={settingsSelectClass}
              value={agentConfig.claudeAgentSdk?.thinking?.type ?? 'adaptive'}
              onChange={(e) => {
                const type = e.target.value;
                if (type === 'enabled') {
                  void updateConfig('agent.claudeAgentSdk.thinking', { type: 'enabled', budgetTokens: 10000 });
                } else {
                  void updateConfig('agent.claudeAgentSdk.thinking', { type });
                }
              }}
            >
              <option value="adaptive">Adaptive</option>
              <option value="enabled">Enabled (with budget)</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>

          {agentConfig.claudeAgentSdk?.thinking?.type === 'enabled' && (
            <NumberField
              label="Thinking Budget (tokens)"
              value={(agentConfig.claudeAgentSdk.thinking as { budgetTokens: number }).budgetTokens ?? 10000}
              onChange={(v) => void updateConfig('agent.claudeAgentSdk.thinking', { type: 'enabled', budgetTokens: v })}
              min={1000}
              max={100000}
            />
          )}
        </div>
      )}

      {/* Codex SDK options */}
      {selectedRuntime === 'codex-sdk' && (
        <div className="space-y-3 rounded-xl border border-border/60 bg-card/40 p-3">
          <h4 className="text-xs font-semibold">Codex SDK Options</h4>

          <div>
            <label className="text-[10px] text-muted-foreground block mb-1">Approval Mode</label>
            <select
              className={settingsSelectClass}
              value={agentConfig.codexSdk?.approval ?? 'suggest'}
              onChange={(e) => void updateConfig('agent.codexSdk.approval', e.target.value)}
            >
              <option value="suggest">Suggest (ask before changes)</option>
              <option value="auto-edit">Auto Edit (auto-approve edits)</option>
              <option value="full-auto">Full Auto (no approvals)</option>
            </select>
          </div>
        </div>
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
                <th className="text-center py-1 px-2 font-medium">Claude SDK</th>
                <th className="text-center py-1 px-2 font-medium">Codex SDK</th>
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

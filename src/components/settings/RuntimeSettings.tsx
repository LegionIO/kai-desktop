import { useState, useEffect, useCallback, type FC } from 'react';
import { settingsSelectClass, Toggle, NumberField, TextField, type SettingsProps } from './shared';
import { app } from '@/lib/ipc-client';

type RuntimeInfo = { id: string; name: string; available: boolean; reason?: string; description?: string };

type ConfinementConfig = {
  enabled?: boolean;
  workspaceOnly?: boolean;
  scrubCredentials?: boolean;
  envAllowlist?: string[];
  root?: string;
};

type AgentConfig = {
  runtime: string;
  maxTurns?: number;
  autoContinueOnMaxTurns?: boolean;
  confinement?: ConfinementConfig;
};

/** Parse a comma/whitespace/newline-separated allowlist into a deduped, trimmed list. */
export function parseEnvAllowlist(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[\s,]+/)) {
    const name = token.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Heuristic match for env-var names that likely carry a secret. Used only to
 * surface a non-blocking warning in the confinement allowlist editor — the
 * operator may still legitimately need one (e.g. a proxy that reads a token),
 * so this never rejects, it just flags. Mirrors the backend scrub denylist
 * intent in confinement.ts.
 */
export function looksLikeSecretEnvName(name: string): boolean {
  return /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|PRIVATE|SESSION|AUTH|API[_-]?KEY)(?:$|_)|AWS_SECRET|AWS_SESSION|ANTHROPIC|OPENAI|GEMINI|GH_TOKEN|GITHUB_TOKEN/i.test(
    name,
  );
}

const RUNTIME_DESCRIPTIONS: Record<string, string> = {
  mastra: 'Built-in runtime with full Kai feature support (memory, observer, compaction, multi-provider models).',
  'claude-agent-sdk':
    "Anthropic's Claude Code agent. Production-tested tool execution, native MCP support, session resume. Kai tools (skills, plan mode, ask_user, settings) available via MCP bridge.",
  'codex-sdk': "OpenAI's Codex agent. Thread-based execution with session resume.",
  pi: 'Fast coding agent (its own bash, read/write/edit, grep). Note: pi cannot use Kai skills, plugins, or custom/MCP tools — only its own built-in tools. It has no per-call approval in headless mode; the Approval setting maps to spawn-time tool exclusions (read-only / no-shell / full). Custom-endpoint models are not supported.',
};

/** Sort order: available before offline, then by priority. */
const RUNTIME_PRIORITY: Record<string, number> = {
  'claude-agent-sdk': 1,
  'codex-sdk': 2,
  pi: 3,
  mastra: 4,
};

function sortRuntimes(list: RuntimeInfo[]): RuntimeInfo[] {
  return [...list].sort((a, b) => {
    // Available before offline
    if (a.available !== b.available) return a.available ? -1 : 1;
    // Sort by priority
    const pa = RUNTIME_PRIORITY[a.id] ?? 99;
    const pb = RUNTIME_PRIORITY[b.id] ?? 99;
    return pa - pb;
  });
}

export const RuntimeSettings: FC<SettingsProps & { embedded?: boolean }> = ({ config, updateConfig, embedded }) => {
  const agentConfig = (config.agent as AgentConfig | undefined) ?? { runtime: 'auto' };
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRuntimes = useCallback(async () => {
    try {
      const available = await app.agent.getAvailableRuntimes();
      setRuntimes(available);
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
    return () => {
      cancelled = true;
    };
  }, [agentConfig.runtime, fetchRuntimes]);

  const selectedRuntime = agentConfig.runtime;
  const sortedRuntimes = sortRuntimes(runtimes);
  const confinement = agentConfig.confinement ?? {};
  const confinementEnabled = confinement.enabled ?? false;
  const workspaceOnly = confinement.workspaceOnly ?? true;
  const scrubCredentials = confinement.scrubCredentials ?? true;
  const envAllowlist = confinement.envAllowlist ?? [];
  const relaxed = confinementEnabled && (!workspaceOnly || !scrubCredentials);
  const riskyEnvNames = envAllowlist.filter(looksLikeSecretEnvName);

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
        <div data-setting-id="agent.runtime">
          <label className="text-[10px] text-muted-foreground block mb-0.5">Agent runtime</label>
          <select
            className={settingsSelectClass}
            value={selectedRuntime}
            onChange={(e) => void updateConfig('agent.runtime', e.target.value)}
          >
            <option value="auto">Auto (prefer external runtime if available)</option>
            <option value="claude-agent-sdk">Claude Code</option>
            <option value="codex-sdk">Codex</option>
            <option value="pi">Pi</option>
            <option value="mastra">Mastra</option>
          </select>
        </div>

        {/* Runtime descriptions */}
        {selectedRuntime !== 'auto' &&
          (() => {
            const desc = RUNTIME_DESCRIPTIONS[selectedRuntime];
            return desc ? <p className="text-[10px] text-muted-foreground/80 italic">{desc}</p> : null;
          })()}
      </fieldset>

      {/* Availability */}
      {!loading && (
        <fieldset className="rounded-lg border p-3 space-y-3">
          <legend className="text-xs font-semibold px-1">Availability</legend>

          {sortedRuntimes.length > 0 && (
            <div className="space-y-1.5">
              {sortedRuntimes.map((rt) => (
                <div
                  key={rt.id}
                  className="flex items-center gap-2 rounded-xl border border-border/60 bg-card/60 px-3 py-2"
                >
                  <span className={`h-2 w-2 rounded-full ${rt.available ? 'bg-green-500' : 'bg-red-500'}`} />
                  <span className="text-xs font-medium flex-1">{rt.name}</span>
                  <span
                    className={`text-[10px] ${rt.available ? 'text-muted-foreground' : 'text-red-500 dark:text-red-400'}`}
                  >
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
          id="agent.maxTurns"
          label="Max turns"
          value={agentConfig.maxTurns ?? 25}
          onChange={(v) => void updateConfig('agent.maxTurns', v > 0 ? v : undefined)}
          min={1}
          max={200}
        />
        <p className="text-[10px] text-muted-foreground/80">
          Applies to all runtimes. Editing this always sets the effective cap; when unset, each runtime falls back to
          its own default (Mastra uses Advanced › Max steps).
        </p>
        <Toggle
          id="agent.autoContinueOnMaxTurns"
          label="Auto-continue when max turns reached"
          checked={agentConfig.autoContinueOnMaxTurns ?? false}
          onChange={(v) => void updateConfig('agent.autoContinueOnMaxTurns', v)}
        />
        <p className="text-[10px] text-muted-foreground/80">
          When auto-continue is enabled, the agent will automatically resume after hitting the turn limit instead of
          prompting you.
        </p>
      </fieldset>

      {/* Confinement (#66/#77): blast-radius containment for autonomous runtimes */}
      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Confinement</legend>
        <p className="text-[10px] text-muted-foreground/80">
          Contain the blast radius of runtimes that execute untrusted tool calls (Claude Code, Codex, pi). When on,
          agents run with a scrubbed environment and are refused a working directory in your home, root, or any
          credential-bearing folder. Off by default — no effect until you enable it.
        </p>
        <Toggle
          id="agent.confinement.enabled"
          label="Enable confinement enforcement"
          checked={confinementEnabled}
          onChange={(v) => void updateConfig('agent.confinement.enabled', v)}
        />

        {confinementEnabled && (
          <div className="space-y-3 border-l-2 border-border/50 pl-3">
            <Toggle
              id="agent.confinement.workspaceOnly"
              label="Restrict working directory to the workspace"
              checked={workspaceOnly}
              onChange={(v) => void updateConfig('agent.confinement.workspaceOnly', v)}
            />
            <Toggle
              id="agent.confinement.scrubCredentials"
              label="Scrub credentials from the agent environment"
              checked={scrubCredentials}
              onChange={(v) => void updateConfig('agent.confinement.scrubCredentials', v)}
            />
            {relaxed && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-600 dark:text-amber-400">
                ⚠️ Confinement is enabled but a core protection is turned off
                {!workspaceOnly && !scrubCredentials
                  ? ' (working-directory restriction and credential scrubbing)'
                  : !workspaceOnly
                    ? ' (working-directory restriction)'
                    : ' (credential scrubbing)'}
                . Agents that execute untrusted tool calls can then reach{' '}
                {!workspaceOnly && !scrubCredentials
                  ? 'your credentials and directories outside the workspace'
                  : !workspaceOnly
                    ? 'directories outside the workspace, including your home folder'
                    : 'credentials from the parent environment'}
                . Only relax this if you understand the risk.
              </p>
            )}
            <TextField
              id="agent.confinement.envAllowlist"
              label="Environment allowlist"
              value={envAllowlist.join(', ')}
              onChange={(raw) => void updateConfig('agent.confinement.envAllowlist', parseEnvAllowlist(raw))}
              placeholder="GIT_SSH_COMMAND, HTTPS_PROXY"
              mono
              hint="Extra environment variables to pass through to confined runtimes, on top of the built-in safe set. Comma- or space-separated."
            />
            {riskyEnvNames.length > 0 && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-600 dark:text-amber-400">
                ⚠️ These allowlisted names look like they carry a secret and will pass their value from your environment
                into confined agents, undoing the scrub for them:{' '}
                <span className="font-mono">{riskyEnvNames.join(', ')}</span>. Remove any you did not intend.
              </p>
            )}
          </div>
        )}
      </fieldset>
    </div>
  );
};

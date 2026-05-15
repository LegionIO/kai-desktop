import { useState, type FC } from 'react';
import { Toggle, TextField, type SettingsProps } from './shared';
import { app } from '@/lib/ipc-client';

type AithenaConfig = {
  enabled: boolean;
  gatewayUrl: string;
  apiKey: string;
  timeoutMs?: number;
  compileTimeoutMs?: number;
};

export const AithenaSettings: FC<SettingsProps> = ({ config, updateConfig }) => {
  const aithena = (config.aithena as AithenaConfig | undefined) ?? {
    enabled: false,
    gatewayUrl: '',
    apiKey: '',
  };

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await app.aithena.health();
      if (result.ok) {
        const stats = await app.aithena.stats();
        const tierSummary = Array.isArray(stats)
          ? stats.map((t: { tier: string; total_count: number }) => `${t.tier}: ${t.total_count}`).join(', ')
          : '';
        setTestResult({
          ok: true,
          message: `Connected (v${result.version ?? '?'})${tierSummary ? ` | ${tierSummary}` : ''}`,
        });
      } else {
        setTestResult({ ok: false, message: result.error ?? 'Connection failed' });
      }
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Unknown error' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Aithena Memory</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Connect to Aithena's cognitive memory system for persistent context, learning, recall, and workflow intelligence.
        </p>
      </div>

      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Connection</legend>

        <Toggle
          label="Enable Aithena Memory"
          checked={aithena.enabled}
          onChange={(v) => updateConfig('aithena.enabled', v)}
        />

        {aithena.enabled && (
          <>
            <TextField
              label="Gateway URL"
              value={aithena.gatewayUrl}
              onChange={(v) => updateConfig('aithena.gatewayUrl', v)}
              placeholder="https://aithena-stg.optum.com"
              mono
              hint="The Aithena API base URL"
            />

            <div>
              <label className="text-[10px] text-muted-foreground block mb-0.5">API Key</label>
              <input
                type="password"
                className="w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs outline-none font-mono"
                value={aithena.apiKey}
                onChange={(e) => updateConfig('aithena.apiKey', e.target.value)}
                placeholder="Your Aithena API key"
              />
              <span className="text-[10px] text-muted-foreground/60 mt-0.5 block">
                Stored locally in your settings file
              </span>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={handleTest}
                disabled={testing || !aithena.gatewayUrl || !aithena.apiKey}
                className="rounded-xl bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {testing ? 'Testing...' : 'Test Connection'}
              </button>

              {testResult && (
                <span className={`text-xs ${testResult.ok ? 'text-green-500' : 'text-red-500'}`}>
                  {testResult.ok ? '✓' : '✗'} {testResult.message}
                </span>
              )}
            </div>
          </>
        )}
      </fieldset>
    </div>
  );
};

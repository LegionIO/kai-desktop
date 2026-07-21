import { useCallback, useEffect, useState, type FC } from 'react';
import {
  ActivityIcon,
  AlertTriangleIcon,
  PauseIcon,
  PlayIcon,
  PowerIcon,
  PowerOffIcon,
  RefreshCwIcon,
  Trash2Icon,
  XCircleIcon,
} from 'lucide-react';
import { app } from '@/lib/ipc-client';
import type { SettingsProps } from './shared';
import { CollapsibleSection } from './shared';

type Summary = Awaited<ReturnType<typeof app.diagnostics.getSummary>>;
type PluginList = Awaited<ReturnType<typeof app.plugins.list>>;

/** Warn once the main-process log crosses this size — the same cap the writer rotates at. */
const LOG_WARN_BYTES = 25 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Diagnostics — surfaces process health so an error storm (the class of
 * bug that once pinned the event loop via an EPIPE self-loop and grew the log
 * to hundreds of MB) is visible and attributable to the offending plugin,
 * rather than only discoverable by manually inspecting ~/.kai/logs.
 */
export const DiagnosticsSettings: FC<SettingsProps> = () => {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [plugins, setPlugins] = useState<PluginList>([]);
  const [tail, setTail] = useState<{ text: string; sizeBytes: number; truncated: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pluginControlBusy, setPluginControlBusy] = useState<string | null>(null);
  const [pluginControlError, setPluginControlError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, pluginList] = await Promise.all([app.diagnostics.getSummary(), app.plugins.list()]);
      setSummary(s);
      setPlugins(pluginList);
    } catch {
      /* ignore — desktop-only surface */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const loadTail = useCallback(async () => {
    try {
      setTail(await app.diagnostics.tailLog());
    } catch {
      setTail(null);
    }
  }, []);

  const clearLog = useCallback(async () => {
    setBusy(true);
    try {
      await app.diagnostics.clearLog();
      await refresh();
      setTail(null);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const resetCounters = useCallback(async () => {
    setBusy(true);
    try {
      await app.diagnostics.resetCounters();
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const controlPlugin = useCallback(
    async (pluginName: string, action: 'pause' | 'resume' | 'kill' | 'disable' | 'enable') => {
      setPluginControlBusy(`${pluginName}:${action}`);
      setPluginControlError(null);
      try {
        if (action === 'pause') await app.plugins.pause(pluginName);
        else if (action === 'resume') await app.plugins.resume(pluginName);
        else if (action === 'kill') await app.plugins.kill(pluginName);
        else if (action === 'disable') await app.plugins.disable(pluginName, { persist: true });
        else await app.plugins.enable(pluginName);
        await refresh();
      } catch (error) {
        setPluginControlError(error instanceof Error ? error.message : String(error));
      } finally {
        setPluginControlBusy(null);
      }
    },
    [refresh],
  );

  const logOversized = (summary?.logSizeBytes ?? 0) > LOG_WARN_BYTES;
  const hasErrors = (summary?.totalErrors ?? 0) > 0;
  const processByPlugin = new Map((summary?.pluginProcesses ?? []).map((process) => [process.pluginName, process]));
  const pluginRows = plugins.map((plugin) => ({ plugin, process: processByPlugin.get(plugin.name) }));

  return (
    <div className="space-y-6">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ActivityIcon className="h-4 w-4" />
          Diagnostics
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Each plugin backend runs in its own utility process. CPU, memory, crashes, and unhandled errors are attributed
          to the owning plugin instead of being hidden inside the main app process.
        </p>
      </div>

      {/* Health summary card */}
      <div className="rounded-xl border border-border/70 bg-card/60 p-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Log size</div>
            <div className={`mt-0.5 text-sm font-medium ${logOversized ? 'text-amber-500' : ''}`}>
              {summary ? formatBytes(summary.logSizeBytes) : '—'}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Errors since boot</div>
            <div className={`mt-0.5 text-sm font-medium ${hasErrors ? 'text-amber-500' : ''}`}>
              {summary?.totalErrors ?? '—'}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Session start</div>
            <div className="mt-0.5 text-sm font-medium">{summary ? formatTs(summary.sinceBoot) : '—'}</div>
          </div>
        </div>

        {logOversized && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              The main-process log is unusually large. This usually means an error storm — check the table below to see
              which plugin is responsible, then clear the log.
            </span>
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card/80 px-2.5 py-1.5 text-xs hover:bg-accent"
          >
            <RefreshCwIcon className="h-3.5 w-3.5" />
            Refresh
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void resetCounters()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card/80 px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
          >
            Reset counters
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void clearLog()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/50 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive hover:bg-destructive/20 disabled:opacity-50"
          >
            <Trash2Icon className="h-3.5 w-3.5" />
            Clear log
          </button>
        </div>
      </div>

      {/* True per-plugin process resource attribution */}
      <div>
        <h4 className="text-xs font-semibold text-muted-foreground">Plugin process resources</h4>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Pause uses OS process suspension and stops plugin CPU work. Kill terminates only that plugin; disable also
          tears down its registrations and persists the disabled state.
        </p>
        {pluginControlError && (
          <div className="mt-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {pluginControlError}
          </div>
        )}
        {summary && pluginRows.length > 0 ? (
          <div className="mt-2 overflow-x-auto rounded-xl border border-border/70">
            <table className="min-w-[760px] w-full text-xs">
              <thead className="bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Plugin</th>
                  <th className="px-3 py-2 text-right font-medium">PID</th>
                  <th className="px-3 py-2 text-right font-medium">CPU</th>
                  <th className="px-3 py-2 text-right font-medium">Memory</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Controls</th>
                </tr>
              </thead>
              <tbody>
                {pluginRows.map(({ plugin, process }) => {
                  const rowBusy = pluginControlBusy?.startsWith(`${plugin.name}:`) ?? false;
                  const canTerminate =
                    process?.status === 'starting' || process?.status === 'running' || process?.status === 'paused';
                  return (
                    <tr key={plugin.name} className="border-t border-border/50 align-top">
                      <td className="px-3 py-2">
                        <span className="font-medium">{plugin.displayName}</span>
                        <div className="text-[11px] text-muted-foreground">{plugin.name}</div>
                        {process?.lastError && process.status === 'crashed' && (
                          <div className="mt-0.5 line-clamp-2 text-destructive">{process.lastError}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{process?.pid ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {process ? (
                          <>
                            <div>{process.cpuPercent.toFixed(1)}%</div>
                            {process.cumulativeCpuSeconds !== null && (
                              <div className="text-[10px] text-muted-foreground">
                                {process.cumulativeCpuSeconds.toFixed(1)}s total
                              </div>
                            )}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {process ? (
                          <>
                            <div>{formatBytes(process.privateMemoryBytes || process.residentSetBytes)}</div>
                            <div className="text-[10px] text-muted-foreground">
                              {process.memorySource === 'private' ? 'private footprint' : 'working set'}
                            </div>
                            {process.privateMemoryBytes > 0 && process.residentSetBytes > 0 && (
                              <div className="text-[10px] text-muted-foreground">
                                RSS {formatBytes(process.residentSetBytes)}
                              </div>
                            )}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className={process?.status === 'crashed' ? 'text-destructive' : 'text-muted-foreground'}>
                          {process?.status ?? plugin.state}
                          {process && process.crashCount > 0
                            ? ` (${process.crashCount} crash${process.crashCount === 1 ? '' : 'es'})`
                            : ''}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {process?.status === 'running' && (
                            <button
                              type="button"
                              disabled={rowBusy || !process.canPause}
                              title={
                                process.canPause ? 'Pause plugin process' : 'Pause is unavailable on this platform'
                              }
                              onClick={() => void controlPlugin(plugin.name, 'pause')}
                              className="inline-flex items-center gap-1 rounded border border-border/70 px-2 py-1 hover:bg-accent disabled:opacity-40"
                            >
                              <PauseIcon className="h-3 w-3" /> Pause
                            </button>
                          )}
                          {process?.status === 'paused' && (
                            <button
                              type="button"
                              disabled={rowBusy}
                              onClick={() => void controlPlugin(plugin.name, 'resume')}
                              className="inline-flex items-center gap-1 rounded border border-border/70 px-2 py-1 hover:bg-accent disabled:opacity-40"
                            >
                              <PlayIcon className="h-3 w-3" /> Resume
                            </button>
                          )}
                          {canTerminate && (
                            <button
                              type="button"
                              disabled={rowBusy}
                              onClick={() => void controlPlugin(plugin.name, 'kill')}
                              className="inline-flex items-center gap-1 rounded border border-destructive/50 px-2 py-1 text-destructive hover:bg-destructive/10 disabled:opacity-40"
                            >
                              <XCircleIcon className="h-3 w-3" /> Kill
                            </button>
                          )}
                          {plugin.state === 'disabled' ? (
                            <button
                              type="button"
                              disabled={rowBusy}
                              onClick={() => void controlPlugin(plugin.name, 'enable')}
                              className="inline-flex items-center gap-1 rounded border border-border/70 px-2 py-1 hover:bg-accent disabled:opacity-40"
                            >
                              <PowerIcon className="h-3 w-3" /> Enable
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={rowBusy || plugin.brandRequired}
                              title={plugin.brandRequired ? 'Required plugins cannot be disabled' : 'Disable plugin'}
                              onClick={() => void controlPlugin(plugin.name, 'disable')}
                              className="inline-flex items-center gap-1 rounded border border-border/70 px-2 py-1 hover:bg-accent disabled:opacity-40"
                            >
                              <PowerOffIcon className="h-3 w-3" /> Disable
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">No plugin backend processes are currently running.</p>
        )}
      </div>

      {/* Per-plugin / per-kind error table */}
      <div>
        <h4 className="text-xs font-semibold text-muted-foreground">Unhandled errors by source</h4>
        {summary && summary.counters.length > 0 ? (
          <div className="mt-2 overflow-hidden rounded-xl border border-border/70">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 text-right font-medium">Count</th>
                  <th className="px-3 py-2 font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {summary.counters.map((c) => (
                  <tr key={c.key} className="border-t border-border/50 align-top">
                    <td className="px-3 py-2">
                      <span className="font-medium">{c.plugin ?? 'core / app'}</span>
                      {c.sample && <div className="mt-0.5 line-clamp-2 text-muted-foreground">{c.sample}</div>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{c.kind}</td>
                    <td className={`px-3 py-2 text-right font-medium ${c.count > 100 ? 'text-amber-500' : ''}`}>
                      {c.count}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatTs(c.lastTs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">No unhandled errors recorded this session. ✅</p>
        )}
      </div>

      {/* Raw log tail */}
      <CollapsibleSection id="diagnostics-log-tail" title="Main-process log (tail)" defaultOpen={false}>
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => void loadTail()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card/80 px-2.5 py-1.5 text-xs hover:bg-accent"
          >
            <RefreshCwIcon className="h-3.5 w-3.5" />
            Load latest
          </button>
          {tail && (
            <>
              {tail.truncated && (
                <p className="text-[11px] text-muted-foreground">
                  Showing the last {formatBytes(tail.text.length)} of {formatBytes(tail.sizeBytes)}.
                </p>
              )}
              <pre className="max-h-96 overflow-auto rounded-lg border border-border/70 bg-black/80 p-3 text-[11px] leading-relaxed text-green-300">
                {tail.text || '(empty)'}
              </pre>
            </>
          )}
        </div>
      </CollapsibleSection>
    </div>
  );
};

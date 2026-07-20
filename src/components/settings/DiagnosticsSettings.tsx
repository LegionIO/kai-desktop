import { useCallback, useEffect, useState, type FC } from 'react';
import { AlertTriangleIcon, RefreshCwIcon, Trash2Icon, ActivityIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';
import type { SettingsProps } from './shared';
import { CollapsibleSection } from './shared';

type Summary = Awaited<ReturnType<typeof app.diagnostics.getSummary>>;

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
 * Diagnostics — surfaces main-process health so an error storm (the class of
 * bug that once pinned the event loop via an EPIPE self-loop and grew the log
 * to hundreds of MB) is visible and attributable to the offending plugin,
 * rather than only discoverable by manually inspecting ~/.kai/logs.
 */
export const DiagnosticsSettings: FC<SettingsProps> = () => {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [tail, setTail] = useState<{ text: string; sizeBytes: number; truncated: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await app.diagnostics.getSummary();
      setSummary(s);
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

  const logOversized = (summary?.logSizeBytes ?? 0) > LOG_WARN_BYTES;
  const hasErrors = (summary?.totalErrors ?? 0) > 0;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ActivityIcon className="h-4 w-4" />
          Diagnostics
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Main-process health. Unhandled errors are counted here and attributed to the originating plugin, so a runaway
          plugin or error storm is visible instead of silently pinning the app.
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

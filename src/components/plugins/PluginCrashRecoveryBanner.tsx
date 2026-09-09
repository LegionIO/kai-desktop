import { useEffect, useState, type FC } from 'react';
import { AlertTriangleIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';

/**
 * Crash-recovery banner. When the window-health monitor force-reloads a wedged
 * renderer, the plugin utility processes may already be dead. Main attempts to
 * auto-reload them (see PluginManager.reconcileAfterRendererReload); anything that
 * couldn't come back is reported here so the user isn't left with silently-missing
 * plugins and no explanation. Distinct from PluginRestartBanner, which fires for
 * deliberate post-update / post-consent restart bookkeeping.
 */
export const PluginCrashRecoveryBanner: FC = () => {
  const [degraded, setDegraded] = useState<string[]>([]);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    if (typeof app.plugins.getDegradedPlugins !== 'function') return;
    app.plugins
      .getDegradedPlugins()
      .then(setDegraded)
      .catch(() => {});
    return app.plugins.onDegradedChanged?.(({ plugins }) => setDegraded(plugins));
  }, []);

  if (degraded.length === 0) return null;

  const canRestart = typeof app.plugins.restartApp === 'function';
  const handleRestart = () => {
    if (!canRestart) return;
    setRestarting(true);
    app.plugins.restartApp().catch(() => setRestarting(false));
  };

  return (
    <div className="relative z-40 mx-4 mt-14 flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 md:mt-16">
      <AlertTriangleIcon className="h-4 w-4 shrink-0 text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-amber-400">
          {degraded.length === 1
            ? `“${degraded[0]}” stopped running after a recovery and needs a restart to reload`
            : `${degraded.length} plugins stopped running after a recovery`}
        </p>
        <p className="text-[10px] text-amber-400/70">
          Kai recovered its window but some plugins didn&apos;t come back. Restart to reload them.
        </p>
      </div>
      {canRestart && (
        <button
          type="button"
          onClick={handleRestart}
          disabled={restarting}
          className="titlebar-no-drag shrink-0 rounded-lg border border-amber-500/40 bg-amber-500/20 px-3 py-1.5 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/30 disabled:opacity-50"
        >
          {restarting ? 'Restarting…' : 'Restart Kai'}
        </button>
      )}
    </div>
  );
};

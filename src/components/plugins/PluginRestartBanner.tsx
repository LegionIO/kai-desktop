import { useEffect, useState, type FC } from 'react';
import { RotateCcwIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';

export const PluginRestartBanner: FC = () => {
  const [pending, setPending] = useState<string[]>([]);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    if (typeof app.plugins.getPendingRestart !== 'function') return;
    app.plugins
      .getPendingRestart()
      .then(setPending)
      .catch(() => {});
    return app.plugins.onPendingRestartChanged?.(({ plugins }) => setPending(plugins));
  }, []);

  if (pending.length === 0) return null;

  const canRestart = typeof app.plugins.restartApp === 'function';
  const handleRestart = () => {
    if (!canRestart) return;
    setRestarting(true);
    app.plugins.restartApp().catch(() => setRestarting(false));
  };

  return (
    <div className="flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
      <RotateCcwIcon className="h-4 w-4 shrink-0 text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-amber-400">
          {pending.length === 1
            ? `Restart required to finish applying changes to ${pending[0]}`
            : `Restart required to finish applying changes to ${pending.length} plugins`}
        </p>
        <p className="text-[10px] text-amber-400/70">
          Some plugin changes won&apos;t be fully applied until the app restarts.
        </p>
      </div>
      {canRestart && (
        <button
          type="button"
          onClick={handleRestart}
          disabled={restarting}
          className="shrink-0 rounded-lg border border-amber-500/40 bg-amber-500/20 px-3 py-1.5 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/30 disabled:opacity-50"
        >
          {restarting ? 'Restarting…' : 'Restart now'}
        </button>
      )}
    </div>
  );
};

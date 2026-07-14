import { useEffect, useState, type FC } from 'react';
import { BellIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';
import type { Alert } from '@/lib/ipc-client';
import { AlertCard } from './AlertCard';
import { useAlerts } from './useAlerts';

/**
 * The Alerts tab: a list of open alerts (questions/approvals/FYIs raised by
 * headless automation runs). The index entries are lightweight (no body/
 * questions), so we hydrate each open alert via alerts:get to render its
 * answer UI. The list reacts live to alerts:changed.
 */
export const AlertsView: FC = () => {
  const { open } = useAlerts();
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(open.map((e) => app.alerts.get(e.id)))
      .then((full) => {
        if (cancelled) return;
        setAlerts(full.filter((a): a is Alert => !!a && a.status === 'open'));
      })
      .catch(() => {
        if (!cancelled) setAlerts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/50 px-5 py-3">
        <BellIcon className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Alerts</h2>
        {alerts.length > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {alerts.length}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {alerts.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
            <BellIcon className="mb-2 h-8 w-8 opacity-30" />
            <p>No open alerts.</p>
            <p className="mt-1 max-w-xs text-xs text-muted-foreground/70">
              When an automation needs your input or flags something, it shows up here.
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-xl flex-col gap-3">
            {alerts.map((a) => (
              <AlertCard key={a.id} alert={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

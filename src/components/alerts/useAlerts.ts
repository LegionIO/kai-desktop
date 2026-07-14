import { useCallback, useEffect, useState } from 'react';
import { app } from '@/lib/ipc-client';
import type { AlertIndexEntry } from '@/lib/ipc-client';

/**
 * Live view of open alerts + unread count. Subscribes to `alerts:changed` so the
 * tab badge, list, and modal host all react the moment an automation raises or a
 * user resolves an alert.
 */
export function useAlerts(): { open: AlertIndexEntry[]; unread: number; refresh: () => void } {
  const [open, setOpen] = useState<AlertIndexEntry[]>([]);
  const [unread, setUnread] = useState(0);

  const refresh = useCallback(() => {
    void app.alerts
      .list(true)
      .then((list) => setOpen(list ?? []))
      .catch(() => setOpen([]));
    void app.alerts
      .unreadCount()
      .then((n) => setUnread(n ?? 0))
      .catch(() => setUnread(0));
  }, []);

  useEffect(() => {
    refresh();
    const off = app.alerts.onChanged(() => refresh());
    return off;
  }, [refresh]);

  return { open, unread, refresh };
}

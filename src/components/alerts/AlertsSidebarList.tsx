import { useEffect, useState, type FC } from 'react';
import { BellIcon, InfoIcon, ShieldQuestionIcon } from 'lucide-react';
import type { AlertKind } from '@/lib/ipc-client';
import { useAlerts } from './useAlerts';

const KIND_ICON: Record<AlertKind, FC<{ className?: string }>> = {
  question: ShieldQuestionIcon,
  approval: BellIcon,
  fyi: InfoIcon,
};
const KIND_TINT: Record<AlertKind, string> = {
  question: 'text-amber-500',
  approval: 'text-rose-500',
  fyi: 'text-sky-500',
};

/** Relative "3m ago" style timestamp, coarse. */
function ago(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Compact sidebar list of open alerts. Clicking one scrolls the main Alerts view
 * to it (best-effort via a hash the view honors). Live via useAlerts.
 */
export const AlertsSidebarList: FC<{ onSelect?: () => void }> = ({ onSelect }) => {
  const { open } = useAlerts();
  const [now, setNow] = useState(Date.now());

  // Re-render every minute so the relative times stay fresh.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);
  void now;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Open alerts {open.length > 0 && `(${open.length})`}
      </div>
      {open.length === 0 ? (
        <div className="px-2 py-6 text-center text-xs text-muted-foreground/70">Nothing needs your attention.</div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {open.map((a) => {
            const Icon = KIND_ICON[a.kind];
            return (
              <button
                key={a.id}
                type="button"
                onClick={onSelect}
                className="flex items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/60"
              >
                <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${KIND_TINT[a.kind]}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">{a.title}</div>
                  <div className="text-[10px] text-muted-foreground/60">{ago(a.createdAt)}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

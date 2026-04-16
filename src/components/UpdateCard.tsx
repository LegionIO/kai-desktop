import { useState, useEffect, useRef, type FC } from 'react';
import { DownloadIcon, XIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';

export const UpdateCard: FC = () => {
  const [status, setStatus] = useState<{ state: string; version?: string }>({ state: 'idle' });
  const [dismissed, setDismissed] = useState(false);
  const [visible, setVisible] = useState(false);
  const didAnimate = useRef(false);

  useEffect(() => {
    if (!window.app?.autoUpdate?.onStatus) return;
    const cleanup = app.autoUpdate.onStatus(setStatus);
    return cleanup;
  }, []);

  // Trigger fade-in animation when update is downloaded
  useEffect(() => {
    if (status.state === 'downloaded' && !dismissed && !didAnimate.current) {
      didAnimate.current = true;
      requestAnimationFrame(() => setVisible(true));
    }
  }, [status.state, dismissed]);

  if (status.state !== 'downloaded' || dismissed) return null;

  return (
    <div
      className={`shrink-0 border-t border-sidebar-border/80 px-3 py-2.5 transition-all duration-300 ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'
      }`}
    >
      <div className="flex items-start gap-2">
        <DownloadIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-sidebar-foreground">Update ready</p>
          <p className="text-[10px] text-muted-foreground">
            v{status.version ?? 'new'} &middot; Restart to apply
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          title="Dismiss"
        >
          <XIcon className="h-3 w-3" />
        </button>
      </div>
      <button
        type="button"
        onClick={() => app.autoUpdate.install()}
        className="mt-2 w-full rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        Restart to update
      </button>
    </div>
  );
};

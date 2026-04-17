import { useState, useEffect, useRef, type FC } from 'react';
import { DownloadIcon, LoaderIcon, XIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';

interface UpdateStatus {
  state: string;
  version?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}

export const UpdateCard: FC = () => {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' });
  const [dismissed, setDismissed] = useState(false);
  const [visible, setVisible] = useState(false);
  const didAnimate = useRef(false);

  useEffect(() => {
    if (!window.app?.autoUpdate?.onStatus) return;
    const cleanup = app.autoUpdate.onStatus(setStatus);
    return cleanup;
  }, []);

  // Trigger fade-in animation when card first becomes relevant
  useEffect(() => {
    const showable = status.state === 'downloading' || status.state === 'downloaded' || status.state === 'restarting';
    if (showable && !dismissed && !didAnimate.current) {
      didAnimate.current = true;
      requestAnimationFrame(() => setVisible(true));
    }
  }, [status.state, dismissed]);

  // Reset dismissed when a new download starts (e.g. user dismissed but new version appears)
  useEffect(() => {
    if (status.state === 'downloading' && dismissed) {
      setDismissed(false);
    }
  }, [status.state, dismissed]);

  const showable = status.state === 'downloading' || status.state === 'downloaded' || status.state === 'restarting';
  if (!showable || dismissed) return null;

  const percent = Math.round(status.percent ?? 0);

  return (
    <div
      className={`shrink-0 border-t border-sidebar-border/80 px-3 py-2.5 transition-all duration-300 ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'
      }`}
    >
      <div className="flex items-start gap-2">
        {status.state === 'restarting' ? (
          <LoaderIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <DownloadIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-sidebar-foreground">
            {status.state === 'downloading'
              ? 'Downloading update'
              : status.state === 'restarting'
                ? 'Restarting…'
                : 'Update ready'}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {status.state === 'downloading'
              ? `v${status.version ?? '…'} · ${percent}%`
              : status.state === 'restarting'
                ? `Installing v${status.version ?? 'new'}`
                : `v${status.version ?? 'new'} · Restart to apply`}
          </p>
        </div>
        {status.state !== 'restarting' && (
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            title="Dismiss"
          >
            <XIcon className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Progress bar for downloading state */}
      {status.state === 'downloading' && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      {/* Install button for downloaded state */}
      {status.state === 'downloaded' && (
        <button
          type="button"
          onClick={() => app.autoUpdate.install()}
          className="mt-2 w-full rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Restart to update
        </button>
      )}
    </div>
  );
};

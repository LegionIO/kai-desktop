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
      className={`fixed bottom-24 right-6 z-50 w-[min(90vw,400px)] rounded-2xl border border-border/70 bg-popover/95 p-6 shadow-2xl backdrop-blur-xl transition-all duration-300 ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
      }`}
    >
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-muted/40">
          {status.state === 'restarting' ? (
            <LoaderIcon className="h-5 w-5 animate-spin text-primary" />
          ) : (
            <DownloadIcon className="h-5 w-5 text-primary" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-foreground">
            {status.state === 'downloading'
              ? 'Downloading update'
              : status.state === 'restarting'
                ? 'Restarting…'
                : 'Update available'}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {status.state === 'downloading'
              ? `A new version of ${__BRAND_PRODUCT_NAME} (${status.version ?? '…'}) is being downloaded.`
              : status.state === 'restarting'
                ? `Installing version ${status.version ?? 'new'}, please wait...`
                : `A new version of ${__BRAND_PRODUCT_NAME} (${status.version ?? 'new'}) is now available to install.`}
          </p>
        </div>
        {status.state !== 'restarting' && (
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            title="Dismiss"
          >
            <XIcon className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Progress bar for downloading state */}
      {status.state === 'downloading' && (
        <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      {/* Action buttons for downloaded state */}
      {status.state === 'downloaded' && (
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={() => app.autoUpdate.install()}
            className="flex-1 rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background transition-colors hover:bg-foreground/90"
          >
            Install and restart
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="rounded-lg px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50"
          >
            Not yet
          </button>
        </div>
      )}
    </div>
  );
};

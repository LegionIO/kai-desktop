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
  mode?: 'full' | 'differential';
  fullSize?: number;
}

const fmtMB = (n?: number) => (n == null ? '…' : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * Human-readable time-remaining from bytes left and current throughput.
 * Returns null when it can't be estimated (no/zero speed, or nothing left),
 * so the caller can simply omit the ETA rather than show a bogus "0s".
 */
const fmtEta = (transferred?: number, total?: number, bytesPerSecond?: number): string | null => {
  if (!bytesPerSecond || bytesPerSecond <= 0 || total == null || transferred == null) return null;
  const remaining = total - transferred;
  if (remaining <= 0) return null;
  const secs = Math.ceil(remaining / bytesPerSecond);
  if (secs < 60) return `${secs}s left`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return rem ? `${mins}m ${rem}s left` : `${mins}m left`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m left`;
};

/** Test-only export of the pure ETA formatter. */
export const __test__ = { fmtEta };

export const UpdateCard: FC = () => {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' });
  const [dismissed, setDismissed] = useState(false);
  const [visible, setVisible] = useState(false);
  const didAnimate = useRef(false);
  // Drag offset applied on top of the fixed bottom-right anchor. The card stays
  // anchored (bottom-24 right-6); dragging just translates it from there so a
  // user can move it off content it's covering.
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  useEffect(() => {
    if (!window.app?.autoUpdate?.onStatus) return;
    const cleanup = app.autoUpdate.onStatus(setStatus);
    return cleanup;
  }, []);

  // Trigger fade-in animation when card first becomes relevant
  useEffect(() => {
    const showable =
      status.state === 'available' ||
      status.state === 'downloading' ||
      status.state === 'downloaded' ||
      status.state === 'restarting' ||
      status.state === 'preparing';
    if (showable && !dismissed && !didAnimate.current) {
      didAnimate.current = true;
      requestAnimationFrame(() => setVisible(true));
    }
  }, [status.state, dismissed]);

  // Reset dismissed when a new update is found (e.g. user dismissed but new version appears)
  useEffect(() => {
    if ((status.state === 'available' || status.state === 'downloading') && dismissed) {
      setDismissed(false);
    }
  }, [status.state, dismissed]);

  const showable =
    status.state === 'available' ||
    status.state === 'downloading' ||
    status.state === 'downloaded' ||
    status.state === 'restarting' ||
    status.state === 'preparing';
  if (!showable || dismissed) return null;

  const percent = Math.round(status.percent ?? 0);
  const eta = fmtEta(status.transferred, status.total, status.bytesPerSecond);

  // Pointer-based drag from the header. Uses pointer capture so the drag keeps
  // tracking even if the cursor leaves the card. Translating up/left is
  // negative, matching the bottom-right CSS anchor.
  const onDragPointerDown = (e: React.PointerEvent) => {
    // Don't start a drag from an interactive control inside the header.
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: drag.x, baseY: drag.y };
  };
  const onDragPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setDrag({ x: d.baseX + (e.clientX - d.startX), y: d.baseY + (e.clientY - d.startY) });
  };
  const onDragPointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  return (
    <div
      className={`fixed bottom-24 right-6 z-50 w-[min(90vw,400px)] rounded-2xl border border-border/70 bg-popover/95 p-6 shadow-2xl backdrop-blur-xl transition-opacity duration-300 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
      style={{
        // Fade-in nudge (8px, matching the old translate-y-2) plus the live
        // drag offset. Skip the transition while actively dragging so the card
        // tracks the pointer 1:1.
        transform: `translate(${drag.x}px, ${drag.y + (visible ? 0 : 8)}px)`,
        transition: dragRef.current ? 'none' : undefined,
      }}
    >
      <div className="flex items-start gap-4">
        <div
          className="flex min-w-0 flex-1 items-start gap-4 cursor-grab active:cursor-grabbing select-none"
          onPointerDown={onDragPointerDown}
          onPointerMove={onDragPointerMove}
          onPointerUp={onDragPointerUp}
          onPointerCancel={onDragPointerUp}
        >
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-muted/40">
            {status.state === 'restarting' || status.state === 'preparing' ? (
              <LoaderIcon className="h-5 w-5 animate-spin text-primary" />
            ) : (
              <DownloadIcon className="h-5 w-5 text-primary" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-foreground">
                {status.state === 'available'
                  ? 'Update found'
                  : status.state === 'downloading'
                    ? 'Downloading update'
                    : status.state === 'preparing'
                      ? 'Preparing update…'
                      : status.state === 'restarting'
                        ? 'Restarting…'
                        : status.state === 'downloaded'
                          ? 'Update ready'
                          : 'Update available'}
              </h3>
              {status.state === 'downloading' && status.mode && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    status.mode === 'differential'
                      ? 'bg-emerald-500/15 text-emerald-500'
                      : 'bg-amber-500/15 text-amber-600'
                  }`}
                >
                  {status.mode === 'differential' ? 'delta' : 'full'}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {status.state === 'available'
                ? `A new version of ${__BRAND_PRODUCT_NAME} (${status.version ?? 'new'}) was found. Starting download…`
                : status.state === 'downloading'
                  ? `A new version of ${__BRAND_PRODUCT_NAME} (${status.version ?? '…'}) is being downloaded.`
                  : status.state === 'preparing'
                    ? 'Preparing for update, please wait…'
                    : status.state === 'restarting'
                      ? `Installing version ${status.version ?? 'new'}, please wait...`
                      : `A new version of ${__BRAND_PRODUCT_NAME} (${status.version ?? 'new'}) is now available to install.`}
            </p>
          </div>
        </div>
        {status.state !== 'restarting' && status.state !== 'preparing' && (
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
        <>
          <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-muted-foreground">
            <span>
              {fmtMB(status.transferred)} / {fmtMB(status.total)}
              {status.mode === 'differential' && status.fullSize ? ` of ${fmtMB(status.fullSize)}` : ''}
            </span>
            <span>
              {eta ? eta : ''}
              {eta && status.bytesPerSecond ? ' · ' : ''}
              {status.bytesPerSecond ? `${fmtMB(status.bytesPerSecond)}/s` : ''}
            </span>
          </div>
        </>
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

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
  /** Present on a 'downloaded' status that follows a declined install; surfaced
   *  inline so a web client (which sees no host dialog) learns why (R29P1). */
  error?: string;
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
  const [installError, setInstallError] = useState<string | null>(null);
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

  // A FRESH install attempt begins with a 'preparing' broadcast (including a
  // same-version retry started from the app menu). Clear any stale error from a
  // prior attempt so the card doesn't show an old failure that the new attempt
  // hasn't reproduced (R28P14). The version-keyed reset below only fires on a
  // version CHANGE, so it misses a same-version retry — hence this separate hook.
  useEffect(() => {
    if (status.state === 'preparing') setInstallError(null);
  }, [status.state]);

  // Surface a decline reason carried on a 'downloaded' status (R29P1): a web
  // client's detached install invoke only gets a started-ack, so the reason a
  // block/failure produced arrives here on the status broadcast instead. Also
  // un-dismiss the card (R33P1): if the user dismissed it and started the install
  // from the app menu, an async failure arrives ONLY via this status — recording
  // the error while the card stays hidden would make the failure silent.
  useEffect(() => {
    if (status.state === 'downloaded' && status.error) {
      setInstallError(status.error);
      setDismissed(false);
    }
  }, [status.state, status.error]);

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

  // Reset dismissed only when a genuinely NEW version appears — not on every
  // 'available'/'downloading' tick. 'available' is sticky (re-emitted on each
  // poll for the same version), so keying off state alone would un-dismiss the
  // card the user just closed for the same update. Track the version we last
  // reset for and only clear the dismissal when it actually changes.
  const lastResetVersion = useRef<string | null>(null);
  useEffect(() => {
    // Include 'downloaded': once an update is already downloaded, the main process
    // suppresses 'available'/'downloading' broadcasts for a subsequent version and
    // transitions straight to 'downloaded'. Keying only off those earlier states
    // would miss the version change and leave a prior version's error visible
    // (R20P1).
    if (status.state !== 'available' && status.state !== 'downloading' && status.state !== 'downloaded') return;
    const version = status.version ?? null;
    if (version === lastResetVersion.current) return; // same update we've already accounted for
    // A version we haven't seen before: record it, and clear any prior dismissal
    // (that dismissal was for the previous version).
    lastResetVersion.current = version;
    if (dismissed) setDismissed(false);
    // Clear any install error from a PRIOR version's failed attempt — otherwise
    // the reopened card would show the old error before the user tries the new
    // version (R19P1). BUT do NOT clear it when the CURRENT status itself carries
    // an error (e.g. the first status observed after a renderer reload is a
    // failure): that would erase the only failure reason we'll get (R33P1). The
    // error-mirroring effect above sets it in that case.
    if (!status.error) setInstallError(null);
  }, [status.state, status.version, status.error, dismissed]);

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
            onClick={() => {
              // The primary failure surface for a broken pre-update hook is a
              // native dialog raised in the main process. But if the IPC handler
              // itself returns { ok: false } (e.g. no download staged after a
              // relaunch) or the channel rejects, there is NO native dialog — so
              // surface it inline here, otherwise the button looks dead.
              setInstallError(null);
              void app.autoUpdate
                .install()
                .then((res) => {
                  // `surfaced` means the main process already showed a native
                  // dialog for this outcome (a deliberate plugin veto) — don't
                  // also render an inline error, that would be a duplicate.
                  if (!res.ok && !res.surfaced) {
                    console.warn('[UpdateCard] install rejected:', res.error);
                    setInstallError(res.error || 'The update could not be started. Please try again.');
                  }
                })
                .catch((err) => {
                  console.warn('[UpdateCard] install invoke failed:', err);
                  setInstallError('The update could not be started. Please try again.');
                });
            }}
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

      {status.state === 'downloaded' && installError && (
        <p className="mt-3 text-sm text-red-500" role="alert">
          {installError}
        </p>
      )}
    </div>
  );
};

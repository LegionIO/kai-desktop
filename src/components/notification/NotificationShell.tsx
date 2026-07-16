import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FC, type ReactNode } from 'react';
import { LoaderIcon, XIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';
import type { Alert, AlertQuestion } from '@/lib/ipc-client';
import { AlertCard } from '@/components/alerts/AlertCard';
import { AlertQuestionPicker } from '@/components/alerts/AlertQuestionPicker';

/**
 * The dedicated pop-out window's root. Renders ANY notification-tab item:
 *  - tool-approval + ask_user  → the question form (AlertQuestionPicker),
 *    answered via agent.answerToolQuestion (resolves the awaiting turn).
 *  - tool-approval + other     → generic Approve / Reject.
 *  - alert                     → AlertCard (question/approval/fyi), answered via
 *    the alerts channels (re-injects a new turn).
 *
 * Chrome: a draggable header + an ✕ that just CLOSES the window (does not answer
 * — the item stays open in the Alerts tab / inline card to answer later). The
 * body reports its natural height (ResizeObserver) so the window sizes to fit.
 * Receives the item over notification.onRequest AND pulls it via notification.get
 * on mount (push can race the not-yet-mounted subscription).
 */

type ToolApprovalItem = {
  source: 'tool-approval';
  id: string;
  conversationId: string;
  toolName: string;
  args?: unknown;
};
type AlertItem = { source: 'alert'; id: string; alert: Alert };
type NotificationItem = ToolApprovalItem | AlertItem;

/** Window frame: draggable header + ✕ (close only) + a measured body. */
const NotificationChrome: FC<{ title: string; onClose: () => void; children: ReactNode }> = ({
  title,
  onClose,
  children,
}) => {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Report the natural content height to the main process so the window sizes to
  // fit (no dead space, no clipped buttons). Runs whenever the content resizes —
  // driven by the renderer, so it never races the initial layout.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const report = () => {
      // header (36) + body scrollHeight = full window content height.
      app.notification.reportSize(36 + el.scrollHeight);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  });

  return (
    <div id="notif-root" className="flex w-screen flex-col bg-card text-foreground">
      <div
        className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 px-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="truncate">{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close (answer later)"
          title="Close — answer later in the Alerts tab / chat"
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <XIcon className="h-3 w-3" />
        </button>
      </div>
      <div ref={bodyRef} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {children}
      </div>
    </div>
  );
};

export const NotificationShell: FC<{ id: string }> = ({ id }) => {
  const [item, setItem] = useState<NotificationItem | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const off = app.notification.onRequest((raw) => {
      const it = raw as NotificationItem;
      if (it && it.id === id) setItem(it);
    });
    let cancelled = false;
    void app.notification.get(id).then((raw) => {
      const it = raw as NotificationItem | null;
      if (!cancelled && it && it.id === id) setItem(it);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [id]);

  const close = useCallback(() => app.notification.close(id), [id]);

  if (!item) {
    return (
      <NotificationChrome title="Loading…" onClose={close}>
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <LoaderIcon className="h-4 w-4 animate-spin" />
        </div>
      </NotificationChrome>
    );
  }

  // ── Automation alert → the same card the notifications tab uses ──
  if (item.source === 'alert') {
    const kindLabel = item.alert.kind === 'approval' ? 'Approval' : item.alert.kind === 'fyi' ? 'FYI' : 'Question';
    return (
      <NotificationChrome title={kindLabel} onClose={close}>
        <div className="p-3">
          <AlertCard alert={item.alert} onResolved={close} />
        </div>
      </NotificationChrome>
    );
  }

  // ── Interactive tool approval ──
  const questions =
    item.toolName === 'ask_user' && item.args && typeof item.args === 'object'
      ? ((item.args as { questions?: AlertQuestion[] }).questions ?? null)
      : null;

  if (questions && questions.length > 0) {
    const onSubmit = async (answers: Record<string, string>) => {
      if (submitting) return;
      setSubmitting(true);
      try {
        await app.agent.answerToolQuestion(item.id, answers);
      } catch {
        /* main-side resolve is idempotent; close regardless */
      }
      close();
    };
    return (
      <NotificationChrome title="Question" onClose={close}>
        <div className="p-4">
          <AlertQuestionPicker questions={questions} onSubmit={onSubmit} submitting={submitting} />
        </div>
      </NotificationChrome>
    );
  }

  // Generic approve/reject (e.g. exit_plan_mode).
  const reason =
    item.args && typeof item.args === 'object' && !Array.isArray(item.args)
      ? (item.args as { reason?: unknown }).reason
      : undefined;
  const prompt =
    typeof reason === 'string' && reason.trim() ? reason.trim() : 'This action requires your approval to continue.';

  const resolve = async (decision: 'approve' | 'reject') => {
    if (submitting) return;
    setSubmitting(true);
    try {
      if (decision === 'approve') await app.agent.approveToolCall(item.id);
      else await app.agent.rejectToolCall(item.id);
    } catch {
      /* idempotent */
    }
    close();
  };

  return (
    <NotificationChrome title="Approval required" onClose={close}>
      <div className="space-y-3 p-5">
        <div className="text-sm font-medium">{item.toolName}</div>
        <p className="text-sm text-muted-foreground">{prompt}</p>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            disabled={submitting}
            onClick={() => resolve('reject')}
            className="rounded-lg border border-border/70 bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
          >
            Reject
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => resolve('approve')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting && <LoaderIcon className="h-3.5 w-3.5 animate-spin" />}
            {submitting ? 'Approving…' : 'Approve'}
          </button>
        </div>
      </div>
    </NotificationChrome>
  );
};

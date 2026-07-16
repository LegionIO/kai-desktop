import { useEffect, useState, type FC } from 'react';
import { LoaderIcon } from 'lucide-react';
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
 * After answering, closes its own window (app.notification.close).
 *
 * Receives the item over `notification.onRequest` (main re-sends on mount).
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

export const NotificationShell: FC<{ id: string }> = ({ id }) => {
  const [item, setItem] = useState<NotificationItem | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    return app.notification.onRequest((raw) => {
      const it = raw as NotificationItem;
      if (it && it.id === id) setItem(it);
    });
  }, [id]);

  const close = () => app.notification.close(id);

  if (!item) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-card text-muted-foreground">
        <LoaderIcon className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  // ── Automation alert → the same card the notifications tab uses ──
  if (item.source === 'alert') {
    return (
      <div className="h-screen w-screen overflow-y-auto bg-card p-3 text-foreground">
        <AlertCard alert={item.alert} onResolved={close} />
      </div>
    );
  }

  // ── Interactive tool approval ──
  // ask_user carries `questions` — render the same picker as the inline card.
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
      <div className="flex h-screen w-screen flex-col bg-card text-foreground">
        <div className="border-b border-border/70 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Question
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <AlertQuestionPicker questions={questions} onSubmit={onSubmit} submitting={submitting} />
        </div>
      </div>
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
    <div className="flex h-screen w-screen flex-col bg-card text-foreground">
      <div className="flex-1 space-y-3 p-5">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Approval required</div>
        <div className="text-sm font-medium">{item.toolName}</div>
        <p className="text-sm text-muted-foreground">{prompt}</p>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border/70 p-4">
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
  );
};

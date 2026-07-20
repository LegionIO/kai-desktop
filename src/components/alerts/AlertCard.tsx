import { useCallback, useState, type FC } from 'react';
import { BellIcon, InfoIcon, ShieldQuestionIcon, CheckIcon, XIcon, MessageSquareIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';
import type { Alert } from '@/lib/ipc-client';
import { AlertQuestionPicker } from './AlertQuestionPicker';

const KIND_META: Record<Alert['kind'], { label: string; icon: FC<{ className?: string }>; tint: string }> = {
  question: { label: 'Question', icon: ShieldQuestionIcon, tint: 'text-amber-500' },
  approval: { label: 'Approval', icon: BellIcon, tint: 'text-rose-500' },
  fyi: { label: 'FYI', icon: InfoIcon, tint: 'text-sky-500' },
};

/**
 * One Alert, rendered per kind:
 *  - fyi      → body + Dismiss.
 *  - question → the multi-tab option picker (answer resumes the thread).
 *  - approval → body + Approve / Deny (decision resumes the thread).
 * Actions call the alerts IPC; on success the parent list drops the alert via
 * the alerts:changed broadcast, so we just show a transient busy state.
 */
const STATUS_LABEL: Partial<Record<Alert['status'], string>> = {
  answered: 'Answered',
  acknowledged: 'Acknowledged',
  dismissed: 'Dismissed',
};

export const AlertCard: FC<{
  alert: Alert;
  onResolved?: () => void;
  /** Deep-link: open the conversation this alert was raised in. */
  onOpenConversation?: (conversationId: string) => void;
  /** History rendering: suppress live action controls, show a resolution badge. */
  readOnly?: boolean;
}> = ({ alert, onResolved, onOpenConversation, readOnly = false }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const meta = KIND_META[alert.kind];
  const Icon = meta.icon;

  const runAction = useCallback(
    async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fn();
        if (!res.ok) setError(res.error ?? 'Action failed');
        else onResolved?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [onResolved],
  );

  const answer = useCallback(
    (answers: Record<string, string>) => void runAction(() => app.alerts.answer(alert.id, answers)),
    [alert.id, runAction],
  );
  const decide = useCallback(
    (decision: 'approve' | 'deny') =>
      void runAction(() => app.alerts.decide(alert.id, decision, note.trim() || undefined)),
    [alert.id, runAction, note],
  );
  const dismiss = useCallback(() => void runAction(() => app.alerts.dismiss(alert.id)), [alert.id, runAction]);

  return (
    <div className="rounded-xl border border-border/50 bg-card/50 p-4">
      <div className="flex items-start gap-3">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${meta.tint}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {meta.label}
            </span>
            <span className="text-[10px] text-muted-foreground/60">{new Date(alert.createdAt).toLocaleString()}</span>
          </div>
          <div className="mt-0.5 text-sm font-medium text-foreground">{alert.title}</div>
          {alert.body && <div className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{alert.body}</div>}

          {onOpenConversation && alert.conversationId && (
            <button
              type="button"
              onClick={() => onOpenConversation(alert.conversationId)}
              className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-primary/80 transition-colors hover:text-primary"
            >
              <MessageSquareIcon className="h-3 w-3" /> View conversation
            </button>
          )}

          {alert.kind === 'question' && alert.questions && alert.questions.length > 0 && !readOnly && (
            <div className="mt-3">
              <AlertQuestionPicker questions={alert.questions} onSubmit={answer} submitting={busy} />
            </div>
          )}

          {alert.kind === 'approval' && !readOnly && (
            <div className="mt-3 flex flex-col gap-2">
              {alert.approvalAction && <span className="text-xs text-muted-foreground">{alert.approvalAction}</span>}
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note to send back with your decision…"
                rows={2}
                className="w-full resize-none rounded-lg border border-border/50 bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-border"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => decide('deny')}
                  className="inline-flex items-center gap-1 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted/60 disabled:opacity-40"
                >
                  <XIcon className="h-3 w-3" /> Deny
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => decide('approve')}
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-opacity disabled:opacity-40"
                >
                  <CheckIcon className="h-3 w-3" /> Approve
                </button>
              </div>
            </div>
          )}

          {alert.kind === 'fyi' && !readOnly && (
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                disabled={busy}
                onClick={dismiss}
                className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted/60 disabled:opacity-40"
              >
                Dismiss
              </button>
            </div>
          )}

          {alert.kind !== 'fyi' && !readOnly && (
            <button
              type="button"
              disabled={busy}
              onClick={dismiss}
              className="mt-2 text-[11px] text-muted-foreground/60 underline-offset-2 hover:text-muted-foreground hover:underline disabled:opacity-40"
            >
              Dismiss without answering
            </button>
          )}

          {readOnly && STATUS_LABEL[alert.status] && (
            <div className="mt-2 text-[11px] font-medium text-muted-foreground/70">{STATUS_LABEL[alert.status]}</div>
          )}

          {error && <div className="mt-2 text-xs text-rose-500">{error}</div>}
        </div>
      </div>
    </div>
  );
};

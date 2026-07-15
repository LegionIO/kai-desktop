import { useEffect, useState, type FC } from 'react';
import { LoaderIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';

type ApprovalRequest = {
  approvalId: string;
  conversationId: string;
  toolName: string;
  args?: unknown;
};

/**
 * Renders inside the dedicated always-on-top approval window (route
 * `?approval=1`). Receives its request over `app.approval.onRequest`, answers
 * through the same agent approve/reject/answer IPC the inline card uses, then
 * closes itself. The main Kai window is never touched, so it stays behind.
 *
 * Flag-gated by `ui.approvals.dedicatedWindow`; the inline in-thread card is the
 * baseline and resolves the same pending entry, so whichever the user answers
 * first wins (the main-process resolve is idempotent).
 */
export const ApprovalShell: FC<{ approvalId: string }> = ({ approvalId }) => {
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    return app.approval.onRequest((raw) => {
      const r = raw as ApprovalRequest;
      if (r && r.approvalId === approvalId) setRequest(r);
    });
  }, [approvalId]);

  const reason =
    request?.args && typeof request.args === 'object' && !Array.isArray(request.args)
      ? (request.args as { reason?: unknown }).reason
      : undefined;
  const prompt =
    typeof reason === 'string' && reason.trim() ? reason.trim() : 'This action requires your approval to continue.';

  const resolve = async (decision: 'approve' | 'reject') => {
    if (submitting) return;
    setSubmitting(true);
    try {
      // Await the IPC so the window stays up (showing the spinner) until main has
      // actually resolved the pending approval, then close — rather than racing a
      // fixed timer against the flush.
      if (decision === 'approve') await app.agent.approveToolCall(approvalId);
      else await app.agent.rejectToolCall(approvalId);
    } catch {
      /* main-side resolve is idempotent; close regardless */
    }
    app.approval.close(approvalId);
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-card text-foreground">
      <div className="flex-1 space-y-3 p-5">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Approval required</div>
        <div className="text-sm font-medium">{request ? request.toolName : 'Loading…'}</div>
        <p className="text-sm text-muted-foreground">{prompt}</p>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border/70 p-4">
        <button
          type="button"
          disabled={submitting || !request}
          onClick={() => resolve('reject')}
          className="rounded-lg border border-border/70 bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
        >
          Reject
        </button>
        <button
          type="button"
          disabled={submitting || !request}
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

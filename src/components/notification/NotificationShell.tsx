import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FC, type ReactNode } from 'react';
import { LoaderIcon, XIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';
import type { Alert, AlertQuestion } from '@/lib/ipc-client';
import { AlertCard } from '@/components/alerts/AlertCard';
import { AlertQuestionPicker } from '@/components/alerts/AlertQuestionPicker';
import { BrowserApprovalPrivateInput } from '@/components/approval/BrowserApprovalPrivateInput';

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

const MAX_BROWSER_APPROVAL_DETAIL_CHARS = 8_192;
const MAX_BROWSER_APPROVAL_STRING_CHARS = 2_048;
const MAX_BROWSER_APPROVAL_ENTRIES = 64;
const MAX_BROWSER_APPROVAL_DEPTH = 6;

function boundedBrowserApprovalValue(
  value: unknown,
  depth: number,
  budget: { entries: number },
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string')
    return value.length > MAX_BROWSER_APPROVAL_STRING_CHARS
      ? `${value.slice(0, MAX_BROWSER_APPROVAL_STRING_CHARS)}… [truncated]`
      : value;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value !== 'object') return `[${typeof value}]`;
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_BROWSER_APPROVAL_DEPTH) return '[depth limit]';
  seen.add(value);

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let index = 0; index < value.length && budget.entries > 0; index += 1) {
      budget.entries -= 1;
      result.push(boundedBrowserApprovalValue(value[index], depth + 1, budget, seen));
    }
    if (result.length < value.length) result.push('[entry limit]');
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const key in value as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (budget.entries <= 0) {
      result['…'] = '[entry limit]';
      break;
    }
    budget.entries -= 1;
    const boundedKey = key.length > 128 ? `${key.slice(0, 128)}…` : key;
    try {
      result[boundedKey] = boundedBrowserApprovalValue(
        (value as Record<string, unknown>)[key],
        depth + 1,
        budget,
        seen,
      );
    } catch {
      result[boundedKey] = '[unavailable]';
    }
  }
  return result;
}

function browserApprovalDetails(args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  if (record.approvalKind !== 'browser-control') return null;
  const details: Record<string, unknown> = {};
  const budget = { entries: MAX_BROWSER_APPROVAL_ENTRIES };
  const seen = new WeakSet<object>([record]);
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key) || key === 'approvalKind' || key === 'reason') continue;
    if (budget.entries <= 0) {
      details['…'] = '[entry limit]';
      break;
    }
    budget.entries -= 1;
    const boundedKey = key.length > 128 ? `${key.slice(0, 128)}…` : key;
    try {
      details[boundedKey] = boundedBrowserApprovalValue(record[key], 1, budget, seen);
    } catch {
      details[boundedKey] = '[unavailable]';
    }
  }
  if (Object.keys(details).length === 0) return null;
  const serialized = JSON.stringify(details, null, 2);
  return serialized.length > MAX_BROWSER_APPROVAL_DETAIL_CHARS
    ? `${serialized.slice(0, MAX_BROWSER_APPROVAL_DETAIL_CHARS)}\n… [truncated]`
    : serialized;
}

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

export const NotificationShell: FC<{ id: string; conversationId?: string; runNonce?: string }> = ({
  id,
  conversationId,
  runNonce,
}) => {
  const [item, setItem] = useState<NotificationItem | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const off = app.notification.onRequest((raw) => {
      const it = raw as NotificationItem;
      if (it && it.id === id) setItem(it);
    });
    let cancelled = false;
    // Resolve under the run-scoped key (R193/R253): pass conversationId + runNonce so a tool-approval pop-out
    // pulls the RIGHT item even when two OVERLAPPING runs in one conversation share a raw tool-call id.
    void app.notification.get(id, conversationId, runNonce).then((raw) => {
      const it = raw as NotificationItem | null;
      if (!cancelled && it && it.id === id) setItem(it);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [id, conversationId, runNonce]);

  const close = useCallback(() => app.notification.close(id, conversationId, runNonce), [id, conversationId, runNonce]);

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
        await app.agent.answerToolQuestion(item.id, answers, item.conversationId, runNonce);
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
  const operationDetails = browserApprovalDetails(item.args);

  const resolve = async (decision: 'approve' | 'reject') => {
    if (submitting) return;
    setSubmitting(true);
    try {
      if (decision === 'approve') await app.agent.approveToolCall(item.id, item.conversationId, runNonce);
      else await app.agent.rejectToolCall(item.id, item.conversationId, runNonce);
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
        {operationDetails && (
          <section aria-label="Browser operation details" className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">Operation details</p>
            <pre
              data-testid="browser-approval-details"
              className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border/70 bg-muted/40 p-2 text-[11px] leading-relaxed text-foreground"
            >
              {operationDetails}
            </pre>
          </section>
        )}
        <BrowserApprovalPrivateInput
          approvalId={item.id}
          args={item.args}
          conversationId={item.conversationId}
          runNonce={runNonce}
        />
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

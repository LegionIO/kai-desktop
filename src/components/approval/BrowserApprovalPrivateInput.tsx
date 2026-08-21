import { useEffect, useMemo, useState, type FC } from 'react';
import { app } from '@/lib/ipc-client';

const MAX_NON_SCRIPT_DETAIL_CHARS = 32_000;

function isBrowserControlApproval(args: unknown): boolean {
  return Boolean(
    args &&
    typeof args === 'object' &&
    !Array.isArray(args) &&
    (args as { approvalKind?: unknown }).approvalKind === 'browser-control',
  );
}

function exactInputText(input: unknown): { label: string; text: string } | null {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const script = (input as { script?: unknown }).script;
    if (typeof script === 'string') return { label: 'JavaScript to run', text: script };
  }
  try {
    const serialized = JSON.stringify(input, null, 2);
    if (typeof serialized !== 'string') return null;
    return {
      label: 'Exact Browser input',
      text:
        serialized.length > MAX_NON_SCRIPT_DETAIL_CHARS
          ? `${serialized.slice(0, MAX_NON_SCRIPT_DETAIL_CHARS)}\n… [truncated]`
          : serialized,
    };
  } catch {
    return null;
  }
}

/** Shows exact AI-proposed Browser input only on an authority-checked native
 * approval surface. The stream event remains redacted, so this component must
 * fetch the transient value by approval id and immediately drop it when the
 * approval is no longer pending. */
export const BrowserApprovalPrivateInput: FC<{
  approvalId: string;
  args: unknown;
  active?: boolean;
  /** Conversation the approval belongs to. Threaded so main resolves the private details under the
   *  conversation-scoped approval key (R192); omitted only where unavailable (main falls back to raw). */
  conversationId?: string;
}> = ({ approvalId, args, active = true, conversationId }) => {
  const [input, setInput] = useState<unknown>(undefined);
  const [target, setTarget] = useState<{ tabId: string; origin: string; destinationOrigin?: string } | undefined>(
    undefined,
  );
  const browserControl = isBrowserControlApproval(args);

  useEffect(() => {
    let current = true;
    setInput(undefined);
    setTarget(undefined);
    if (!active || !browserControl)
      return () => {
        current = false;
      };
    const getPrivateDetails = app.agent.getToolApprovalPrivateDetails;
    if (!getPrivateDetails)
      return () => {
        current = false;
      };
    void getPrivateDetails(approvalId, conversationId)
      .then((details) => {
        if (current && details && Object.prototype.hasOwnProperty.call(details, 'browserInput')) {
          setInput(details.browserInput);
          setTarget(details.browserTarget);
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [active, approvalId, browserControl, conversationId]);

  const display = useMemo(() => exactInputText(input), [input]);
  if (!active || (!display && !target)) return null;

  return (
    <section aria-label={display?.label ?? 'Exact Browser target'} className="space-y-1.5">
      {target && (
        <>
          <p className="text-xs font-medium text-foreground">Exact Browser target</p>
          <pre
            data-testid="browser-private-approval-target"
            className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] leading-relaxed text-foreground"
          >
            {JSON.stringify(target, null, 2)}
          </pre>
        </>
      )}
      {display && (
        <>
          <p className="text-xs font-medium text-foreground">{display.label}</p>
          <pre
            data-testid="browser-private-approval-input"
            className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] leading-relaxed text-foreground"
          >
            {display.text}
          </pre>
        </>
      )}
      <p className="text-[10px] text-muted-foreground">
        Shown only in this trusted Kai approval UI; chat history keeps it redacted.
      </p>
    </section>
  );
};

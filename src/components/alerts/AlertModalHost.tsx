import { useEffect, useRef, useState, type FC } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';
import type { Alert, AlertsChangedPayload } from '@/lib/ipc-client';
import { useConfig } from '@/providers/ConfigProvider';
import { useSubAgents } from '@/providers/RuntimeProvider';
import type { ThreadMode } from '@/components/thread/Thread';
import { AlertCard } from './AlertCard';

type AutomationsShape = {
  alertSurface?: 'off' | 'modal' | 'window';
  surfaceAlertsAsModal?: boolean;
  surfaceAlertsAsWindow?: boolean;
};

/**
 * When `automations.surfaceAlertsAsModal` is on, a newly-created question/
 * approval alert pops a front-most, focused modal for immediate action. Also
 * asks the main process to raise + focus the window so a background automation
 * alert is instantly visible. When the setting is off this renders nothing
 * (the OS notification + Alerts tab badge are the only surfacing).
 *
 * Presence suppression: the main process sets `suppressSurface` when the GUI is
 * focused, but a modal should only be suppressed when the alert is ALREADY
 * visible inline. That's true in exactly two cases:
 *   1. The Alerts view is open — AlertsView renders the same actionable card, so
 *      a modal would duplicate it and steal focus on the dedicated screen.
 *   2. The alert's originating conversation transcript is actually on screen:
 *      the chat view is active for that conversation, in 'chat' thread mode
 *      (NOT the Computer tab, which hides the transcript), and no sub-agent view
 *      is overlaid.
 * Any other focused surface (Settings, a different conversation, computer mode,
 * a sub-agent) does NOT show the inline card, so the modal must still open.
 */
export const AlertModalHost: FC<{
  /** The conversation currently open in the renderer (null if none). */
  activeConversationId?: string | null;
  /** True when the chat view is the active app view (may still be computer mode). */
  chatViewActive?: boolean;
  /** Current thread mode; only 'chat' renders the message transcript inline card. */
  threadMode?: ThreadMode;
  /** True when the dedicated Alerts view is the active app view. */
  alertsViewActive?: boolean;
}> = ({ activeConversationId = null, chatViewActive = false, threadMode = 'chat', alertsViewActive = false }) => {
  const { config } = useConfig();
  const { activeSubAgentView } = useSubAgents();
  const automations = (config as { automations?: AutomationsShape } | null)?.automations;
  // In-app modal only when the (mutually-exclusive) surface resolves to 'modal'.
  const surface =
    automations?.alertSurface ??
    (automations?.surfaceAlertsAsWindow ? 'window' : automations?.surfaceAlertsAsModal ? 'modal' : 'off');
  const enabled = surface === 'modal';
  const [alert, setAlert] = useState<Alert | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  // Keep the live view state in refs so the (mount-once) onChanged handler reads
  // the CURRENT value rather than the value captured at subscription time.
  const activeConvRef = useRef(activeConversationId);
  activeConvRef.current = activeConversationId;
  const chatViewActiveRef = useRef(chatViewActive);
  chatViewActiveRef.current = chatViewActive;
  const threadModeRef = useRef(threadMode);
  threadModeRef.current = threadMode;
  const alertsViewActiveRef = useRef(alertsViewActive);
  alertsViewActiveRef.current = alertsViewActive;
  const subAgentRef = useRef(activeSubAgentView);
  subAgentRef.current = activeSubAgentView;

  useEffect(() => {
    const off = app.alerts.onChanged((payload: AlertsChangedPayload) => {
      if (!enabledRef.current) return;
      if (payload.reason !== 'created' || !payload.alert) return;
      if (payload.alert.kind === 'fyi') return; // fyi never steals focus
      // Suppress the modal only when the alert is already visible inline (see
      // the component doc). The main process's suppressSurface is a necessary
      // precondition (GUI focused) but not sufficient on its own.
      const onAlertsView = alertsViewActiveRef.current;
      const transcriptVisible =
        chatViewActiveRef.current &&
        threadModeRef.current === 'chat' &&
        !subAgentRef.current &&
        !!payload.alert.conversationId &&
        activeConvRef.current === payload.alert.conversationId;
      if (payload.suppressSurface && (onAlertsView || transcriptVisible)) return;
      setAlert(payload.alert);
      // The main process already raises + focuses the window (alerts.ts
      // surfaceAsModal path); the renderer just opens the in-app modal.
    });
    return off;
  }, []);

  if (!enabled || !alert) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setAlert(null)} />
      <div className="relative w-full max-w-lg rounded-2xl border border-border/50 bg-popover/95 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">Needs your input</h2>
          <button
            type="button"
            onClick={() => setAlert(null)}
            className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4">
          <AlertCard alert={alert} onResolved={() => setAlert(null)} />
        </div>
      </div>
    </div>,
    document.body,
  );
};

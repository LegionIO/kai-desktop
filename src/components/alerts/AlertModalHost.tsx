import { useEffect, useRef, useState, type FC } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';
import type { Alert, AlertsChangedPayload } from '@/lib/ipc-client';
import { useConfig } from '@/providers/ConfigProvider';
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
 */
export const AlertModalHost: FC<{
  /** The conversation currently open in the renderer (null if none). */
  activeConversationId?: string | null;
  /** True when the chat surface (not Settings/Alerts/a plugin panel) is showing. */
  chatVisible?: boolean;
}> = ({ activeConversationId = null, chatVisible = false }) => {
  const { config } = useConfig();
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
  const chatVisibleRef = useRef(chatVisible);
  chatVisibleRef.current = chatVisible;

  useEffect(() => {
    const off = app.alerts.onChanged((payload: AlertsChangedPayload) => {
      if (!enabledRef.current) return;
      if (payload.reason !== 'created' || !payload.alert) return;
      if (payload.alert.kind === 'fyi') return; // fyi never steals focus
      // Presence-based suppression, but ONLY when the alert's inline card is
      // actually on screen. The main process sets suppressSurface when the GUI
      // is focused — but focus on Settings, the Alerts tab, or a DIFFERENT
      // conversation means the originating thread's inline card is NOT visible,
      // so the modal is the only surface and must still show. Suppress only when
      // the alert's own conversation is the one currently displayed.
      const inlineVisible =
        chatVisibleRef.current &&
        !!payload.alert.conversationId &&
        activeConvRef.current === payload.alert.conversationId;
      if (payload.suppressSurface && inlineVisible) return;
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

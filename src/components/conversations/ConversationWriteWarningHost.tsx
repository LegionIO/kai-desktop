import { useEffect, useState, type FC } from 'react';
import { AlertTriangleIcon, XIcon } from 'lucide-react';
import { CONVERSATION_WRITE_WARNING_EVENT, type ConversationWriteWarningDetail } from '@/lib/conversation-writes';

export const ConversationWriteWarningHost: FC = () => {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const handleWarning = (event: Event) => {
      const detail = (event as CustomEvent<ConversationWriteWarningDetail>).detail;
      if (detail?.message) setMessage(detail.message);
    };
    window.addEventListener(CONVERSATION_WRITE_WARNING_EVENT, handleWarning);
    return () => window.removeEventListener(CONVERSATION_WRITE_WARNING_EVENT, handleWarning);
  }, []);

  if (!message) return null;
  return (
    <div
      role="alert"
      className="fixed bottom-20 right-5 z-[10000] flex max-w-md items-start gap-2 rounded-xl border border-amber-500/40 bg-popover px-3 py-2.5 text-xs text-foreground shadow-xl"
    >
      <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <p className="min-w-0 flex-1">{message}</p>
      <button
        type="button"
        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Dismiss chat save warning"
        onClick={() => setMessage(null)}
      >
        <XIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};

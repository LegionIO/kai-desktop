import { useEffect, useState, type FC } from 'react';
import { AlertTriangleIcon, XIcon } from 'lucide-react';
import {
  CONVERSATION_CLEANUP_WARNING_EVENT,
  type ConversationCleanupWarningDetail,
} from '@/lib/conversation-delete-warnings';

export const ConversationCleanupWarningHost: FC = () => {
  const [failedBrowserScopeKeys, setFailedBrowserScopeKeys] = useState<string[]>([]);

  useEffect(() => {
    const handleWarning = (event: Event) => {
      const detail = (event as CustomEvent<ConversationCleanupWarningDetail>).detail;
      setFailedBrowserScopeKeys((current) => [...new Set([...current, ...(detail?.browserScopeKeys ?? [])])]);
    };
    window.addEventListener(CONVERSATION_CLEANUP_WARNING_EVENT, handleWarning);
    return () => window.removeEventListener(CONVERSATION_CLEANUP_WARNING_EVENT, handleWarning);
  }, []);

  useEffect(() => {
    const browser = window.app?.browser;
    if (!browser) return;
    return browser.onEvent((event) => {
      if (event.type !== 'profile-data-cleared' || event.scopeKeys.length === 0) return;
      const cleared = new Set(event.scopeKeys);
      setFailedBrowserScopeKeys((current) => current.filter((scopeKey) => !cleared.has(scopeKey)));
    });
  }, []);

  if (failedBrowserScopeKeys.length === 0) return null;
  const multiple = failedBrowserScopeKeys.length > 1;
  return (
    <div
      role="alert"
      className="fixed bottom-5 right-5 z-[10000] flex max-h-[calc(100vh-2.5rem)] max-w-md items-start gap-2 overflow-hidden rounded-xl border border-amber-500/40 bg-popover px-3 py-2.5 text-xs text-foreground shadow-xl"
    >
      <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <div className="min-h-0 min-w-0 flex-1">
        <p>
          {multiple ? `${failedBrowserScopeKeys.length} chats were` : 'The chat was'} deleted, but Kai could not clear
          {multiple ? ' their' : ' its'} conversation-scoped browser data. Clear the matching profile
          {multiple ? 's' : ''} in Settings → Browser Data:
        </p>
        <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto pr-1">
          {failedBrowserScopeKeys.map((scopeKey) => (
            <code key={scopeKey} className="block break-all font-mono text-[10px] text-amber-600 dark:text-amber-400">
              {scopeKey}
            </code>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Dismiss browser cleanup warning"
        onClick={() => setFailedBrowserScopeKeys([])}
      >
        <XIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};
